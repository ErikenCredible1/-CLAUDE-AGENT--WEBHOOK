require("dotenv").config();
const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { runAgent, runAgentWithImage } = require("./agent");
const { createSchedule, listSchedules, deleteSchedule, parseScheduleRequest } = require("./scheduler");
const { checkPriceAlerts } = require("./alerts");

const WORK_DIR = path.join(__dirname, "../workspace");
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new Client(lineConfig);

// ── LINE webhook ──────────────────────────────────────────────────────────────
app.post("/webhook", middleware(lineConfig), (req, res) => {
  res.status(200).end();
  req.body.events.forEach((event) => {
    if (event.type === "message") {
      handleEvent(event).catch((err) => console.error("Unhandled event error:", err));
    }
  });
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const msgType = event.message.type;

  // ── Image message ───────────────────────────────────────────────────────────
  if (msgType === "image") {
    await send(userId, "🖼️ Got your image, analysing...");
    try {
      const imageBuffer = await downloadContent(event.message.id);
      const result = await runAgentWithImage(userId, imageBuffer, null, async (p) => {
        await send(userId, `🔧 ${p}`);
      });
      await send(userId, `✅ Done!\n\n${result}`);
    } catch (err) {
      await send(userId, `❌ Error analysing image: ${err.message}`);
    }
    return;
  }

  // ── File message (PDF, Word, etc.) ──────────────────────────────────────────
  if (msgType === "file") {
    const filename = event.message.fileName;
    await send(userId, `📄 Got "${filename}", saving to workspace...`);
    try {
      const buffer = await downloadContent(event.message.id);
      const safeName = path.basename(filename);
      fs.writeFileSync(path.join(WORK_DIR, safeName), buffer);
      await send(userId, `✅ Saved! You can now say things like:\n"Summarise ${safeName}"\n"Extract key points from ${safeName}"`);
    } catch (err) {
      await send(userId, `❌ Error saving file: ${err.message}`);
    }
    return;
  }

  // ── Text message ────────────────────────────────────────────────────────────
  if (msgType !== "text") return;
  const text = event.message.text.trim();

  // Schedule commands
  if (/^(list schedules?|my schedules?)$/i.test(text)) {
    const schedules = await listSchedules(userId);
    if (!schedules.length) return send(userId, "📭 You have no active schedules.");
    const lines = schedules.map((s, i) => `${i + 1}. ${s.label}\n   ⏰ ${s.cron}\n   📝 ${s.taskPrompt}`);
    return send(userId, `📅 Your schedules:\n\n${lines.join("\n\n")}`);
  }

  const deleteMatch = text.match(/^delete schedule (.+)$/i);
  if (deleteMatch) {
    const deleted = await deleteSchedule(userId, deleteMatch[1]);
    return send(userId, deleted
      ? `🗑️ Deleted: "${deleteMatch[1]}"`
      : `❌ No schedule found with that name.`
    );
  }

  const scheduleMatch = text.match(
    /^(every .+?) (remind me to|check|summarise|summarize|send|do|search|get|fetch|tell me|look up) (.+)$/i
  );
  if (scheduleMatch) {
    const timing = scheduleMatch[1];
    const taskPrompt = scheduleMatch[2] + " " + scheduleMatch[3];
    const parsed = parseScheduleRequest(timing);
    if (parsed) {
      await send(userId, `⏳ Setting up schedule...`);
      try {
        await createSchedule(userId, taskPrompt, parsed.cron, parsed.label);
        return send(userId, `✅ Schedule created!\n\n📅 ${parsed.label}\n⏰ ${timing}\n📝 ${taskPrompt}`);
      } catch (err) {
        return send(userId, `❌ Failed: ${err.message}`);
      }
    }
  }

  // Regular agent message
  try {
    await send(userId, "⏳ Working on it...");
    const result = await runAgent(userId, text, async (p) => {
      await send(userId, `🔧 ${p}`).catch(() => {});
    });
    await send(userId, `✅ Done!\n\n${result}`);
  } catch (err) {
    console.error("Agent error:", err);
    await send(userId, `❌ Something went wrong:\n${err.message}`).catch(() => {});
  }
}

// ── QStash scheduled task endpoint ───────────────────────────────────────────
app.post("/scheduled", express.json(), async (req, res) => {
  if (req.headers["x-scheduled-secret"] !== process.env.SCHEDULED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.status(200).json({ ok: true });

  const { userId, taskPrompt, label } = req.body;
  try {
    await send(userId, `⏰ Running: ${label}\n⏳ Working on it...`);
    const result = await runAgent(userId, taskPrompt, async (p) => {
      await send(userId, `🔧 ${p}`);
    });
    await send(userId, `✅ ${label} complete!\n\n${result}`);
  } catch (err) {
    await send(userId, `❌ Scheduled task "${label}" failed:\n${err.message}`);
  }
});

// ── Google auth test endpoint ─────────────────────────────────────────────────
app.get("/google-test", async (req, res) => {
  const { getAuth, getDrive, getCalendar, getSheets, getGmail } = require("./google");
  const results = {};

  // Check env vars
  results.env = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "✅ set" : "❌ missing",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "✅ set" : "❌ missing",
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? "✅ set" : "❌ missing",
  };

  // Test token refresh
  try {
    const auth = getAuth();
    const tokenRes = await auth.getAccessToken();
    results.token = tokenRes.token ? "✅ access token obtained" : "❌ no token returned";
  } catch (err) {
    results.token = `❌ ${err.message}`;
  }

  // Test Drive
  try {
    const drive = getDrive();
    await drive.files.list({ pageSize: 1, fields: "files(id)" });
    results.drive = "✅ Drive OK";
  } catch (err) {
    results.drive = `❌ ${err.message}`;
  }

  // Test Gmail
  try {
    const gmail = getGmail();
    await gmail.users.getProfile({ userId: "me" });
    results.gmail = "✅ Gmail OK";
  } catch (err) {
    results.gmail = `❌ ${err.message}`;
  }

  // Test Calendar
  try {
    const calendar = getCalendar();
    await calendar.calendarList.list({ maxResults: 1 });
    results.calendar = "✅ Calendar OK";
  } catch (err) {
    results.calendar = `❌ ${err.message}`;
  }

  // Test Sheets
  try {
    const sheets = getSheets();
    // Just init the client — no good "ping" endpoint, so we try a known-bad spreadsheet
    // and check that the error is NOT an auth error
    await sheets.spreadsheets.get({ spreadsheetId: "test" }).catch((err) => {
      if (err.code === 401 || err.code === 403) throw err;
      // 404 means auth worked fine, sheet just doesn't exist
    });
    results.sheets = "✅ Sheets OK";
  } catch (err) {
    results.sheets = `❌ ${err.message}`;
  }

  res.json(results);
});

// ── Price alert check endpoint (called by QStash every 5 min) ────────────────
app.post("/check-alerts", express.json(), async (req, res) => {
  if (req.headers["x-scheduled-secret"] !== process.env.SCHEDULED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.status(200).json({ ok: true });
  await checkPriceAlerts(send);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function downloadContent(messageId) {
  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    }
  );
  return Buffer.from(res.data);
}

function send(userId, text) {
  const MAX_LENGTH = 4500; // safe buffer below LINE's 5000 char limit

  if (text.length <= MAX_LENGTH) {
    return lineClient.pushMessage(userId, { type: "text", text });
  }

  // Split into chunks at newlines where possible
  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > MAX_LENGTH) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Send chunks sequentially with part numbers if more than one
  return chunks.reduce((promise, chunk, i) => {
    return promise.then(() =>
      lineClient.pushMessage(userId, {
        type: "text",
        text: chunks.length > 1 ? `(${i + 1}/${chunks.length})\n\n${chunk}` : chunk,
      })
    );
  }, Promise.resolve());
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LINE agent running on port ${PORT}`));
