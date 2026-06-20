const axios = require("axios");
const { executeTool, TOOL_DEFINITIONS } = require("./tools");
const { executeGoogleTool, GOOGLE_TOOL_DEFINITIONS } = require("./google-tools");
const { executeMcpTool, getMcpToolDefinitions } = require("./mcp-tools");
const { loadHistory, saveMessage, clearHistory, saveFact, loadFacts, deleteFact, buildMemoryBlock } = require("./memory");

// ── Lazy tool loading — see get_tool_schema below ──────────────────────────────
// Full schemas cost ~15k tokens/request if all sent upfront. Instead the model
// gets a lightweight name+description index in the system prompt, plus this one
// real meta-tool. Calling it unlocks a tool's full schema for the rest of this turn.
// MCP tools aren't known until their servers finish starting (see server.js), so
// the registry is rebuilt via refreshToolRegistry() once that completes.
const TOOL_REGISTRY = new Map();

function refreshToolRegistry() {
  TOOL_REGISTRY.clear();
  const all = [...TOOL_DEFINITIONS, ...GOOGLE_TOOL_DEFINITIONS, ...getMcpToolDefinitions()];
  for (const def of all) TOOL_REGISTRY.set(def.function.name, def);
}

refreshToolRegistry();

const GET_TOOL_SCHEMA_DEFINITION = {
  type: "function",
  function: {
    name: "get_tool_schema",
    description: "Get the full parameter schema for a tool before calling it. Call this first whenever you intend to use a tool you haven't already unlocked this turn.",
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact tool name from the TOOLS AVAILABLE list, e.g. 'web_search', 'create_pdf', 'read_calendar'" },
      },
      required: ["tool_name"],
    },
  },
};

function buildToolIndexText() {
  return [...TOOL_REGISTRY.values()]
    .map((def) => {
      // Some MCP servers ship long, multi-paragraph descriptions — truncate to
      // a one-line hint here; the full text is still available via get_tool_schema.
      const firstLine = def.function.description.split("\n")[0];
      const desc = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
      return `- ${def.function.name}: ${desc}`;
    })
    .join("\n");
}

function buildToolsForRequest(unlockedTools) {
  const tools = [GET_TOOL_SCHEMA_DEFINITION];
  for (const name of unlockedTools) {
    const def = TOOL_REGISTRY.get(name);
    if (def) tools.push(def);
  }
  return tools;
}

// ── Per-user lock — prevents concurrent messages corrupting history ────────────
const userLocks = new Map();
const LOCK_TIMEOUT_MS = 120_000; // 2 min max per request before releasing lock

async function withUserLock(userId, fn) {
  while (userLocks.has(userId)) {
    await Promise.race([
      userLocks.get(userId),
      new Promise((r) => setTimeout(r, LOCK_TIMEOUT_MS)), // safety release
    ]);
  }
  let resolve;
  const lock = new Promise((r) => { resolve = r; });
  userLocks.set(userId, lock);
  try {
    return await fn();
  } finally {
    userLocks.delete(userId);
    resolve();
  }
}

