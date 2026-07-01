const axios = require("axios");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractTextFromFile } = require("./file-extract");
const { safeSlice } = require("./safe-slice");

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
      name: "write_and_run_js",
      description: "Describe a coding task in plain English and a separate code-specialist model writes and runs the JavaScript for you, returning the output. Use for any computation, data processing, calculations, multi-step logic, or anything that requires code.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Plain-English description of what the code should do, e.g. 'fetch 6 months of daily closing prices for AAPL and TSLA and compute the correlation coefficient'" },
        },
        required: ["task"],
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
      name: "fetch_readable",
      description: "Fetch a URL via plain HTTP and return clean readable text. Fastest and free — try this first for any URL. Falls back to fetch_jina if the page is JS-rendered and this returns empty or garbled content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_jina",
      description: "Fetch a URL via Jina Reader — handles JavaScript-rendered pages. Use when fetch_readable returns empty or garbled content. Free, no API key needed.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_browserless",
      description: "Fetch a fully rendered page using a real cloud browser (Browserless). Use when fetch_jina fails or the page requires heavy JS execution. Supports an optional Puppeteer script for clicking, filling forms, or extracting specific data.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to load" },
          script: { type: "string", description: "Optional Puppeteer script (JS) to run in the page context and return data, e.g. 'return document.title'" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_task",
      description: "Show the user a structured plan before starting. Use when: (1) the user explicitly asks to see a plan, or (2) the task has more than 7 steps and is complex enough that the user should approve the approach before execution begins (e.g. building something, a multi-day project, a major decision). Do NOT call this for routine tasks under 7 steps — plan those internally and execute immediately.",
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
  // ── Task inbox ────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Add a task to the user's persistent task inbox. Use when the user mentions something they need to do, follow up on, or track — even if they don't explicitly say 'add a task'.",
      parameters: {
        type: "object",
        properties: {
          title:    { type: "string", description: "Short task title" },
          notes:    { type: "string", description: "Optional extra detail or context" },
          priority: { type: "string", enum: ["high", "medium", "low"], description: "Task priority" },
          due_date: { type: "string", description: "Optional due date in YYYY-MM-DD format" },
        },
        required: ["title", "priority"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List tasks from the user's task inbox. Use when user asks what's on their plate, what's pending, what's overdue, or to review their tasks.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["pending", "overdue", "done", "all"], description: "Which tasks to show. Default: pending" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update a task's details, status, priority, due date, or notes. Get the task_id from list_tasks first.",
      parameters: {
        type: "object",
        properties: {
          task_id:  { type: "string", description: "The task ID from list_tasks" },
          title:    { type: "string", description: "New title" },
          notes:    { type: "string", description: "New or updated notes" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          due_date: { type: "string", description: "New due date in YYYY-MM-DD format" },
          status:   { type: "string", enum: ["pending", "in_progress", "done"] },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark a task as done. Get the task_id from list_tasks first.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task ID from list_tasks" },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Permanently remove a task. Get the task_id from list_tasks first.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task ID from list_tasks" },
        },
        required: ["task_id"],
      },
    },
  },
  // ── Monitors ──────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "add_monitor",
      description: "Watch a URL or keyword for changes. When content changes, the user gets a Telegram notification automatically. Use for: watching a product page, tracking a news topic, monitoring a competitor site.",
      parameters: {
        type: "object",
        properties: {
          type:   { type: "string", enum: ["url", "keyword"], description: "url: watch a webpage for changes. keyword: watch news for a search term." },
          target: { type: "string", description: "The URL to watch, or the keyword/phrase to track in news" },
          label:  { type: "string", description: "Friendly name for this monitor, e.g. 'Tesla stock news' or 'iPhone 17 price drop'" },
        },
        required: ["type", "target", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_monitors",
      description: "List all active monitors — URLs and keywords being watched for changes.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_monitor",
      description: "Stop watching a URL or keyword. Get the monitor_id from list_monitors first.",
      parameters: {
        type: "object",
        properties: {
          monitor_id: { type: "string", description: "The monitor ID from list_monitors" },
        },
        required: ["monitor_id"],
      },
    },
  },
  // ── Projects ──────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a multi-step autonomous project. The agent breaks the goal into sub-tasks and executes them automatically in the background every 30 minutes, reporting progress via Telegram. Use for goals that take multiple steps or research phases to complete.",
      parameters: {
        type: "object",
        properties: {
          title:    { type: "string", description: "Short project name" },
          goal:     { type: "string", description: "Full description of what needs to be accomplished" },
          deadline: { type: "string", description: "Optional deadline in YYYY-MM-DD format" },
        },
        required: ["title", "goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List autonomous projects and their progress.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["active", "done", "failed", "all"], description: "Default: active" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project",
      description: "Get full details of a project including all task results. Use when user wants to see what the agent found or produced.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project ID from list_projects" },
        },
        required: ["project_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_project",
      description: "Cancel and remove a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The project ID from list_projects" },
        },
        required: ["project_id"],
      },
    },
  },
  // ── Sub-agents ────────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Delegate a focused task to a specialist sub-agent and get the result back. Use when a task benefits from a dedicated specialist: deep research, writing a document, running code analysis, or producing a structured report. The sub-agent runs independently with its own tool access.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["researcher", "coder", "analyst", "writer"],
            description: "researcher: deep web research and synthesis. coder: write and execute code. analyst: compare, evaluate, and recommend. writer: draft documents, emails, or reports.",
          },
          task:    { type: "string", description: "Clear description of what the specialist should do" },
          context: { type: "string", description: "Optional background context or data the specialist needs" },
        },
        required: ["role", "task"],
      },
    },
  },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

