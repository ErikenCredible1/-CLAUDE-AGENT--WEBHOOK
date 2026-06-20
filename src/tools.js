const axios = require("axios");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractTextFromFile } = require("./file-extract");

const WORK_DIR = path.join(__dirname, "../workspace");
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information, news, facts, or research.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_js",
      description: "Execute JavaScript (Node.js) code and return stdout.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Node.js code to execute" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description: "Get real-time stock price and daily change for a ticker symbol.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock ticker e.g. AAPL, TSLA, NVDA" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crypto_price",
      description: "Get real-time cryptocurrency price and 24h change.",
      parameters: {
        type: "object",
        properties: {
          coin: { type: "string", description: "CoinGecko coin id e.g. bitcoin, ethereum, solana" },
        },
        required: ["coin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_price_alert",
      description: "Set an alert to notify the user when a stock or crypto hits a target price.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker or coin id" },
          type: { type: "string", enum: ["stock", "crypto"], description: "Asset type" },
          condition: { type: "string", enum: ["above", "below"], description: "Trigger condition" },
          target: { type: "number", description: "Target price in USD" },
        },
        required: ["symbol", "type", "condition", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_uploaded_file",
      description: "Read and extract text from an uploaded file (PDF, Word doc, or text file) stored in the workspace.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename to read" },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_task",
      description: "Break a complex multi-step task into a structured plan before executing it. Use this first for any task that requires more than 3 steps.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task to plan" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "List of steps to execute in order",
          },
        },
        required: ["task", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pdf",
      description: "Generate a PDF and return a download link. Use when the user asks for a PDF, document, or report they can download. For long reports, write the full report as your normal reply text first, then call this tool with just filename and title — your reply text automatically becomes the PDF body. Only pass content directly for short notes.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "PDF filename without extension e.g. 'report'" },
          title: { type: "string", description: "Document title shown at top of PDF" },
          content: { type: "string", description: "Plain text content for the PDF. Only needed for short content — omit it for long reports and write the report as your reply text instead." },
        },
        required: ["filename", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Permanently save a fact about the user. Use when the user shares personal info, preferences, or anything worth remembering long term.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short label e.g. 'name', 'city', 'car', 'preferred airline'" },
          value: { type: "string", description: "The value e.g. 'Erik', 'Miami', 'Tesla Model 3'" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "List all permanently saved facts about the user.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_fact",
      description: "Delete a specific saved fact about the user.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The fact key to delete" },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_schedule",
      description: "Create a recurring scheduled task that runs automatically. Use when the user asks to schedule something regularly e.g. 'every friday analyze the market', 'every monday at 8am check futures'.",
      parameters: {
        type: "object",
        properties: {
          timing: { type: "string", description: "When to run — natural language e.g. 'every friday at 5pm', 'every monday at 8am', 'every day at 9am', 'every morning'" },
          task: { type: "string", description: "What the agent should do when the schedule fires — be specific e.g. 'Search for this week\\'s stock market news and give a detailed weekly summary'" },
          label: { type: "string", description: "Short friendly name for this schedule e.g. 'Weekly market summary', 'Monday futures check'" },
        },
        required: ["timing", "task", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_schedules",
      description: "List all active scheduled tasks for the user.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_schedule",
      description: "Delete a scheduled task by its label/name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The schedule label to delete" },
        },
        required: ["name"],
      },
    },
  },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

