const { Redis } = require("@upstash/redis");
const { randomBytes, createHash } = require("crypto");
const axios = require("axios");

function getRedis() {
  return new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
}

function monKey(userId) { return `monitors:${userId}`; }
function newId() { return "mon_" + randomBytes(6).toString("hex"); }
function parse(v) {
  try { return typeof v === "string" ? JSON.parse(v) : v; }
  catch { return null; }
}
function hash(text) { return createHash("md5").update(text).digest("hex"); }

async function addMonitor(userId, { type, target, label }) {
  const redis = getRedis();
  const id = newId();
  const monitor = { id, type, target, label, last_hash: null, last_checked: null, created_at: new Date().toISOString() };
  await redis.hset(monKey(userId), { [id]: JSON.stringify(monitor) });
  return monitor;
}

async function listMonitors(userId) {
  const redis = getRedis();
  const raw = await redis.hgetall(monKey(userId));
  if (!raw) return [];
  return Object.values(raw).map(parse).filter(Boolean);
}

async function deleteMonitor(userId, monitorId) {
  const redis = getRedis();
  return (await redis.hdel(monKey(userId), monitorId)) > 0;
}

async function fetchContent(type, target) {
  if (type === "url") {
    const res = await axios.get(target, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15_000,
    });
    return String(res.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
  }
  if (type === "keyword") {
    const res = await axios.get("https://api.search.brave.com/res/v1/news/search", {
      params: { q: target, count: 5 },
      headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY },
      timeout: 15_000,
    });
    const articles = res.data?.results || [];
    return articles.map(a => `${a.title} ${a.description || ""}`).join(" ").slice(0, 5000);
  }
  return "";
}

async function checkAllMonitors(sendFn) {
  const redis = getRedis();
  const keys = await redis.keys("monitors:*");

  for (const key of keys) {
    const userId = key.replace("monitors:", "");
    const raw = await redis.hgetall(key);
    if (!raw) continue;

    const monitors = Object.values(raw).map(parse).filter(Boolean);

    for (const monitor of monitors) {
      try {
        const content = await fetchContent(monitor.type, monitor.target);
        if (!content) continue;

        const newHash = hash(content);

        if (monitor.last_hash && newHash !== monitor.last_hash) {
          const label = monitor.type === "keyword"
            ? `Keyword: "${monitor.target}"`
            : monitor.target;
          await sendFn(userId, `🔔 Monitor alert — *${monitor.label}*\n${label} has new content since last check.`);
        }

        const updated = { ...monitor, last_hash: newHash, last_checked: new Date().toISOString() };
        await redis.hset(key, { [monitor.id]: JSON.stringify(updated) });
      } catch (err) {
        console.error(`[monitor] check failed for ${monitor.id}:`, err.message);
      }
    }
  }
}

module.exports = { addMonitor, listMonitors, deleteMonitor, checkAllMonitors };