async function executeTool(name, args, userId = "default") {
  switch (name) {
    case "web_search":        return await webSearch(args.query);
    case "write_and_run_js":  return await writeAndRunJs(args.task);
    case "get_stock_price":   return await getStockPrice(args.symbol);
    case "get_crypto_price":  return await getCryptoPrice(args.coin);
    case "set_price_alert":   return await setPriceAlert(args.symbol, args.type, args.condition, args.target);
    case "fetch_readable":     return await fetchReadable(args.url);
    case "fetch_jina":         return await fetchJina(args.url);
    case "fetch_browserless":  return await fetchBrowserless(args.url, args.script);
    case "read_uploaded_file":return await readUploadedFile(args.filename);
    case "plan_task":         return planTask(args.task, args.steps);
    // Task inbox
    case "create_task": {
      const { createTask } = require("./tasks");
      const task = await createTask(userId, args);
      return `Task created: "${task.title}" [${task.priority} priority]${task.due_date ? ` — due ${task.due_date}` : ""}. ID: ${task.id}`;
    }
    case "list_tasks": {
      const { listTasks } = require("./tasks");
      const tasks = await listTasks(userId, args.filter || "pending");
      if (!tasks.length) return args.filter === "overdue" ? "No overdue tasks." : "No tasks found.";
      const now = new Date();
      return tasks.map((t, i) => {
        const overdue = t.due_date && new Date(t.due_date) < now && t.status !== "done" ? " ⚠️ OVERDUE" : "";
        const due = t.due_date ? ` | due ${t.due_date}${overdue}` : "";
        const notes = t.notes ? `\n   Notes: ${t.notes}` : "";
        return `${i + 1}. [${t.priority.toUpperCase()}] ${t.status === "done" ? "✅ " : ""}${t.title}${due}\n   ID: ${t.id}${notes}`;
      }).join("\n\n");
    }
    case "update_task": {
      const { updateTask } = require("./tasks");
      const { task_id, ...updates } = args;
      const task = await updateTask(userId, task_id, updates);
      if (!task) return `Task ${task_id} not found.`;
      return `Updated: "${task.title}" — status: ${task.status}, priority: ${task.priority}${task.due_date ? `, due: ${task.due_date}` : ""}`;
    }
    case "complete_task": {
      const { updateTask } = require("./tasks");
      const task = await updateTask(userId, args.task_id, { status: "done" });
      if (!task) return `Task ${args.task_id} not found.`;
      return `✅ Marked complete: "${task.title}"`;
    }
    case "delete_task": {
      const { deleteTask } = require("./tasks");
      const deleted = await deleteTask(userId, args.task_id);
      return deleted ? `Deleted task ${args.task_id}.` : `Task ${args.task_id} not found.`;
    }
    // Monitors
    case "add_monitor": {
      const { addMonitor } = require("./monitor");
      const mon = await addMonitor(userId, args);
      return `Monitor created: "${mon.label}" watching ${mon.type === "url" ? mon.target : `keyword "${mon.target}"`}. ID: ${mon.id}`;
    }
    case "list_monitors": {
      const { listMonitors } = require("./monitor");
      const monitors = await listMonitors(userId);
      if (!monitors.length) return "No active monitors.";
      return monitors.map((m, i) =>
        `${i + 1}. [${m.type}] ${m.label}\n   Target: ${m.target}\n   Last checked: ${m.last_checked || "never"}\n   ID: ${m.id}`
      ).join("\n\n");
    }
    case "delete_monitor": {
      const { deleteMonitor } = require("./monitor");
      const deleted = await deleteMonitor(userId, args.monitor_id);
      return deleted ? `Deleted monitor ${args.monitor_id}.` : `Monitor ${args.monitor_id} not found.`;
    }
    // Projects
    case "create_project": {
      const { createProject } = require("./projects");
      const project = await createProject(userId, args);
      const taskList = project.tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
      return `Project created: "${project.title}"\n\nBreaking it into ${project.tasks.length} tasks:\n${taskList}\n\nID: ${project.id}\n\nI'll work through these automatically every 30 minutes and update you on progress.`;
    }
    case "list_projects": {
      const { listProjects } = require("./projects");
      const projects = await listProjects(userId, args.filter || "active");
      if (!projects.length) return "No projects found.";
      return projects.map((p, i) => {
        const done = p.tasks.filter(t => t.status === "done").length;
        const total = p.tasks.length;
        const bar = `${done}/${total} tasks done`;
        return `${i + 1}. [${p.status.toUpperCase()}] ${p.title}\n   ${bar}${p.deadline ? ` | deadline: ${p.deadline}` : ""}\n   ID: ${p.id}`;
      }).join("\n\n");
    }
    case "get_project": {
      const { getProject } = require("./projects");
      const project = await getProject(userId, args.project_id);
      if (!project) return `Project ${args.project_id} not found.`;
      const tasks = project.tasks.map((t, i) => {
        const status = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : t.status === "in_progress" ? "⏳" : "⬜";
        const result = t.result ? `\n   Result: ${t.result.slice(0, 300)}${t.result.length > 300 ? "..." : ""}` : "";
        return `${status} ${i + 1}. ${t.title}${result}`;
      }).join("\n\n");
      return `Project: ${project.title}\nGoal: ${project.goal}\nStatus: ${project.status}\n\nTasks:\n${tasks}`;
    }
    case "delete_project": {
      const { deleteProject } = require("./projects");
      const deleted = await deleteProject(userId, args.project_id);
      return deleted ? `Project ${args.project_id} deleted.` : `Project ${args.project_id} not found.`;
    }
    // Sub-agents
    case "spawn_agent": {
      const { runSubAgent } = require("./subagent");
      const result = await runSubAgent(args.role, args.task, args.context || "", userId);
      return result;
    }
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

// ── Plain HTTP fetch ──────────────────────────────────────────────────────────
async function fetchReadable(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bot/1.0)" },
      timeout: 15_000,
      maxContentLength: 2_000_000,
    });
    const text = String(res.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return safeSlice(text, 8000);
  } catch (err) {
    return `fetch_readable failed: ${err.response?.status || ""} ${err.message}`;
  }
}