async function executeTool(name, args, userId = "default") {
  switch (name) {
    case "web_search":        return await webSearch(args.query);
    case "run_js":            return runJs(args.code);
    case "get_stock_price":   return await getStockPrice(args.symbol);
    case "get_crypto_price":  return await getCryptoPrice(args.coin);
    case "set_price_alert":   return await setPriceAlert(args.symbol, args.type, args.condition, args.target);
    case "read_uploaded_file":return await readUploadedFile(args.filename);
    case "plan_task":         return planTask(args.task, args.steps);
    case "create_pdf":        return await createPdf(args.filename, args.title, args.content);
    case "remember": {
      const { saveFact } = require("./memory");
      await saveFact(userId, args.key, args.value);
      return `Got it! I'll remember that your ${args.key} is ${args.value}.`;
    }
    case "recall": {
      const { loadFacts } = require("./memory");
      const facts = await loadFacts(userId);
      if (!Object.keys(facts).length) return "I don't have any saved facts about you yet.";
      return Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("\n");
    }
    case "forget_fact": {
      const { deleteFact } = require("./memory");
      await deleteFact(userId, args.key);
      return `Forgotten: ${args.key}`;
    }
    case "create_schedule": {
      const { createSchedule, parseScheduleRequest } = require("./scheduler");
      const parsed = parseScheduleRequest(args.timing);
      if (!parsed) return `Could not parse timing "${args.timing}". Try formats like "every friday at 5pm", "every monday at 8am", "every day at 9am", or "every morning".`;
      await createSchedule(userId, args.task, parsed.cron, args.label);
      return `Schedule created! "${args.label}" will run ${args.timing}.`;
    }
    case "list_schedules": {
      const { listSchedules } = require("./scheduler");
      const schedules = await listSchedules(userId);
      if (!schedules.length) return "No active schedules.";
      return schedules.map((s, i) => `${i + 1}. ${s.label}\n   When: ${s.cron}\n   Task: ${s.taskPrompt}`).join("\n\n");
    }
    case "delete_schedule": {
      const { deleteSchedule } = require("./scheduler");
      const deleted = await deleteSchedule(userId, args.name);
      return deleted ? `Deleted schedule: "${args.name}"` : `No schedule found with name "${args.name}"`;
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Web search ────────────────────────────────────────────────────────────────
async function webSearch(query) {
  if (process.env.TAVILY_API_KEY) {
    console.log(`[Tavily] Searching: "${query}" with key: ${process.env.TAVILY_API_KEY.slice(0, 8)}...`);
    try {
      const res = await axios.post("https://api.tavily.com/search", {
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5,
        search_depth: "basic",
      });
      console.log(`[Tavily] Status: ${res.status}, Results: ${res.data.results?.length ?? 0}`);
      const results = (res.data.results || [])
        .map((r) => `[${r.title}]\n${r.url}\n${r.content}`)
        .join("\n\n");
      return results || "No results found.";
    } catch (err) {
      console.error(`[Tavily] Error: ${err.response?.status} ${err.response?.data?.message || err.message}`);
      console.log("[Tavily] Falling back to DuckDuckGo...");
    }
  }
  const res = await axios.get("https://api.duckduckgo.com/", {
    params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
  });
  const data = res.data;
  const parts = [];
  if (data.AbstractText) parts.push(data.AbstractText);
  (data.RelatedTopics || []).slice(0, 5).forEach((t) => { if (t.Text) parts.push(t.Text); });
  return parts.length ? parts.join("\n\n") : "No results found.";
}

// ── Code execution ────────────────────────────────────────────────────────────
function runJs(code) {
  const tmpFile = path.join(os.tmpdir(), `run_js_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  try {
    fs.writeFileSync(tmpFile, code, "utf8");
    const result = execFileSync("node", [tmpFile], { timeout: 10000, encoding: "utf8" });
    return result || "(no output)";
  } catch (err) {
    return `Error: ${err.stderr || err.message}`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Read uploaded file (PDF, Word, text) ──────────────────────────────────────
async function readUploadedFile(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(WORK_DIR, safeName);
  if (!fs.existsSync(filePath)) return `File not found: ${safeName}`;
  return extractTextFromFile(filePath);
}

// ── Stock price ───────────────────────────────────────────────────────────────
async function getStockPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=1d`;
    const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
    const meta = res.data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const change = (meta.regularMarketChange || 0).toFixed(2);
    const pct = (meta.regularMarketChangePercent || 0).toFixed(2);
    const direction = change >= 0 ? "📈" : "📉";
    return `${symbol.toUpperCase()}: $${price.toFixed(2)} ${direction} ${change >= 0 ? "+" : ""}${change} (${pct}%)`;
  } catch (err) {
    return `Could not fetch price for ${symbol}: ${err.message}`;
  }
}

// ── Crypto price ──────────────────────────────────────────────────────────────
async function getCryptoPrice(coin) {
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd&include_24hr_change=true`,
      { timeout: 10000 }
    );
    const data = res.data[coin];
    if (!data) return `Coin "${coin}" not found. Try using the full name e.g. "bitcoin", "ethereum".`;
    const price = data.usd;
    const change = (data.usd_24h_change || 0).toFixed(2);
    const direction = change >= 0 ? "📈" : "📉";
    return `${coin.toUpperCase()}: $${price.toLocaleString()} ${direction} ${change >= 0 ? "+" : ""}${change}% (24h)`;
  } catch (err) {
    return `Could not fetch price for ${coin}: ${err.message}`;
  }
}

// ── Price alert (stored in Redis, checked by a QStash schedule) ───────────────
async function setPriceAlert(symbol, type, condition, target) {
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });

  const alert = { symbol, type, condition, target, createdAt: new Date().toISOString() };
  await redis.rpush("price_alerts", JSON.stringify(alert));

  return `✅ Alert set: notify when ${symbol.toUpperCase()} goes ${condition} $${target}`;
}

// ── Task planner ──────────────────────────────────────────────────────────────
function planTask(task, steps) {
  const plan = [
    `📋 Task: ${task}`,
    `Steps:`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
  ].join("\n");
  return plan;
}

// ── PDF generation ────────────────────────────────────────────────────────────
async function createPdf(filename, title, content) {
  const PDFDocument = require("pdfkit");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const safeName = path.basename(filename.replace(/\.pdf$/i, "")) + ".pdf";
        const filePath = path.join(WORK_DIR, safeName);

        // Save locally
        fs.writeFileSync(filePath, buffer);

        // Auto upload to Drive
        const { executeGoogleTool } = require("./google-tools");
        const driveResult = await executeGoogleTool("upload_to_drive", { filename: safeName });

        // Extract just the link from the drive result
        const linkMatch = driveResult.match(/https:\/\/[^\s]+/);
        const link = linkMatch ? linkMatch[0] : null;

        if (link) {
          resolve(`PDF saved to Google Drive!\n\nLink: ${link}`);
        } else {
          resolve(`PDF created as ${safeName} but Drive upload failed. Try uploading manually.`);
        }
      } catch (err) {
        resolve(`PDF created but upload failed: ${err.message}`);
      }
    });

    // Build the PDF
    doc.fontSize(22).font("Helvetica-Bold").text(title, { align: "center" });
    doc.moveDown();
    doc.fontSize(10).font("Helvetica").text(new Date().toLocaleDateString(), { align: "center" });
    doc.moveDown(2);

    // Split content into lines and render
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.trim() === "") {
        doc.moveDown(0.5);
      } else if (line.match(/^[A-Z][A-Z\s]+:?$/) && line.length < 50) {
        // Looks like a section header (ALL CAPS)
        doc.moveDown(0.5);
        doc.fontSize(13).font("Helvetica-Bold").text(line);
        doc.fontSize(11).font("Helvetica");
      } else if (line.match(/^\d+\./)) {
        // Numbered list item
        doc.fontSize(11).font("Helvetica").text(line, { indent: 20 });
      } else if (line.startsWith("-")) {
        // Bullet point
        doc.fontSize(11).font("Helvetica").text(line, { indent: 20 });
      } else {
        doc.fontSize(11).font("Helvetica").text(line);
      }
    }

    doc.end();
  });
}

module.exports = { executeTool, TOOL_DEFINITIONS };