// ── Clear-command detection — accept common variants ─────────────────────────
function isClearCommand(text) {
  const normalized = text.toLowerCase().replace(/['"\/]/g, "").trim();
  return ["forget", "clear", "reset", "start", "clearhistory", "clear history"].includes(normalized);
}

function getSystemPrompt(memoryBlock = null) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const memorySection = memoryBlock ? `\n\nMEMORY:\n${memoryBlock}\n` : "";

  return `You are a powerful personal AI agent running on Telegram.
Today's date is ${today}. Always use this date when the user asks about current news, prices, or events. Never say information is unavailable because of a knowledge cutoff — use your web_search tool to find current information instead.
${memorySection}
You can do real work, not just answer questions. For complex/multi-step tasks: call plan_task first, then autonomously execute every step yourself using your tools, one after another in this same turn, with NO pause and NO check-in message between steps. Only reply to the user once the entire task is complete (or if you hit something that genuinely requires their input to proceed) — never stop after just the first step.

MEMORY: remember saves a personal fact permanently; recall lists what you know; forget_fact deletes one.

SCHEDULING: user can say "every [timing] [action]" (e.g. "every day at 9am summarise the news") to create a recurring task — pass it to create_schedule. "list schedules" / "delete schedule [name]" manage existing ones.

TOOLS AVAILABLE:
You do not see full tool schemas upfront — call get_tool_schema with a tool's exact name to get its parameters before calling it for the first time this conversation turn. get_tool_schema itself needs no lookup.

${buildToolIndexText()}

PDF: create_pdf auto-uploads to Drive — reply with only a short summary + the Drive link, never the full content. For long reports, write the report as your normal reply text, then call create_pdf with just filename/title.

IMAGES: you receive a text description of any image the user sent (already analysed) under "[Image analysis]" — respond to it naturally as if you saw the image yourself.

FORMATTING — THIS IS CRITICAL:
Telegram does not render markdown in plain text mode. Never use markdown. Specifically:
- NO asterisks for bold (**text** or *text*)
- NO markdown tables with | pipes |
- NO --- dividers
- NO # headers
- NO backticks

Use clean plain text instead:
- Lists: numbers (1. 2. 3.) or dashes (-)
- Section headers: short ALL-CAPS label on its own line, e.g. "RESULTS" or "TOP PICKS"
- Separate items with a blank line
- Emphasize with CAPS sparingly
- Keep it concise — user is on mobile
- Avoid emoji/special symbols unless the user uses them first — plain ASCII text only

Example:
TOP PICKS
1. Option A - short reason
2. Option B - short reason`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs agentLoop with tiered recovery. Confirmed via production logs that the
// recurring 400 ("Unterminated string...") from tencent/hy3-preview's only two
// providers (GMICloud, SiliconFlow) is NOT history-dependent -- it still fails
// identically on a freshly-cleared history. So clearing history buys nothing
// for this failure mode while costing the user their whole conversation, which
// is exactly what was reported as "it's forgetting what we were working on."
// Retry the SAME history several times (this intermittent bug often clears up
// on its own within a few attempts) and never auto-clear -- only an explicit
// user "clear"/"forget" command (isClearCommand) wipes history now.
const RETRY_ATTEMPTS = 4;

async function runAgentLoopWithRecovery(userId, history, userMsg, onProgress, memoryBlock) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await agentLoop(userId, history, onProgress, memoryBlock);
    } catch (err) {
      const isRateLimited = err.message.includes("(429)");
      const isRetryable = isRateLimited || err.message.includes("(400)") || err.message.includes("(422)") || err.message.includes("(504)");
      if (!isRetryable) throw err;

      lastErr = err;
      if (attempt === RETRY_ATTEMPTS) break;
      console.warn(`[recovery] LLM error for ${userId} (attempt ${attempt}/${RETRY_ATTEMPTS}): ${err.message} — retrying with same history`);
      await sleep(isRateLimited ? 3000 : 1500);
    }
  }

  console.error(`[recovery] still failing after ${RETRY_ATTEMPTS} attempts for ${userId}: ${lastErr.message}`);
  return "Sorry — I'm having trouble reaching the AI model right now (upstream rate-limit or a temporary error). Your conversation history is untouched — please try again in a minute.";
}

async function runAgent(userId, userInput, onProgress) {
  return withUserLock(userId, async () => {
    if (isClearCommand(userInput)) {
      await clearHistory(userId);
      return "🧹 Conversation cleared! Starting fresh.";
    }

    const memoryBlock = await buildMemoryBlock(userId);
    const userMsg = { role: "user", content: userInput };
    let history = await loadHistory(userId);
    history.push(userMsg);
    await saveMessage(userId, userMsg);

    return runAgentLoopWithRecovery(userId, history, userMsg, onProgress, memoryBlock);
  });
}

// Vision is a separate preprocessing step, not the main tool-calling model:
// describe the image with OPENROUTER_VISION_MODEL (no tools), then hand the
// resulting text to the normal agentLoop running on OPENROUTER_MODEL.
async function describeImage(imageBuffer, caption) {
  const visionModel = process.env.OPENROUTER_VISION_MODEL;
  if (!visionModel) return null;

  const prompt = caption
    ? `Describe this image in detail, then specifically address: ${caption}`
    : "Describe this image in detail — objects, people, text, charts, documents, anything notable.";

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: visionModel,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        }],
        max_tokens: 800,
      },
      {
        timeout: 60_000,
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return res.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error(`[describeImage] vision call failed: ${err.response?.status} ${err.response?.data?.error?.message || err.message}`);
    return null;
  }
}

