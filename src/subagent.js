const axios = require("axios");
const { executeTool, TOOL_DEFINITIONS } = require("./tools");

const ROLE_PROMPTS = {
  researcher: `You are a research specialist. Thoroughly research the given topic using web search and fetch tools. Return a comprehensive, well-structured report with key findings and sources. Be factual and complete.`,
  coder: `You are a coding specialist. Write and execute the code needed to complete the task. Return the output, a brief explanation of what the code did, and any relevant results or findings.`,
  analyst: `You are a data analyst. Analyze the provided information and return structured insights, comparisons, and a clear recommendation. Be precise, data-driven, and concise.`,
  writer: `You are a writing specialist. Produce the requested content — emails, reports, summaries, or documents. Be clear, well-structured, and tailored to the stated purpose. Return only the finished piece.`,
};

const ROLE_TOOLS = {
  researcher: ["web_search", "fetch_readable", "fetch_jina", "fetch_browserless"],
  coder:      ["write_and_run_js", "fetch_readable"],
  analyst:    ["web_search", "fetch_readable", "write_and_run_js"],
  writer:     [],
};

function getRoleTools(role) {
  const allowed = new Set(ROLE_TOOLS[role] || ROLE_TOOLS.researcher);
  return TOOL_DEFINITIONS.filter(t => allowed.has(t.function.name));
}

async function runSubAgent(role, task, context = "", userId = "system") {
  const systemPrompt = ROLE_PROMPTS[role] || ROLE_PROMPTS.researcher;
  const tools = getRoleTools(role);
  const model = process.env.OPENROUTER_MODEL || "tencent/hy3-preview";

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: context ? `Context:\n${context}\n\nTask:\n${task}` : task },
  ];

  const MAX_TURNS = 10;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = { model, messages, max_tokens: 4000 };
    if (tools.length) body.tools = tools;

    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      body,
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, timeout: 60_000 }
    );

    const msg = res.data?.choices?.[0]?.message;
    if (!msg) throw new Error("Sub-agent got empty response");

    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return msg.content || "(no output)";
    }

    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
        result = await executeTool(call.function.name, args, userId);
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 8000) });
    }
  }

  return "(sub-agent reached turn limit without finishing)";
}

function detectRole(taskTitle) {
  const t = taskTitle.toLowerCase();
  if (/\b(code|script|calculate|compute|run|program|function)\b/.test(t)) return "coder";
  if (/\b(analyz|compar|report|evaluat|assess|rank|score)\b/.test(t)) return "analyst";
  if (/\b(write|draft|email|document|summar|compose|create.*content)\b/.test(t)) return "writer";
  return "researcher";
}

module.exports = { runSubAgent, detectRole };
