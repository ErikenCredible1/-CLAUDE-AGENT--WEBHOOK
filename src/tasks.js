const { Redis } = require("@upstash/redis");
const { randomBytes } = require("crypto");

function getRedis() {
  return new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
}

const PRIORITY = ["high", "medium", "low"];

function taskKey(userId) { return `tasks:${userId}`; }
function newId() { return "task_" + randomBytes(6).toString("hex"); }

function parse(v) {
  try { return typeof v === "string" ? JSON.parse(v) : v; }
  catch { return null; }
}

async function createTask(userId, { title, notes, priority = "medium", due_date }) {
  const redis = getRedis();
  const id = newId();
  const now = new Date().toISOString();
  const task = {
    id, title,
    notes: notes || null,
    priority: PRIORITY.includes(priority) ? priority : "medium",
    due_date: due_date || null,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
  await redis.hset(taskKey(userId), { [id]: JSON.stringify(task) });
  return task;
}

async function listTasks(userId, filter = "pending") {
  const redis = getRedis();
  const raw = await redis.hgetall(taskKey(userId));
  if (!raw) return [];

  const all = Object.values(raw).map(parse).filter(Boolean);
  const now = new Date();

  if (filter === "overdue") return all.filter(t => t.status !== "done" && t.due_date && new Date(t.due_date) < now);
  if (filter === "pending") return all.filter(t => t.status !== "done");
  if (filter === "done")    return all.filter(t => t.status === "done");
  return all;
}

async function updateTask(userId, taskId, updates) {
  const redis = getRedis();
  const raw = await redis.hget(taskKey(userId), taskId);
  if (!raw) return null;
  const task = parse(raw);
  const updated = { ...task, ...updates, updated_at: new Date().toISOString() };
  await redis.hset(taskKey(userId), { [taskId]: JSON.stringify(updated) });
  return updated;
}

async function deleteTask(userId, taskId) {
  const redis = getRedis();
  return (await redis.hdel(taskKey(userId), taskId)) > 0;
}

async function getOverdueTasks(userId) {
  return listTasks(userId, "overdue");
}

module.exports = { createTask, listTasks, updateTask, deleteTask, getOverdueTasks };
