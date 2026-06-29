// Atlas Voice Agent — Telnyx + Deepgram + Gemini 2.5 Flash TTS
const WebSocket = require("ws");
const { DeepgramClient } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const { runAgent } = require("./agent");

// Active call sessions: callControlId → session
const sessions = new Map();

// ── Telnyx webhook handler ────────────────────────────────────────────────────

async function handleTelnyxWebhook(req, res) {
  res.sendStatus(200); // Acknowledge before async processing

  const { event_type, payload } = req.body?.data || {};
  if (!event_type || !payload) return;

  console.log(`[Voice] ${event_type} — ${payload.from || payload.call_control_id}`);

  try {
    if (event_type === "call.initiated" && payload.direction === "incoming") {
      await onCallInitiated(payload);
    } else if (event_type === "call.answered") {
      await onCallAnswered(payload);
    } else if (event_type === "call.hangup") {
      await onCallHangup(payload);
    }
  } catch (err) {
    console.error(`[Voice] Error in ${event_type}:`, err.message);
  }
}

async function onCallInitiated({ call_control_id, from }) {
  const isOwner = normalizePhone(from) === normalizePhone(process.env.OWNER_PHONE_NUMBER);
  sessions.set(call_control_id, {
    callControlId: call_control_id,
    callerNumber: from,
    userId: `phone:${normalizePhone(from)}`,
    isOwner,
    log: [],
    ws: null,
    deepgramLive: null,
    busy: false,
  });
  await telnyxAction(call_control_id, "answer", {});
}

async function onCallAnswered({ call_control_id }) {
  const renderUrl = process.env.RENDER_URL || "https://localhost:3000";
  const wsUrl = renderUrl.replace(/^https?:\/\//, "wss://") + "/media-stream";
  await telnyxAction(call_control_id, "streaming_start", {
    stream_url: wsUrl,
    stream_track: "both_tracks",
  });
}

async function onCallHangup({ call_control_id }) {
  const session = sessions.get(call_control_id);
  if (!session) return;

  // Notify owner when a non-owner caller leaves a message
  if (!session.isOwner && session.log.length > 1) {
    notifyOwner(session).catch((err) =>
      console.error("[Voice] Telegram notify error:", err.message)
    );
  }

  closeSession(call_control_id);
}

function closeSession(callControlId) {
  const session = sessions.get(callControlId);
  if (!session) return;
  if (session.deepgramLive) {
    try { session.deepgramLive.socket.close(); } catch {}
  }
  sessions.delete(callControlId);
  console.log(`[Voice] Session closed: ${callControlId}`);
}

// ── WebSocket media stream ────────────────────────────────────────────────────

function handleMediaWebSocket(ws) {
  let callControlId = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      callControlId = msg.start?.call_control_id;
      if (!callControlId) return;

      const session = sessions.get(callControlId);
      if (!session) {
        console.warn(`[Voice] No session for ${callControlId}`);
        return;
      }

      session.ws = ws;
      session.deepgramLive = await createDeepgramStream(callControlId);

      const greeting = session.isOwner
        ? "Hey, what's up?"
        : "Hi, this is Atlas, Erik's assistant. He's unavailable right now — can I take a message?";

      session.log.push({ role: "atlas", text: greeting });
      await speakToCall(session, greeting);
      return;
    }

    if (msg.event === "media") {
      const session = callControlId ? sessions.get(callControlId) : null;
      if (!session?.deepgramLive) return;
      const audio = Buffer.from(msg.media.payload, "base64");
      try { session.deepgramLive.socket.send(audio); } catch {}
      return;
    }

    if (msg.event === "stop") {
      if (callControlId) closeSession(callControlId);
    }
  });

  ws.on("close", () => {
    if (callControlId) closeSession(callControlId);
  });

  ws.on("error", (err) => console.error("[Voice] WS error:", err.message));
}

// ── Deepgram streaming STT ────────────────────────────────────────────────────

