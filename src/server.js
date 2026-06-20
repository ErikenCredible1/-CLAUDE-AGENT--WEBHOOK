require("dotenv").config();
const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { runAgent, runAgentWithImage, refreshToolRegistry } = require("./agent");
const { createSchedule, listSchedules, deleteSchedule, parseScheduleRequest } = require("./scheduler");
const { checkPriceAlerts } = require("./alerts");
const { startMcpServers } = require("./mcp-tools");

const WORK_DIR = path.join(__dirname, "../workspace");
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10);

// Only respond to the configured user
bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) return;
  return next();
});

// ── Image message ─────────────────────────────────────────────────────────────
bot.on("photo", (ctx) => {
  const userId = String(ctx.chat.id);
  send(userId, "🖼️ Got your image, analysing...").catch(() => {});
  (async () => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileInfo = await bot.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(res.data);
    const caption = ctx.message.caption || null;
    const result = await runAgentWithImage(userId, imageBuffer, caption, async (p) => {
      await send(userId, `🔧 ${p}`).catch(() => {});
    });
    await send(userId, `✅ Done!\n\n${result}`);
  })().catch((err) => {
    send(userId, `❌ Error analysing image: ${err.message}`).catch(() => {});
  });
});

// ── File/document message ─────────────────────────────────────────────────────
bot.on("document", async (ctx) => {
  const userId = String(ctx.chat.id);
  const filename = ctx.message.document.file_name;
  await send(userId, `📄 Got "${filename}", saving to workspace...`);
  try {
    const fileInfo = await bot.telegram.getFile(ctx.message.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    const safeName = path.basename(filename);
    fs.writeFileSync(path.join(WORK_DIR, safeName), buffer);

    let driveNote = "";
    try {
      const { executeGoogleTool } = require("./google-tools");
      const driveResult = await executeGoogleTool("upload_to_drive", { filename: safeName });
      const linkMatch = driveResult.match(/https:\/\/[^\s]+/);
      if (linkMatch) driveNote = `\n📁 Also saved to Drive: ${linkMatch[0]}`;
    } catch (err) {
      console.warn("Could not auto-save uploaded file to Drive:", err.message);
    }

    await send(userId, `✅ Saved! You can now say:\n"Summarise ${safeName}"\n"Extract key points from ${safeName}"${driveNote}`);
  } catch (err) {
    await send(userId, `❌ Error saving file: ${err.message}`).catch(() => {});
  }
});

// ── Text message ──────────────────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const userId = String(ctx.chat.id);
  const text = ctx.message.text.trim();

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

  // Regular agent message — fire and forget so Telegraf responds 200 immediately
  // (awaiting here causes a 90s timeout → crash → Telegram retry loop)
  send(userId, "⏳ Working on it...").catch(() => {});
  runAgent(userId, text, async (p) => {
    await send(userId, `🔧 ${p}`).catch(() => {});
  }).then((result) => {
    send(userId, `✅ Done!\n\n${result}`).catch(() => {});
  }).catch((err) => {
    console.error("Agent error:", err);
    send(userId, `❌ Something went wrong:\n${err.message}`).catch(() => {});
  });
});

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
      await send(userId, `🔧 ${p}`).catch(() => {});
    });
    await send(userId, `✅ ${label} complete!\n\n${result}`);
  } catch (err) {
    await send(userId, `❌ Scheduled task "${label}" failed:\n${err.message}`).catch(() => {});
  }
});

// ── QStash test endpoint ──────────────────────────────────────────────────────
app.get("/qstash-test", async (req, res) => {
  const { Client } = require("@upstash/qstash");
  const results = {};
  results.env = {
    QSTASH_TOKEN: process.env.QSTASH_TOKEN ? "✅ set" : "❌ missing",
    RENDER_URL: process.env.RENDER_URL || "❌ missing",
  };
  try {
    const q = new Client({ token: process.env.QSTASH_TOKEN, baseUrl: process.env.QSTASH_URL });
    const schedules = await q.schedules.list();
    results.connection = "✅ QStash connected";
    results.scheduleCount = schedules.length;
  } catch (err) {
    results.connection = `❌ ${err.message}`;
  }
  res.json(results);
});

// ── Google auth test endpoint ─────────────────────────────────────────────────
app.get("/google-test", async (req, res) => {
  const { getAuth, getDrive, getCalendar, getSheets, getGmail } = require("./google");
  const results = {};

  results.env = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "✅ set" : "❌ missing",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "✅ set" : "❌ missing",
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? "✅ set" : "❌ missing",
  };

  try {
    const auth = getAuth();
    const tokenRes = await auth.getAccessToken();
    results.token = tokenRes.token ? "✅ access token obtained" : "❌ no token returned";
  } catch (err) {
    results.token = `❌ ${err.message}`;
  }

  try {
    const drive = getDrive();
    await drive.files.list({ pageSize: 1, fields: "files(id)" });
    results.drive = "✅ Drive OK";
  } catch (err) {
    results.drive = `❌ ${err.message}`;
  }

  try {
    const gmail = getGmail();
    await gmail.users.getProfile({ userId: "me" });
    results.gmail = "✅ Gmail OK";
  } catch (err) {
    results.gmail = `❌ ${err.message}`;
  }

  try {
    const calendar = getCalendar();
    await calendar.calendarList.list({ maxResults: 1 });
    results.calendar = "✅ Calendar OK";
  } catch (err) {
    results.calendar = `❌ ${err.message}`;
  }

  try {
    const sheets = getSheets();
    await sheets.spreadsheets.create({
      requestBody: { properties: { title: "_google_test_probe" } },
    }).then(async (res) => {
      // Clean up the test spreadsheet
      const drive = getDrive();
      await drive.files.delete({ fileId: res.data.spreadsheetId }).catch(() => {});
    });
    results.sheets = "✅ Sheets OK";
  } catch (err) {
    results.sheets = `❌ ${err.message}`;
  }

  res.json(results);
});

// ── Price alert check endpoint ────────────────────────────────────────────────
app.post("/check-alerts", express.json(), async (req, res) => {
  if (req.headers["x-scheduled-secret"] !== process.env.SCHEDULED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.status(200).json({ ok: true });
  await checkPriceAlerts(send);
});

// ── Send helper ───────────────────────────────────────────────────────────────
function send(chatId, text) {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    return bot.telegram.sendMessage(chatId, text);
  }

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

  return chunks.reduce((promise, chunk, i) => {
    return promise.then(() =>
      bot.telegram.sendMessage(chatId, chunks.length > 1 ? `(${i + 1}/${chunks.length})\n\n${chunk}` : chunk)
    );
  }, Promise.resolve());
}

// ── Webhook setup ─────────────────────────────────────────────────────────────
app.use(bot.webhookCallback("/webhook"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Telegram agent running on port ${PORT}`);
  if (process.env.RENDER_URL) {
    await bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`).catch(console.error);
    console.log(`Webhook set: ${process.env.RENDER_URL}/webhook`);
  }
  // Fire-and-forget: MCP servers can take 10-30s+ to spawn (npx cold-start), and
  // one failing to start must never block the Telegram webhook from coming up.
  startMcpServers()
    .then(refreshToolRegistry)
    .catch((err) => console.error("[MCP] startup error:", err.message));
});
