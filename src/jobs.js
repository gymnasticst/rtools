// Background jobs: long-running shell commands (tests, dev servers, builds)
// that outlive a single tool step. In-memory registry with a line ring buffer.
import { spawn } from "node:child_process";

const jobs = new Map();
const MAX_JOBS = 10;
const MAX_LINES = 500;

const summary = (j) => ({
  name: j.name,
  status: j.status,
  code: j.code,
  command: j.command,
  started_at: j.started,
  lines: j.lines.length,
});

export function listJobs() {
  return [...jobs.values()].map(summary);
}

export function startJob({ name, command, cwd }) {
  if (!name || typeof name !== "string") return { ok: false, error: "name is required" };
  if (!command || typeof command !== "string") return { ok: false, error: "command is required" };
  const existing = jobs.get(name);
  if (existing?.status === "running") return { ok: false, error: `job "${name}" is already running (stop it first)` };
  if (!existing && jobs.size >= MAX_JOBS) return { ok: false, error: `too many jobs (${MAX_JOBS}) — reuse a name or stop one` };
  const child = spawn("bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const job = { name, command, child, status: "running", code: null, lines: [], started: new Date().toISOString() };
  const push = (d) => {
    for (const l of String(d).split("\n")) {
      if (l) job.lines.push(l);
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("error", (e) => {
    job.status = "error";
    job.lines.push(`spawn error: ${e.message}`);
  });
  child.on("close", (code) => {
    if (job.status !== "error") {
      job.status = "exited";
      job.code = code;
    }
  });
  jobs.set(name, job);
  return { ok: true, job: summary(job) };
}

export function jobStatus(name) {
  if (name) {
    const j = jobs.get(name);
    return j ? summary(j) : null;
  }
  return listJobs();
}

export function jobLogs(name, lines = 40) {
  const j = jobs.get(name);
  if (!j) return null;
  return j.lines.slice(-lines);
}

export function stopJob(name) {
  const j = jobs.get(name);
  if (!j) return { ok: false, error: `no such job "${name}"` };
  if (j.status !== "running") return { ok: false, error: `job "${name}" is not running (${j.status})` };
  j.child.kill("SIGKILL");
  return { ok: true, job: summary(j) };
}

export function stopAllJobs() {
  for (const j of jobs.values()) if (j.status === "running") j.child.kill("SIGKILL");
}

// Tool wrapper: job start|status|logs|stop. kind "shell" → approval applies.
export function jobTool({ cwd }) {
  return {
    name: "job",
    kind: "shell",
    description:
      "Run a shell command as a background job that keeps running across steps " +
      "(tests, builds, dev servers). Subcommands: start <name> <command>, status [name], logs <name> [lines], stop <name>.",
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["start", "status", "logs", "stop"], description: "start | status | logs | stop" },
        name: { type: "string", description: "Job name" },
        command: { type: "string", description: "Shell command (start only)" },
        lines: { type: "integer", description: "How many log lines to show (default 40)" },
      },
      required: ["subcommand"],
    },
    handler: async ({ subcommand, name, command, lines = 40 }) => {
      if (subcommand === "start") {
        const r = startJob({ name, command, cwd });
        return r.ok ? `started job "${r.job.name}" (${r.job.status})` : `Error: ${r.error}`;
      }
      if (subcommand === "status") {
        const s = jobStatus(name);
        if (!s) return `no such job "${name}"`;
        const list = Array.isArray(s) ? s : [s];
        return list.map((j) => `${j.name}: ${j.status}${j.code != null ? ` (code ${j.code})` : ""} — ${j.command}`).join("\n") || "(no jobs)";
      }
      if (subcommand === "logs") {
        const out = jobLogs(name, lines);
        return out === null ? `no such job "${name}"` : out.join("\n") || "(no output yet)";
      }
      if (subcommand === "stop") {
        const r = stopJob(name);
        return r.ok ? `stopped "${name}"` : `Error: ${r.error}`;
      }
      return `Error: unknown subcommand "${subcommand}"`;
    },
  };
}
