const { Client } = require("@upstash/qstash");

let qstash = null;

function getQStash() {
  if (!qstash) {
    qstash = new Client({
      token: process.env.QSTASH_TOKEN,
      baseUrl: process.env.QSTASH_URL,
    });
  }
  return qstash;
}

/**
 * Schedule a recurring task for a user.
 * @param {string} userId - LINE user ID
 * @param {string} taskPrompt - what the agent should do when triggered
 * @param {string} cron - cron expression e.g. "0 9 * * 1" (Mon 9am UTC)
 * @param {string} label - friendly name e.g. "Monday news summary"
 * @returns {string} scheduleId
 */
const QSTASH_SCHEDULE_LIMIT = 5;

async function createSchedule(userId, taskPrompt, cron, label) {
  const q = getQStash();
  const baseUrl = process.env.RENDER_URL;

  const existing = await q.schedules.list().catch(() => []);
  if (existing.length >= QSTASH_SCHEDULE_LIMIT) {
    const names = await listSchedules(userId);
    const nameList = names.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
    throw new Error(
      `Schedule limit reached (${existing.length}/${QSTASH_SCHEDULE_LIMIT} on free plan).\n\nYour active schedules:\n${nameList}\n\nDelete one with: delete schedule [name]`
    );
  }

  const schedule = await q.schedules.create({
    destination: `${baseUrl}/scheduled`,
    cron,
    body: JSON.stringify({ userId, taskPrompt, label }),
    headers: {
      "Content-Type": "application/json",
      "x-scheduled-secret": process.env.SCHEDULED_SECRET,
    },
  });

  // Save to Redis so we can list/delete later
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });

  const key = `schedules:${userId}`;
  const entry = {
    scheduleId: schedule.scheduleId,
    label,
    taskPrompt,
    cron,
    createdAt: new Date().toISOString(),
  };
  await redis.rpush(key, JSON.stringify(entry));

  return schedule.scheduleId;
}

/**
 * List all schedules for a user.
 */
async function listSchedules(userId) {
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });

  const items = await redis.lrange(`schedules:${userId}`, 0, -1);
  return items.map((i) => JSON.parse(i));
}

/**
 * Delete a schedule by label or scheduleId.
 */
async function deleteSchedule(userId, identifier) {
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });

  const key = `schedules:${userId}`;
  const items = await redis.lrange(key, 0, -1);
  const schedules = items.map((i) => JSON.parse(i));

  // Find by label or scheduleId
  const match = schedules.find(
    (s) =>
      s.label.toLowerCase() === identifier.toLowerCase() ||
      s.scheduleId === identifier
  );

  if (!match) return false;

  // Delete from QStash
  const q = getQStash();
  await q.schedules.delete(match.scheduleId);

  // Remove from Redis
  await redis.lrem(key, 1, JSON.stringify(match));
  return true;
}

/**
 * Parse natural language schedule requests from the user.
 * Returns { cron, label } or null if not recognised.
 */
function parseScheduleRequest(text) {
  const lower = text.toLowerCase();

  // Common patterns
  const patterns = [
    { regex: /every day at (\d+)(am|pm)/i, fn: (m) => ({
      cron: `0 ${toUTC(parseInt(m[1]), m[2])} * * *`,
      label: `Daily ${m[1]}${m[2]} reminder`,
    })},
    { regex: /every morning/i, fn: () => ({
      cron: "0 8 * * *",
      label: "Daily morning briefing",
    })},
    { regex: /every monday/i, fn: () => ({
      cron: "0 9 * * 1",
      label: "Weekly Monday briefing",
    })},
    { regex: /every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d+)(am|pm)/i,
      fn: (m) => ({
        cron: `0 ${toUTC(parseInt(m[2]), m[3])} * * ${dayNum(m[1])}`,
        label: `Weekly ${m[1]} ${m[2]}${m[3]} task`,
      })
    },
    { regex: /every hour/i, fn: () => ({
      cron: "0 * * * *",
      label: "Hourly task",
    })},
    { regex: /every weekday/i, fn: () => ({
      cron: "0 9 * * 1-5",
      label: "Weekday morning task",
    })},
  ];

  for (const p of patterns) {
    const m = lower.match(p.regex);
    if (m) return p.fn(m);
  }

  return null;
}

function toUTC(hour, ampm) {
  // Assumes UTC+7 (Thailand) — adjust TIMEZONE_OFFSET in .env to change
  const offset = parseInt(process.env.TIMEZONE_OFFSET || "7");
  let h = ampm.toLowerCase() === "pm" && hour !== 12 ? hour + 12 : hour;
  if (ampm.toLowerCase() === "am" && hour === 12) h = 0;
  return ((h - offset + 24) % 24);
}

function dayNum(day) {
  const days = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  return days[day.toLowerCase()] ?? 1;
}

module.exports = { createSchedule, listSchedules, deleteSchedule, parseScheduleRequest };