// ── Jina Reader ───────────────────────────────────────────────────────────────
async function fetchJina(url) {
  try {
    const res = await axios.get(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
      timeout: 30_000,
    });
    return safeSlice(String(res.data), 8000);
  } catch (err) {
    return `Jina fetch failed: ${err.response?.status || ""} ${err.message}`;
  }
}

// ── Browserless ───────────────────────────────────────────────────────────────
async function fetchBrowserless(url, script = null) {
  if (!process.env.BROWSERLESS_API_KEY) return "Browserless not configured (BROWSERLESS_API_KEY missing).";
  try {
    if (script) {
      // Run a custom Puppeteer function and return its result
      const res = await axios.post(
        `https://chrome.browserless.io/function?token=${process.env.BROWSERLESS_API_KEY}`,
        {
          code: `module.exports = async ({ page }) => {
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle2', timeout: 20000 });
  return { data: await page.evaluate(() => { ${script} }) };
}`,
        },
        { timeout: 40_000, headers: { "Content-Type": "application/json" } }
      );
      return safeSlice(JSON.stringify(res.data), 8000);
    }
    // Default: return rendered page content
    const res = await axios.post(
      `https://chrome.browserless.io/content?token=${process.env.BROWSERLESS_API_KEY}`,
      { url, waitFor: 2000 },
      { timeout: 40_000, headers: { "Content-Type": "application/json" } }
    );
    return safeSlice(String(res.data), 8000);
  } catch (err) {
    return `Browserless fetch failed: ${err.response?.status || ""} ${err.message}`;
  }
}

