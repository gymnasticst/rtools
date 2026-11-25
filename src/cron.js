// Scheduled tasks: 5-field cron expressions stored in ~/.rtools/cron.json.
// Each task runs a prompt through the agent when it comes due (checked while
// the REPL is running) — openclaude ScheduleCronTool-style, but persisted and
// manageable from the REPL with /cron.

// Parse a 5-field cron expression into [min, hour, dom, mon, dow] number sets.
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields (min hour dom mon dow), got: ${expr}`);
  const expand = (f, max, name) => {
    const out = new Set();
    for (const part of f.split(",")) {
      const [range, stepStr] = part.split("/");
      const step = stepStr ? Number(stepStr) : 1;
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${name}: ${part}`);
      let lo = 0, hi = max - 1;
      if (range !== "*") {
        const [a, b] = range.split("-");
        lo = Number(a); hi = b === undefined ? Number(a) : Number(b);
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) throw new Error(`bad range in ${name}: ${part}`);
        if (hi > max - 1) throw new Error(`${name} out of range (0-${max - 1}): ${part}`);
      }
      for (let v = lo; v <= hi; v += step) {
        if (v > max - 1) break;
        out.add(v);
      }
    }
    if (!out.size) throw new Error(`empty field ${name}: ${f}`);
    return out;
  };
  return [
    expand(fields[0], 60, "minute"),
    expand(fields[1], 24, "hour"),
    expand(fields[2], 31, "day-of-month"),
    expand(fields[3], 12, "month"),
    expand(fields[4], 7, "day-of-week"),
  ];
}

// Next minute boundary strictly after `from` matching the expression.
export function nextRun(cron, from = new Date()) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(cron, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error("no matching time within a year");
}

export function cronMatches(cron, date = new Date()) {
  const [mins, hrs, doms, mons, dows] = cron;
  if (!mins.has(date.getMinutes()) || !hrs.has(date.getHours()) || !mons.has(date.getMonth() + 1)) return false;
  const domOk = doms.has(date.getDate());
  const dowOk = dows.has(date.getDay());
  if (doms.size >= 31) return dowOk;
  if (dows.size >= 7) return domOk;
  return domOk || dowOk;
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = () => path.join(os.homedir(), ".rtools", "cron.json");

export function listCronTasks() {
  try {
    if (!existsSync(FILE())) return [];
    const parsed = JSON.parse(readFileSync(FILE(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCronTasks(tasks) {
  mkdirSync(path.dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(tasks, null, 2));
}

// Adds a task: { name, cron, prompt, next_at (ISO) }. Returns the task.
export function addCronTask({ name, cronExpr, prompt, from = new Date() }) {
  if (!name || !prompt) throw new Error("cron task needs a name and a prompt");
  const fields = parseCron(cronExpr);
  const tasks = listCronTasks().filter((t) => t.name !== name);
  const task = { name, cron: cronExpr, prompt, next_at: nextRun(fields, from).toISOString() };
  tasks.push(task);
  saveCronTasks(tasks);
  return task;
}

export function removeCronTask(name) {
  const tasks = listCronTasks();
  const kept = tasks.filter((t) => t.name !== name);
  saveCronTasks(kept);
  return kept.length !== tasks.length;
}

// Tasks whose next_at has passed; re-arms each with a fresh next run.
export function dueCronTasks(now = new Date()) {
  const tasks = listCronTasks();
  const due = [];
  for (const t of tasks) {
    let fields;
    try { fields = parseCron(t.cron); } catch { continue; }
    if (t.next_at && new Date(t.next_at) <= now) {
      due.push(t);
      t.next_at = nextRun(fields, now).toISOString();
    }
  }
  if (due.length) saveCronTasks(tasks);
  return due;
}
