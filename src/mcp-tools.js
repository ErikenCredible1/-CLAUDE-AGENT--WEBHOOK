const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { safeSlice } = require("./safe-slice");

const WORK_DIR = path.join(__dirname, "../workspace");
const BIN_DIR = path.join(__dirname, "../node_modules/.bin");
const LOCAL_BIN_DIR = path.join(__dirname, "../bin");

// Servers are real package.json dependencies (resolved once at build time),
// spawned via their already-installed local bin -- not `npx`. On Render's
// free tier, npx's runtime package-resolution + download was slow enough that
// 4 servers starting at once all hit the SDK's request timeout (CPU-starved
// free-tier instance); a local binary spawn needs no network call at all.
//
// Lightweight/network-bound MCP servers only — Playwright MCP needs browser
// binaries (~200MB+ disk, 1GB+ RAM) and is not viable on Render's free tier.
// Kiwi.com has no standalone npm package (hosted/connector-only) — deferred.
const MCP_SERVERS = [
  {
    name: "filesystem",
    command: path.join(BIN_DIR, "mcp-server-filesystem"),
    args: [WORK_DIR],
    requiredEnv: [],
  },
  {
    name: "sequential-thinking",
    command: path.join(BIN_DIR, "mcp-server-sequential-thinking"),
    args: [],
    requiredEnv: [],
  },
  {
    name: "fetch",
    command: path.join(BIN_DIR, "mcp-fetch-server"), // also covers YouTube transcripts (fetch_youtube_transcript)
    args: [],
    requiredEnv: [],
  },
  {
    name: "firecrawl",
    command: path.join(BIN_DIR, "firecrawl-mcp"),
    args: [],
    requiredEnv: ["FIRECRAWL_API_KEY"],
    // firecrawl-mcp exposes ~15 tools (crawl, agent, monitor_*, search, ...) on
    // a shared monthly credit pool. Only allow the two cheap, predictable ones
    // (1 credit/page, single call) -- crawl/agent/monitor can each burn a large
    // chunk of the budget in one model-initiated call, and search just
    // duplicates the already-free Tavily web_search.
    allowedTools: ["firecrawl_scrape", "firecrawl_map"],
  },
  {
    name: "lightpanda",
    command: path.join(LOCAL_BIN_DIR, "lightpanda"),
    args: ["mcp"],
    requiredEnv: [],
    lazy: true,
    // Real interactive browser automation (click, fill forms, evaluate JS) --
    // viable on Render's free tier specifically because Lightpanda is a
    // from-scratch browser engine, not a Chromium wrapper: ~123MB peak memory
    // for 100 pages vs. Chrome's ~2GB for the same load. Binary is downloaded
    // at `npm install` time (scripts/download-lightpanda.js), not at runtime.
    // Beta software per its own docs -- may error/crash on complex sites;
    // startOneServer's try/catch already isolates failures from the rest of
    // the app, same as every other server here.
    // lazy: true (2026-06-21) -- only spawned on first actual use (via
    // enable_browser_automation in agent.js) instead of held in memory for
    // the entire process lifetime. Render free-tier memory pressure from
    // running this many persistent child processes caused a real OOM crash.
  },
  {
    name: "flights",
    command: path.join(BIN_DIR, "google-flights-mcp-server"),
    args: [],
    requiredEnv: [],
    lazy: true, // see lightpanda's note above -- same reasoning
    // Talks to Google Flights' own backend protobuf API directly -- no
    // browser, no API key, no scraping. This is what real flight search
    // (search_flights, get_date_grid, find_airport_code) ended up being,
    // after Lightpanda failed on every aggregator/airline site tried
    // (Kayak crash-looped on a WASM JS exception, Skyscanner CAPTCHA-walled
    // immediately, Google Flights/United hit missing-API/compatibility
    // walls) -- sidesteps all of that since there's no browser rendering
    // involved at all, just a direct API call the same way the real site
    // makes internally.
  },
];

const mcpClients = new Map();     // serverName -> Client
const mcpToolIndex = new Map();   // toolName -> { serverName, definition }
const startPromises = new Map();  // serverName -> in-flight/completed start Promise (for lazy servers)

async function startOneServer(cfg) {
  const missingEnv = cfg.requiredEnv.filter((k) => !process.env[k]);
  if (missingEnv.length) {
    console.warn(`[MCP] Skipping "${cfg.name}" — missing env: ${missingEnv.join(", ")}`);
    return;
  }
  try {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: process.env,
    });
    const client = new Client({ name: "telegram-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const { tools: allTools } = await client.listTools();
    const tools = cfg.allowedTools ? allTools.filter((t) => cfg.allowedTools.includes(t.name)) : allTools;
    for (const tool of tools) {
      mcpToolIndex.set(tool.name, {
        serverName: cfg.name,
        definition: {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || `MCP tool from ${cfg.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} },
          },
        },
      });
    }
    mcpClients.set(cfg.name, client);
    console.log(`[MCP] "${cfg.name}" started — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    console.error(`[MCP] "${cfg.name}" failed to start: ${err.message} — continuing without it`);
  }
}

// Each eager server is an independent npx cold-start (10-15s+ on an unwarmed
// cache, e.g. after Render's free-tier idle spindown) — run them in parallel
// so total startup time is the slowest single server, not the sum of all.
// lazy: true servers are skipped here entirely -- see ensureServerStarted.
async function startMcpServers() {
  await Promise.all(MCP_SERVERS.filter((cfg) => !cfg.lazy).map(startOneServer));
}

// Idempotent -- safe to call repeatedly or concurrently for the same server;
// they share one in-flight start instead of double-spawning. Returns the
// tool names that became available (empty if already running or it failed
// to start), so the caller can unlock them for the rest of the current turn.
async function ensureServerStarted(serverName) {
  const cfg = MCP_SERVERS.find((c) => c.name === serverName);
  if (!cfg) throw new Error(`Unknown MCP server "${serverName}"`);
  if (mcpClients.has(serverName)) return [];

  if (!startPromises.has(serverName)) {
    startPromises.set(serverName, startOneServer(cfg));
  }
  await startPromises.get(serverName);
  return [...mcpToolIndex.values()].filter((e) => e.serverName === serverName).map((e) => e.definition.function.name);
}

function getMcpToolDefinitions() {
  return [...mcpToolIndex.values()].map((entry) => entry.definition);
}

async function executeMcpTool(name, args) {
  const entry = mcpToolIndex.get(name);
  if (!entry) return null; // not an MCP tool
  const client = mcpClients.get(entry.serverName);
  if (!client) return `MCP server "${entry.serverName}" is not available.`;
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return safeSlice(text || JSON.stringify(result), 8000);
  } catch (err) {
    return `MCP tool error (${name}): ${err.message}`;
  }
}

module.exports = { startMcpServers, getMcpToolDefinitions, executeMcpTool, ensureServerStarted };
