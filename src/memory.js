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

const HISTORY_LIMIT = 15;
const HISTORY_MAX   = 100;
const SUMMARY_TRIGGER = 20;

// ── Message sanitization ──────────────────────────────────────────────────────

function cleanMessage(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const { reasoning, reasoning_details, refusal, ...clean } = msg;
  if (clean.content === null || clean.content === undefined) clean.content = "";
  return clean;
}

// ── Conversation history ──────────────────────────────────────────────────────

async function loadHistory(userId) {
  try {
    const r = getRedis();
    const items = await r.lrange(`history:${userId}`, -HISTORY_LIMIT, -1);
    const cleaned = items.map(cleanMessage);

    // Build set of all tool_call ids present in assistant messages
    const toolCallIds = new Set();
    for (const msg of cleaned) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) toolCallIds.add(tc.id);
      }
    }

    // Strip orphaned tool messages (no matching assistant tool_call in window)
    return cleaned.filter((msg) => {
      if (msg.role !== "tool") return true;
      return toolCallIds.has(msg.tool_call_id);
    });
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

    const length = await r.llen(key);

    if (length > HISTORY_MAX) {
      await trimToSafeBoundary(r, key);
    }

    if (length > SUMMARY_TRIGGER) {
      summarizeOldHistory(userId).catch(console.error);
    }
  } catch (err) {
    console.warn("Redis saveMessage error:", err.message);
  }
}

// Trim history but always start at a user message so tool pairs are never split
async function trimToSafeBoundary(r, key) {
  try {
    const all = await r.lrange(key, 0, -1);
    if (all.length <= HISTORY_MAX) return;

    // Target: keep last HISTORY_MAX messages, but walk forward to find a user message
    let startIdx = all.length - HISTORY_MAX;
    while (startIdx < all.length && all[startIdx]?.role !== "user") {
      startIdx++;
    }

    if (startIdx > 0 && startIdx < all.length) {
      await r.ltrim(key, startIdx, -1);
    }
  } catch (err) {
    console.warn("Redis trimToSafeBoundary error:", err.message);
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

    const allItems = await r.lrange(key, 0, -(HISTORY_LIMIT + 1));
    if (allItems.length < 10) return;

    const conversationText = allItems
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");

    const existingSummary = await r.get(`summary:${userId}`) || "";

    const prompt = existingSummary
      ? `You have a running summary of past conversations and a new batch to incorporate.
Merge them into one concise paragraph (under 200 words) that captures the most useful long-term context:
- Who the user is and their preferences
- Important tasks completed
- Ongoing goals or recurring needs

Existing summary:
${existingSummary}

New conversation to merge in:
${conversationText}`
      : `Summarize this conversation into a compact paragraph (under 200 words) capturing:
- Key facts the user shared about themselves
- Important tasks completed
- Any preferences or context useful to remember

Conversation:
${conversationText}`;

    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: process.env.OPENROUTER_MODEL || "tencent/hy3-preview",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
    );

    const summary = res.data.choices?.[0]?.message?.content;
    if (!summary) return;

    await r.set(`summary:${userId}`, summary);
    await trimToSafeBoundary(r, key);

    console.log(`[Memory] Summarized history for user ${userId}`);
  } catch (err) {
    console.error("summarizeOldHistory error:", err.message);
  }
}

// Automatically extract and save durable facts from a completed exchange.
// Fires after every agent response — async, never blocks the reply to the user.
async function autoLearn(userId, userMessage, agentResponse) {
  if (!userMessage || !agentResponse || agentResponse.length < 20) return;

  try {
    const existingFacts = await loadFacts(userId);
    const existingKeys = Object.keys(existingFacts);

    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: process.env.OPENROUTER_MODEL || "tencent/hy3-preview",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Extract personal facts from this exchange worth remembering long-term.
Return ONLY a JSON object like {"name": "Alice", "city": "London"} or {} if nothing to save.

Only extract durable facts: name, location, job, language, timezone, preferences, recurring goals, dietary needs, or similar.
Do NOT extract: search results, task outputs, one-off requests, or anything transient.
${existingKeys.length ? `Already known (include only if the value has changed): ${JSON.stringify(existingFacts)}` : ""}

User: ${userMessage.slice(0, 600)}
Agent: ${agentResponse.slice(0, 600)}`,
        }],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
    );

    const content = res.data.choices?.[0]?.message?.content || "{}";
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return;

    const facts = JSON.parse(jsonMatch[0]);
    for (const [key, value] of Object.entries(facts)) {
      if (key && value && typeof value === "string") {
        await saveFact(userId, key.toLowerCase().trim(), value.trim());
        console.log(`[Memory] Auto-learned: ${key} = ${value} for user ${userId}`);
      }
    }
  } catch (err) {
    console.error("autoLearn error:", err.message);
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

// ── Long-term memory (permanent facts) ────────────────────────────────────────

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

async function deleteFact(userId, key) {
  try {
    const r = getRedis();
    await r.hdel(`facts:${userId}`, key);
    return true;
  } catch (err) {
    return false;
  }
}

async function buildMemoryBlock(userId) {
  const [facts, summary] = await Promise.all([loadFacts(userId), loadSummary(userId)]);
  const parts = [];

  if (Object.keys(facts).length > 0) {
    const factLines = Object.entries(facts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
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
  autoLearn,
};