async function createDeepgramStream(callControlId) {
  const client = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

  const connection = await client.listen.v1.connect({
    model: "nova-2",
    language: "en-US",
    encoding: "mulaw",
    sample_rate: 8000,
    endpointing: 700,         // ms of silence → end of utterance
    interim_results: false,
    smart_format: true,
  });

  connection.on("open", () => {
    console.log(`[Voice] Deepgram open for ${callControlId}`);
  });

  connection.on("message", async (data) => {
    if (data.type !== "Results") return;
    if (!data.is_final) return;
    const text = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;

    const session = sessions.get(callControlId);
    if (!session || session.busy) return;

    console.log(`[Voice] Heard: "${text}"`);
    session.log.push({ role: "caller", text });
    session.busy = true;

    try {
      const reply = await getAgentReply(session, text);
      if (reply) {
        session.log.push({ role: "atlas", text: reply });
        await speakToCall(session, reply);
      }
    } catch (err) {
      console.error("[Voice] Agent error:", err.message);
      await speakToCall(session, "Sorry, I had a problem. Could you repeat that?");
    } finally {
      session.busy = false;
    }
  });

  connection.on("error", (err) => {
    console.error("[Voice] Deepgram error:", err.message || err);
  });

  connection.connect();
  await connection.waitForOpen();

  return connection;
}

// ── Agent routing ─────────────────────────────────────────────────────────────

async function getAgentReply(session, text) {
  if (session.isOwner) {
    // Full agent — all tools, memory, everything
    return await runAgent(session.userId, text, async () => {});
  }
  return await messageTakingReply(session, text);
}

async function messageTakingReply(session, text) {
  const history = session.log
    .map((e) => `${e.role === "caller" ? "Caller" : "Atlas"}: ${e.text}`)
    .join("\n");

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash",
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: `You are Atlas, Erik's phone assistant. Erik is unavailable.
Your only job: politely collect the caller's name, their message for Erik, and a callback number if they want one.
Once you have the essentials, tell them you'll pass it to Erik and say a warm goodbye.
Keep replies to 1-2 short sentences. Natural conversational tone, no filler.`,
        },
        {
          role: "user",
          content: `Conversation so far:\n${history}\n\nCaller just said: "${text}"\nAtlas:`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  return res.data.choices?.[0]?.message?.content?.trim() || "Got it. I'll let Erik know.";
}

// ── Gemini 2.5 Flash TTS ──────────────────────────────────────────────────────
// Returns mulaw 8kHz audio buffer ready for Telnyx

async function textToSpeech(text) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  // Model name may need adjusting once key is in place — check Google AI Studio
  // for exact name: "gemini-2.5-flash-preview-tts" or "gemini-2.5-flash"
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-preview-tts",
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
    },
  });

  const result = await model.generateContent(text);
  const part = result.response.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) throw new Error("No audio in Gemini TTS response");

  // Gemini returns PCM16 at 24kHz → convert to mulaw 8kHz for Telnyx
  const pcm = Buffer.from(part.inlineData.data, "base64");
  return pcm16ToMulaw(pcm, 24000, 8000);
}

// Downsample PCM16 from srcRate to dstRate, encode as G.711 mulaw
function pcm16ToMulaw(pcmBuffer, srcRate, dstRate) {
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = encodeMulaw(samples[Math.floor(i * ratio)]);
  }
  return out;
}

function encodeMulaw(s) {
  const BIAS = 33, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; !(s & mask) && exp > 0; mask >>= 1) exp--;
  return (~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f))) & 0xff;
}

// ── Send audio to caller via WebSocket ───────────────────────────────────────

async function speakToCall(session, text) {
  if (!text?.trim()) return;
  const { ws } = session;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const audio = await textToSpeech(text);
    // 20ms frames at 8kHz mulaw = 160 bytes per frame
    const CHUNK = 160;
    for (let i = 0; i < audio.length; i += CHUNK) {
      ws.send(JSON.stringify({
        event: "media",
        media: { payload: audio.slice(i, i + CHUNK).toString("base64") },
      }));
    }
    ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_done" } }));
  } catch (err) {
    console.error("[Voice] TTS/send error:", err.message);
  }
}

// ── Telegram notification for missed messages ─────────────────────────────────

async function notifyOwner(session) {
  const summary = session.log
    .map((e) => `${e.role === "caller" ? "Caller" : "Atlas"}: ${e.text}`)
    .join("\n");

  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: process.env.TELEGRAM_USER_ID,
      text: `📞 Missed call from ${session.callerNumber}\n\n${summary}`,
    }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(num) {
  return (num || "").replace(/\D/g, "");
}

async function telnyxAction(callControlId, action, params) {
  await axios.post(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`,
    params,
    {
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    }
  );
}

module.exports = { handleTelnyxWebhook, handleMediaWebSocket };