async function runAgentWithImage(userId, imageBuffer, caption, onProgress) {
  return withUserLock(userId, async () => {
    const description = await describeImage(imageBuffer, caption);

    const mergedText = description
      ? `[Image analysis]\n${description}${caption ? `\n\n[User's message with the image]\n${caption}` : ""}`
      : caption
        ? `${caption}\n\n[Note: the attached image could not be analysed]`
        : "[User sent an image, but it could not be analysed]";

    const userMsg = { role: "user", content: mergedText };

    let history = await loadHistory(userId);
    history.push(userMsg);
    await saveMessage(userId, userMsg);

    const memoryBlock = await buildMemoryBlock(userId);

    return runAgentLoopWithRecovery(userId, history, userMsg, onProgress, memoryBlock);
  });
}

async function agentLoop(userId, history, onProgress, memoryBlock = null) {
  const messages = [
    { role: "system", content: getSystemPrompt(memoryBlock) },
    ...history,
  ];

  const MAX_TOOL_CALLS = 20;
  let toolCallCount = 0;
  const unlockedTools = new Set(); // tools whose full schema was requested this turn — resets every call

  while (true) {
    const response = await callLLM(messages, buildToolsForRequest(unlockedTools));
    const choice = response.choices[0];

    // Strip reasoning fields and normalize null content
    const { reasoning, reasoning_details, refusal, ...cleanMsg } = choice.message;
    if (cleanMsg.content === null || cleanMsg.content === undefined) cleanMsg.content = "";
    const assistantMsg = cleanMsg;

    messages.push(assistantMsg);
    history.push(assistantMsg);
    await saveMessage(userId, assistantMsg);

    if (choice.finish_reason === "stop" || !assistantMsg.tool_calls?.length) {
      return assistantMsg.content;
    }

    if (toolCallCount >= MAX_TOOL_CALLS) {
      return assistantMsg.content || "I reached the maximum number of steps for this task. Please try breaking it into smaller requests.";
    }

    for (const toolCall of assistantMsg.tool_calls) {
      toolCallCount++;
      const toolName = toolCall.function.name;
      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      await onProgress(describeToolCall(toolName, toolArgs));

      let toolResult;
      try {
        if (toolName === "get_tool_schema") {
          const def = TOOL_REGISTRY.get(toolArgs.tool_name);
          if (!def) {
            toolResult = `Unknown tool "${toolArgs.tool_name}". Check the TOOLS AVAILABLE list for exact names.`;
          } else {
            unlockedTools.add(toolArgs.tool_name);
            toolResult = JSON.stringify(def.function);
          }
        } else {
          // Defensive: if the model called a real tool directly without unlocking
          // it first, treat it as unlocked anyway — the schema already "leaked"
          // into this tool_call, so erroring here would only add a wasted round trip.
          unlockedTools.add(toolName);

          // create_pdf's content can be long enough to trip up the model's own
          // tool-call JSON generation — let the model write the report as normal
          // reply text instead, and use that as the PDF body when content is omitted.
          if (toolName === "create_pdf" && !toolArgs.content) {
            toolArgs.content = assistantMsg.content || "";
          }

          if (toolName === "create_pdf" && !toolArgs.content) {
            toolResult = "Tool error: no content provided. Write the report as your reply text, then call create_pdf again with just filename and title.";
          } else {
            const googleResult = await executeGoogleTool(toolName, toolArgs);
            if (googleResult !== null) {
              toolResult = googleResult;
            } else {
              const mcpResult = await executeMcpTool(toolName, toolArgs);
              toolResult = mcpResult !== null ? mcpResult : await executeTool(toolName, toolArgs, userId);
            }
          }
        }
      } catch (err) {
        toolResult = `Tool error: ${err.message}`;
      }

      const toolResultMsg = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(toolResult).slice(0, 8000),
      };

      messages.push(toolResultMsg);
      history.push(toolResultMsg);
      await saveMessage(userId, toolResultMsg);
    }
  }
}

