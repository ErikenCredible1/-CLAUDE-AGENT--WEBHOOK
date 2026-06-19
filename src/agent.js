const axios = require("axios");
const { executeTool, TOOL_DEFINITIONS } = require("./tools");
const { executeGoogleTool, GOOGLE_TOOL_DEFINITIONS } = require("./google-tools");
const { loadHistory, saveMessage, clearHistory, saveFact, loadFacts, deleteFact, buildMemoryBlock } = require("./memory");

const ALL_TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ...GOOGLE_TOOL_DEFINITIONS];

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
You can do real work — not just answer questions. For any complex task, use plan_task first to break it into steps, then execute each step using your tools.

MEMORY INSTRUCTIONS:
- When the user tells you something personal (name, location, preference, habit, important fact), use the remember tool to save it permanently
- When asked "what do you know about me?" use the recall tool to list saved facts
- When asked to forget something specific, use the forget tool

SCHEDULING:
You CAN set up scheduled recurring tasks. When the user asks to schedule something (e.g. "every day at 9am send me a news summary", "every monday check my emails"), tell them to use this exact format:
"every [timing] [action]"
Examples:
- "every day at 9am summarise the news"
- "every monday check my calendar"
- "every morning remind me to review my tasks"
They can also say "list schedules" to see active ones, or "delete schedule [name]" to remove one.

TOOLS AVAILABLE:
- web_search: search the internet for current info — always use this for anything time-sensitive
- http_request: call any external API
- run_js: execute Node.js code for calculations, data processing, formatting
- read_file / write_file / list_files: manage files in your workspace
- get_stock_price: real-time stock prices (e.g. AAPL, TSLA)
- get_crypto_price: real-time crypto prices (e.g. bitcoin, ethereum)
- set_price_alert: alert user when a stock/crypto hits a target price
- read_uploaded_file: extract text from uploaded PDFs, Word docs, text files
- create_pdf: generate a PDF from content and upload to Drive — always follow with upload_to_drive, then only send the user a short summary and the Drive link, never the full content
- plan_task: break a complex task into steps before executing
- remember: permanently save a fact about the user
- recall: list all saved facts about the user
- forget_fact: delete a specific saved fact
- create_schedule: create a recurring scheduled task (e.g. every friday at 5pm, every monday at 8am)
- list_schedules: list all active scheduled tasks
- delete_schedule: delete a scheduled task by name

GOOGLE TOOLS:
- send_email: send email from the agent's Gmail
- read_emails: search and read emails in the agent's Gmail
- upload_to_drive: upload a file to Google Drive and get a shareable link
- list_drive_files: list files in Google Drive
- read_drive_file: read and extract content from a file in Google Drive
- create_calendar_event: create a calendar event
- read_calendar: check upcoming calendar events
- create_sheet: create a Google Sheet with data and get a shareable link

PDF BEHAVIOR:
When creating a PDF, always:
1. Create it with create_pdf (auto uploads to Drive)
2. Send the user only: a 2-3 line summary of what the PDF contains + the Drive link
Never send the full PDF content as a LINE message.
For tasks like "research X and write a report", "compare A vs B", or "find the best Y":
1. Call plan_task first to lay out the steps
2. Execute each step using appropriate tools
3. Synthesize results into a final clear answer

IMAGE UNDERSTANDING:
When the user sends an image, analyse it carefully and describe what you see. If asked to extract text, do so accurately. If asked about objects, people, charts, documents — describe them in detail.

FORMATTING — THIS IS CRITICAL:
Telegram does not render markdown in plain text mode. Never use markdown. Specifically:
- NO asterisks for bold (**text** or *text*)
- NO markdown tables with | pipes |
- NO --- dividers
- NO # headers
- NO backticks

Use clean plain text instead:
- Lists: numbers (1. 2. 3.) or dashes (-)
- Section headers: use emoji + label e.g. "📊 Results" or "🏆 Top Picks"
- Separate items with a blank line
- Emphasize with CAPS sparingly
- Keep it concise — user is on mobile

Example of good formatting:

🏆 TOP 3 LUXURY SUVS

1. Lexus GX 460 (2016-2020)
Seats 7, bulletproof reliability, 8.0/10 score

2. Lexus LX 570 (2016-2020)
Seats 7-8, Land Cruiser platform, exceptional longevity

3. Acura MDX (2016-2020)
Seats 7, best handling in class, strong resale value`;
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

    try {
      return await agentLoop(userId, history, onProgress, memoryBlock);
    } catch (err) {
      // If the LLM rejected the request (likely corrupt history), auto-clear and retry once
      if (err.message.includes("(400)") || err.message.includes("(422)")) {
        console.warn(`[runAgent] LLM error for ${userId}, clearing history and retrying fresh`);
        await clearHistory(userId);
        await saveMessage(userId, userMsg);
        return await agentLoop(userId, [userMsg], onProgress, memoryBlock);
      }
      throw err;
    }
  });
}

async function runAgentWithImage(userId, imageBuffer, caption, onProgress) {
  return withUserLock(userId, async () => {
    const base64 = imageBuffer.toString("base64");
    const userMsg = {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: "text", text: caption || "What is in this image? Describe it in detail." },
      ],
    };

    let history = await loadHistory(userId);
    history.push(userMsg);
    await saveMessage(userId, { role: "user", content: caption || "[Image sent by user]" });

    const memoryBlock = await buildMemoryBlock(userId);

    try {
      return await agentLoop(userId, history, onProgress, memoryBlock);
    } catch (err) {
      if (err.message.includes("(400)") || err.message.includes("(422)")) {
        console.warn(`[runAgentWithImage] LLM error for ${userId}, retrying fresh`);
        await clearHistory(userId);
        await saveMessage(userId, { role: "user", content: caption || "[Image sent by user]" });
        return await agentLoop(userId, [userMsg], onProgress, memoryBlock);
      }
      throw err;
    }
  });
}

async function agentLoop(userId, history, onProgress, memoryBlock = null) {
  const messages = [
    { role: "system", content: getSystemPrompt(memoryBlock) },
    ...history,
  ];

  const MAX_TOOL_CALLS = 20;
  let toolCallCount = 0;

  while (true) {
    const response = await callLLM(messages);
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
        const googleResult = await executeGoogleTool(toolName, toolArgs);
        toolResult = googleResult !== null ? googleResult : await executeTool(toolName, toolArgs, userId);
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

async function callLLM(messages) {
  const model = process.env.OPENROUTER_MODEL || "tencent/hy3-preview";
  let res;
  try {
    res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model, messages, tools: ALL_TOOL_DEFINITIONS, max_tokens: 2048 },
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
    const detail = body?.error?.message || rawBody;
    throw new Error(`LLM request failed (${err.response?.status}): ${detail}`);
  }

  const data = res.data;
  if (data.error) {
    console.error("[callLLM] API error — full response body:", JSON.stringify(data));
    throw new Error(`OpenRouter error: ${JSON.stringify(data.error)}`);
  }
  if (!data.choices || data.choices.length === 0) {
    console.error("[callLLM] No choices in response — full response body:", JSON.stringify(data));
    throw new Error(`No response from model. Raw: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data;
}

function describeToolCall(name, args) {
  switch (name) {
    case "web_search":             return `Searching: "${args.query}"`;
    case "run_js":                 return `Running code...`;
    case "http_request":           return `Fetching ${args.url}`;
    case "read_file":              return `Reading ${args.filename}`;
    case "write_file":             return `Writing ${args.filename}`;
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

module.exports = { runAgent, runAgentWithImage };
