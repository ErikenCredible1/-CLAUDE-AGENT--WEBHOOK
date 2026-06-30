// Atlas Voice Agent — Telnyx + Deepgram + Gemini 2.5 Flash TTS
const crypto = require("crypto");
const WebSocket = require("ws");
const { DeepgramClient } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const { runAgent } = require("./agent");

// Active call sessions: callControlId → session
const sessions = new Map();

// In-memory TTS audio cache: id → WAV buffer (served via /tts-audio/:id)
const ttsCache = new Map();

// ── Telnyx webhook handler ────────────────────────────────────────────────────

async function handleTelnyxWebhook(req, res) {
  res.sendStatus(200); // Acknowledge before async processing

  // Log raw body so we can diagnose unexpected webhook formats
  const raw = req.body;
  const { event_type, payload } = raw?.data || {};
  if (!event_type || !payload) {
    console.log("[Voice] Unrecognised webhook body:", JSON.stringify(raw).slice(0, 300));
    return;
  }

  console.log(`[Voice] ${event_type} — ${payload.from || payload.call_control_id}`);

  try {
    if (event_type === "call.initiated" && payload.direction === "incoming") {
      await onCallInitiated(payload);
    } else if (event_type === "call.answered") {
      await onCallAnswered(payload);
    } else if (event_type === "call.playback.ended") {
      await onPlaybackEnded(payload);
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
    greeted: false,
  });
  // Explicitly pin the webhook URL so all subsequent events (call.answered, etc.)
  // come back to us regardless of what is set in the Telnyx portal.
  const webhookUrl = `${process.env.RENDER_URL}/voice-call`;
  await telnyxAction(call_control_id, "answer", {
    webhook_url: webhookUrl,
    webhook_url_method: "POST",
  });
}

async function onCallAnswered({ call_control_id }) {
  const renderUrl = process.env.RENDER_URL || "https://localhost:3000";
  const wsUrl = renderUrl.replace(/^https?:\/\//, "wss://") + "/media-stream";
  await telnyxAction(call_control_id, "streaming_start", {
    stream_url: wsUrl,
    stream_track: "inbound_track",
  });
}

async function onPlaybackEnded({ call_control_id }) {
  const session = sessions.get(call_control_id);
  if (!session) return;
  // Restart listening after we finished speaking
  const renderUrl = process.env.RENDER_URL || "https://localhost:3000";
  const wsUrl = renderUrl.replace(/^https?:\/\//, "wss://") + "/media-stream";
  await telnyxAction(call_control_id, "streaming_start", {
    stream_url: wsUrl,
    stream_track: "inbound_track",
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

      // Close any previous Deepgram connection (streaming restart after playback)
      if (session.deepgramLive) {
        try { session.deepgramLive.socket.close(); } catch {}
      }
      session.ws = ws;
      session.deepgramLive = await createDeepgramStream(callControlId);

      if (!session.greeted) {
        session.greeted = true;
        const greeting = session.isOwner
          ? "Hey, what's up?"
          : "Hi, this is Atlas, Erik's assistant. He's unavailable right now — can I take a message?";
        session.log.push({ role: "atlas", text: greeting });
        await speakToCall(session, greeting);
      }
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
      // Streaming stopped (either for playback or hangup) — don't close session,
      // call.hangup webhook handles that. Just clean up Deepgram for this stream.
      const session = callControlId ? sessions.get(callControlId) : null;
      if (session?.deepgramLive) {
        try { session.deepgramLive.socket.close(); } catch {}
        session.deepgramLive = null;
      }
    }
  });

  ws.on("close", () => {
    // WebSocket closed — Deepgram already cleaned up in "stop" event above
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
    endpointing: 500,         // ms of silence → end of utterance
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
// Returns a WAV buffer (PCM16 8kHz mono) for Telnyx playback_start

async function textToSpeech(text) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-tts" });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: `Say the following out loud: ${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
    },
  });

  const part = result.response.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) throw new Error("No audio in Gemini TTS response");

  // Gemini returns L16 big-endian PCM at 24kHz.
  // Swap BE→LE, decimate 3:1 to 8kHz, wrap in PCM16 WAV (format 1).
  // Telnyx supports PCM WAV only — not mulaw.
  const raw = Buffer.from(part.inlineData.data, "base64");
  const pcmLe24k = swapBytes(raw);
  const pcmLe8k = decimate(pcmLe24k, 3);
  return buildPcmWav(pcmLe8k, 8000);
}

function swapBytes(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length - 1; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

function decimate(pcmLe, factor) {
  const outSamples = Math.floor(pcmLe.length / 2 / factor);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    out.writeInt16LE(pcmLe.readInt16LE(i * factor * 2), i * 2);
  }
  return out;
}

function buildPcmWav(pcmLe, sampleRate) {
  const byteRate = sampleRate * 2; // 16-bit mono
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLe.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);          // blockAlign = 2 bytes per sample
  header.writeUInt16LE(16, 34);         // 16 bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmLe.length, 40);
  return Buffer.concat([header, pcmLe]);
}

function encodeMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; !(sample & mask) && exp > 0; mask >>= 1) exp--;
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

// ── Serve TTS audio and play via Telnyx ──────────────────────────────────────

async function speakToCall(session, text) {
  if (!text?.trim()) return;
  console.log(`[Voice] Speaking: "${text.slice(0, 60)}"`);

  // Stop streaming before playback — they can't run simultaneously on Telnyx
  await telnyxAction(session.callControlId, "streaming_stop", {}).catch(() => {});

  try {
    const wav = await textToSpeech(text);
    const id = crypto.randomUUID();
    ttsCache.set(id, wav);
    setTimeout(() => ttsCache.delete(id), 60_000);

    const audioUrl = `${process.env.RENDER_URL}/tts-audio/${id}.wav`;
    console.log(`[Voice] WAV size=${wav.length} url=${audioUrl}`);
    await telnyxAction(session.callControlId, "playback_start", {
      audio_url: audioUrl,
    });
    console.log(`[Voice] Gemini TTS playing: ${id}`);
  } catch (err) {
    console.error("[Voice] Gemini TTS failed, falling back to Telnyx speak:", err?.message || err);
    await telnyxAction(session.callControlId, "speak", {
      payload: text,
      payload_type: "text",
      voice: "female",
      language: "en-US",
    }).catch((e) => console.error("[Voice] Telnyx speak error:", e.message));
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
  try {
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
    console.log(`[Telnyx] ${action} OK`);
  } catch (err) {
    const body = err.response?.data;
    console.error(`[Telnyx] ${action} failed ${err.response?.status}:`, JSON.stringify(body).slice(0, 400));
    throw err;
  }
}

module.exports = { handleTelnyxWebhook, handleMediaWebSocket, ttsCache };
