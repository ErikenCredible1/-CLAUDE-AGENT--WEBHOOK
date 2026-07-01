const { Redis } = require("@upstash/redis");
const { randomBytes } = require("crypto");
const axios = require("axios");

function getRedis() {
  return new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
}

function projKey(userId) { return `projects:${userId}`; }
function newId(prefix) { return `${prefix}_` + randomBytes(6).toString("hex"); }
function parse(v) {
  try { return typeof v === "string" ? JSON.parse(v) : v; }
  catch { return null; }
}

async function createProject(userId, { title, goal, deadline }) {
  const tasks = await generateTasks(goal);
  const id = newId("proj");
  const now = new Date().toISOString();
  const project = {
    id, title, goal,
    deadline: deadline || null,
    tasks,
    status: "in_progress",
    created_at: now,
    updated_at: now,
  };
  const redis = getRedis();
  await redis.hset(projKey(userId), { [id]: JSON.stringify(project) });
  return project;
}

async function generateTasks(goal) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: process.env.OPENROUTER_MODEL || "tencent/hy3-preview",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Break this goal into 3–6 concrete, executable sub-tasks an AI agent can work on independently.
Return ONLY a JSON array of task title strings. No explanations.
Example: ["Research current options", "Compare top 5 results", "Write final recommendation"]

Goal: ${goal}`,
      }],
    },
    { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
  );

  const content = res.data?.choices?.[0]?.message?.content || "[]";
  const match = content.match(/\[[\s\S]*?\]/);
  const titles = match ? JSON.parse(match[0]) : [goal];

  return titles.map((title, i) => ({
    id: newId("ptask"),
    title: String(title),
    order: i + 1,
    status: "pending",
    result: null,
    started_at: null,
    completed_at: null,
  }));
}

async function listProjects(userId, filter = "active") {
  const redis = getRedis();
  const raw = await redis.hgetall(projKey(userId));
  if (!raw) return [];
  const all = Object.values(raw).map(parse).filter(Boolean);
  if (filter === "active")    return all.filter(p => p.status === "in_progress");
  if (filter === "done")      return all.filter(p => p.status === "done");
  if (filter === "failed")    return all.filter(p => p.status === "failed");
  return all;
}

async function getProject(userId, projectId) {
  const redis = getRedis();
  const raw = await redis.hget(projKey(userId), projectId);
  return raw ? parse(raw) : null;
}

async function saveProject(userId, project) {
  const redis = getRedis();
  project.updated_at = new Date().toISOString();
  await redis.hset(projKey(userId), { [project.id]: JSON.stringify(project) });
}

async function deleteProject(userId, projectId) {
  const redis = getRedis();
  return (await redis.hdel(projKey(userId), projectId)) > 0;
}

// Called by the auto-executor interval — runs one pending task per project
async function executeNextTasks(userId, sendFn) {
  const projects = await listProjects(userId, "active");

  for (const project of projects) {
    const next = project.tasks.find(t => t.status === "pending");
    if (!next) {
      // All tasks done — mark project complete
      project.status = "done";
      await saveProject(userId, project);
      await sendFn(userId, `✅ Project complete: "${project.title}"\n\nAll ${project.tasks.length} tasks finished. Ask me for a summary or to see the results.`);
      continue;
    }

    // Mark task in_progress
    next.status = "in_progress";
    next.started_at = new Date().toISOString();
    await saveProject(userId, project);

    try {
      const { runSubAgent, detectRole } = require("./subagent");
      const role = detectRole(next.title);
      console.log(`[project] executing "${next.title}" with ${role} sub-agent`);

      const context = project.tasks
        .filter(t => t.status === "done" && t.result)
        .map(t => `Task: ${t.title}\nResult: ${t.result}`)
        .join("\n\n");

      const result = await runSubAgent(role, `${next.title}\n\nProject goal: ${project.goal}`, context, userId);

      next.status = "done";
      next.result = result.slice(0, 3000);
      next.completed_at = new Date().toISOString();

      const remaining = project.tasks.filter(t => t.status === "pending").length - 1;
      await saveProject(userId, project);

      await sendFn(userId,
        `🔄 Project: "${project.title}"\n✅ Finished: ${next.title}\n${remaining > 0 ? `⏳ ${remaining} task(s) remaining` : "⏳ Final task — wrapping up next cycle"}`
      );
    } catch (err) {
      console.error(`[project] task failed: ${err.message}`);
      next.status = "failed";
      next.result = `Error: ${err.message}`;
      next.completed_at = new Date().toISOString();
      project.status = "failed";
      await saveProject(userId, project);
      await sendFn(userId, `❌ Project "${project.title}" — task failed: ${next.title}\n${err.message}`);
    }
  }
}

// Run auto-execution for all users with active projects
async function runAllProjectTasks(sendFn) {
  const redis = getRedis();
  const keys = await redis.keys("projects:*");
  for (const key of keys) {
    const userId = key.replace("projects:", "");
    try {
      await executeNextTasks(userId, sendFn);
    } catch (err) {
      console.error(`[project] auto-exec error for ${userId}:`, err.message);
    }
  }
}

module.exports = { createProject, listProjects, getProject, saveProject, deleteProject, runAllProjectTasks };
