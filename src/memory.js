const { Redis } = require("@upstash/redis");
const axios = require("axios");

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  }
  return redis;
}

const HISTORY_LIMIT = 20;  // recent messages to keep in full
const HISTORY_MAX   = 100; // max messages before summarizing
const SUMMARY_TRIGGER = 40; // summarize when history exceeds this

// ── Conversation history ──────────────────────────────────────────────────────

function cleanMessage(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const { reasoning, reasoning_details, refusal, ...clean } = msg;
  if (clean.content === null || clean.content === undefined) clean.content = "";
  return clean;
}

async function loadHistory(userId) {
  try {
    const r = getRedis();
    const items = await r.lrange(`history:${userId}`, -HISTORY_LIMIT, -1);
    return items.map(cleanMessage);
  } catch (err) {
    console.warn("Redis loadHistory error:", err.message);
    return [];
  }
}

async function saveMessage(userId, message) {
  try {
    const r = getRedis();
    const key = `history:${userId}`;
    await r.rpush(key, message);
    await r.ltrim(key, -HISTORY_MAX, -1);

    // Check if we should summarize
    const length = await r.llen(key);
    if (length > SUMMARY_TRIGGER) {
      summarizeOldHistory(userId).catch(console.error);
    }
  } catch (err) {
    console.warn("Redis saveMessage error:", err.message);
  }
}

async function clearHistory(userId) {
  try {
    const r = getRedis();
    await r.del(`history:${userId}`);
    await r.del(`summary:${userId}`);
    return true;
  } catch (err) {
    console.warn("Redis clearHistory error:", err.message);
    return false;
  }
}

// ── Conversation summarization ────────────────────────────────────────────────

async function summarizeOldHistory(userId) {
  try {
    const r = getRedis();
    const key = `history:${userId}`;

    // Get all messages except the most recent HISTORY_LIMIT
    const allItems = await r.lrange(key, 0, -(HISTORY_LIMIT + 1));
    if (allItems.length < 10) return; // not enough to summarize

    const messages = allItems;

    // Build text to summarize
    const conversationText = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");

    // Call LLM to summarize
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-5",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `Summarize this conversation history into a compact paragraph that captures:
- Key facts the user shared about themselves
- Important tasks that were completed
- Any preferences or context that would be useful to remember

Keep it under 200 words. Be factual and specific.

Conversation:
${conversationText}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const summary = res.data.choices[0].message.content;

    // Load existing summary and append new one
    const existingSummary = await r.get(`summary:${userId}`) || "";
    const combinedSummary = existingSummary
      ? `${existingSummary}\n\nMore recent: ${summary}`
      : summary;

    await r.set(`summary:${userId}`, combinedSummary);

    // Trim the old messages from history now that they're summarized
    await r.ltrim(key, -(HISTORY_LIMIT), -1);

    console.log(`[Memory] Summarized history for user ${userId}`);
  } catch (err) {
    console.error("summarizeOldHistory error:", err.message);
  }
}

async function loadSummary(userId) {
  try {
    const r = getRedis();
    return await r.get(`summary:${userId}`) || null;
  } catch (err) {
    console.warn("Redis loadSummary error:", err.message);
    return null;
  }
}

// ── Long term memory (permanent facts) ───────────────────────────────────────

/**
 * Save a fact about the user permanently.
 * Facts are stored as key-value pairs e.g. { key: "car", value: "Tesla Model 3" }
 */
async function saveFact(userId, key, value) {
  try {
    const r = getRedis();
    await r.hset(`facts:${userId}`, { [key]: value });
    return true;
  } catch (err) {
    console.warn("Redis saveFact error:", err.message);
    return false;
  }
}

/**
 * Load all permanent facts about a user.
 */
async function loadFacts(userId) {
  try {
    const r = getRedis();
    const facts = await r.hgetall(`facts:${userId}`);
    return facts || {};
  } catch (err) {
    console.warn("Redis loadFacts error:", err.message);
    return {};
  }
}

/**
 * Delete a specific fact.
 */
async function deleteFact(userId, key) {
  try {
    const r = getRedis();
    await r.hdel(`facts:${userId}`, key);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Format facts and summary into a memory block for the system prompt.
 */
async function buildMemoryBlock(userId) {
  const [facts, summary] = await Promise.all([
    loadFacts(userId),
    loadSummary(userId),
  ]);

  const parts = [];

  if (Object.keys(facts).length > 0) {
    const factLines = Object.entries(facts)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    parts.push(`WHAT I KNOW ABOUT YOU:\n${factLines}`);
  }

  if (summary) {
    parts.push(`CONVERSATION SUMMARY:\n${summary}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

module.exports = {
  loadHistory,
  saveMessage,
  clearHistory,
  saveFact,
  loadFacts,
  deleteFact,
  buildMemoryBlock,
};