// ── Web search ────────────────────────────────────────────────────────────────
async function webSearch(query) {
  // 1. Tavily
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
      if (results) return results;
    } catch (err) {
      console.error(`[Tavily] Error: ${err.response?.status} ${err.response?.data?.message || err.message}`);
    }
    console.log("[Tavily] Falling back to Brave...");
  }

  // 2. Brave Search
  if (process.env.BRAVE_API_KEY) {
    try {
      const res = await axios.get("https://api.search.brave.com/res/v1/web/search", {
        params: { q: query, count: 5 },
        headers: {
          "X-Subscription-Token": process.env.BRAVE_API_KEY,
          Accept: "application/json",
        },
        timeout: 10_000,
      });
      const results = (res.data.web?.results || [])
        .map((r) => `[${r.title}]\n${r.url}\n${r.description || ""}`)
        .join("\n\n");
      if (results) return results;
    } catch (err) {
      console.error(`[Brave] Error: ${err.response?.status} ${err.message}`);
    }
    console.log("[Brave] Falling back to DuckDuckGo...");
  }

  // 3. DuckDuckGo (last resort — limited results)
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

// Delegates actual code generation to a separate model as a plain text
// completion -- the main agent model only has to pass a short natural-
// language task description as its tool argument, never a long escape-heavy
// code string. Sidesteps a suspected bug where the main model (tencent/
// hy3-preview) can't reliably self-encode code within its own structured
// tool-call output once "starts to code" (per user report).
//
// Primary is a dedicated coding specialist; falls back to a second, unrelated
// model (different provider pool entirely) if the primary fails, rather than
// just giving up -- cheap insurance since both are inexpensive/free.
const CODE_MODEL_PRIMARY = process.env.OPENROUTER_CODE_MODEL || "qwen/qwen3-coder-flash";
const CODE_MODEL_FALLBACK = process.env.OPENROUTER_CODE_MODEL_FALLBACK || "nvidia/nemotron-3-ultra-550b-a55b:free";

async function generateCode(task, model) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [{
        role: "user",
        content: `Write Node.js code to accomplish this task. Output ONLY the code -- no explanation, no markdown code fences.\n\nTask: ${task}`,
      }],
      max_tokens: 2048,
    },
    {
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  const code = res.data?.choices?.[0]?.message?.content;
  if (!code) throw new Error("no response from code model");
  return code.replace(/^```(?:js|javascript|node)?\n?/i, "").replace(/```\s*$/, "").trim();
}

async function writeAndRunJs(task) {
  let code;
  try {
    code = await generateCode(task, CODE_MODEL_PRIMARY);
  } catch (err) {
    console.warn(`[write_and_run_js] primary model (${CODE_MODEL_PRIMARY}) failed: ${err.response?.data?.error?.message || err.message} -- trying fallback`);
    try {
      code = await generateCode(task, CODE_MODEL_FALLBACK);
    } catch (err2) {
      return `Code generation failed on both models: ${err2.response?.data?.error?.message || err2.message}`;
    }
  }
  return runJs(code);
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