// Diagnostic only -- summarizes message/argument sizes (never full content) so
// a failing request's shape is visible in logs without dumping potentially
// huge or sensitive content. Aimed at finding what triggers the recurring
// "Unterminated string" 400 -- likely a tool call with a very large argument
// (e.g. run_js code embedding raw data inline) the same way create_pdf's
// content argument used to.
function summarizeOutgoingMessages(messages) {
  return messages.slice(-6).map((m) => {
    const contentLen = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
    const toolCalls = (m.tool_calls || []).map((tc) => ({
      name: tc.function?.name,
      argsLen: (tc.function?.arguments || "").length,
    }));
    return { role: m.role, contentLen, toolCalls: toolCalls.length ? toolCalls : undefined };
  });
}

async function callLLM(messages, tools) {
  const model = process.env.OPENROUTER_MODEL || "tencent/hy3-preview";
  let res;
  try {
    res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model, messages, tools, max_tokens: 2048 },
      {
        timeout: 90_000, // 90s — prevents hanging forever if provider is slow
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://your-app.com",
          "X-Title": "LINE AI Agent",
        },
      }
    );
  } catch (err) {
    const body = err.response?.data;
    const rawBody = body !== undefined ? JSON.stringify(body) : err.message;
    console.error(`[callLLM] HTTP error ${err.response?.status} — full response body:`, rawBody);
    console.error(`[callLLM] outgoing request shape:`, summarizeOutgoingMessages(messages));
    const detail = body?.error?.message || rawBody;
    throw new Error(`LLM request failed (${err.response?.status}): ${detail}`);
  }

  const data = res.data;
  if (data.error) {
    console.error("[callLLM] API error — full response body:", JSON.stringify(data));
    console.error(`[callLLM] outgoing request shape:`, summarizeOutgoingMessages(messages));
    throw new Error(`OpenRouter error: ${JSON.stringify(data.error)}`);
  }
  if (!data.choices || data.choices.length === 0) {
    console.error("[callLLM] No choices in response — full response body:", JSON.stringify(data));
    console.error(`[callLLM] outgoing request shape:`, summarizeOutgoingMessages(messages));
    throw new Error(`No response from model. Raw: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data;
}

function describeToolCall(name, args) {
  switch (name) {
    case "get_tool_schema":         return `Looking up how to use ${args.tool_name}...`;
    case "web_search":             return `Searching: "${args.query}"`;
    case "run_js":                 return `Running code...`;
    case "fetch_html":
    case "fetch_markdown":
    case "fetch_txt":
    case "fetch_json":
    case "fetch_readable":         return `Fetching ${args.url}`;
    case "fetch_youtube_transcript": return `Getting transcript for ${args.url}...`;
    case "read_file":
    case "read_text_file":         return `Reading ${args.path}`;
    case "write_file":             return `Writing ${args.path}`;
    case "list_directory":         return `Listing files...`;
    case "sequentialthinking":     return `Thinking through this...`;
    case "airbnb_search":          return `Searching Airbnb listings...`;
    case "airbnb_listing_details": return `Getting Airbnb listing details...`;
    case "get_stock_price":        return `Getting ${args.symbol} price...`;
    case "get_crypto_price":       return `Getting ${args.coin} price...`;
    case "set_price_alert":        return `Setting price alert for ${args.symbol}...`;
    case "read_uploaded_file":     return `Reading uploaded file: ${args.filename}`;
    case "send_email":             return `Sending email to ${args.to}...`;
    case "read_emails":            return `Searching emails: "${args.query}"...`;
    case "upload_to_drive":        return `Uploading ${args.filename} to Drive...`;
    case "list_drive_files":       return `Listing Drive files...`;
    case "read_drive_file":        return `Reading ${args.filename} from Drive...`;
    case "create_calendar_event":  return `Creating calendar event: ${args.title}...`;
    case "read_calendar":          return `Checking calendar...`;
    case "create_sheet":           return `Creating spreadsheet: ${args.title}...`;
    case "remember":               return `Remembering: ${args.key}...`;
    case "recall":                 return `Recalling facts about you...`;
    case "forget_fact":            return `Forgetting: ${args.key}...`;
    case "create_pdf":             return `Creating PDF: ${args.filename}...`;
    default:                       return `Using tool: ${name}`;
  }
}

module.exports = { runAgent, runAgentWithImage, refreshToolRegistry };
