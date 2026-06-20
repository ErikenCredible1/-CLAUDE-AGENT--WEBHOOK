const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const WORK_DIR = path.join(__dirname, "../workspace");
const BIN_DIR = path.join(__dirname, "../node_modules/.bin");

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
    name: "airbnb",
    command: path.join(BIN_DIR, "mcp-server-airbnb"),
    args: [],
    requiredEnv: [],
  },
  {
    name: "google-maps",
    command: path.join(BIN_DIR, "mcp-server-google-maps"),
    args: [],
    requiredEnv: ["GOOGLE_MAPS_API_KEY"],
  },
  {
    name: "firecrawl",
    command: path.join(BIN_DIR, "firecrawl-mcp"),
    args: [],
    requiredEnv: ["FIRECRAWL_API_KEY"],
  },
  {
    name: "notion",
    command: path.join(BIN_DIR, "notion-mcp-server"),
    args: [],
    requiredEnv: ["NOTION_TOKEN"],
  },
];

const mcpClients = new Map();   // serverName -> Client
const mcpToolIndex = new Map(); // toolName -> { serverName, definition }

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

    const { tools } = await client.listTools();
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

// Each server is an independent npx cold-start (10-15s+ on an unwarmed cache,
// e.g. after Render's free-tier idle spindown) — run them in parallel so total
// startup time is the slowest single server, not the sum of all of them.
async function startMcpServers() {
  await Promise.all(MCP_SERVERS.map(startOneServer));
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
    return (text || JSON.stringify(result)).slice(0, 8000);
  } catch (err) {
    return `MCP tool error (${name}): ${err.message}`;
  }
}

module.exports = { startMcpServers, getMcpToolDefinitions, executeMcpTool };
