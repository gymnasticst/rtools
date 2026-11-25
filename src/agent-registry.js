// Live registry of sub-agent activity (delegate / team members). The tools
// record real events here; the /agents TUI panel reads them. In-memory only —
// it reflects the current session's sub-agents.

const MAX_EVENTS = 200;
const events = [];

export function agentStarted({ kind, name, task }) {
  const ev = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind, // "delegate" | "team"
    name: name || kind,
    task: String(task || "").slice(0, 120),
    state: "running", // running | done | error
    steps: 0,
    toolsUsed: [],
    startedAt: new Date().toISOString(),
    text: "",
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  return ev;
}

// event = return value of agentStarted
export function agentStep(ev, toolName) {
  if (!ev) return;
  ev.steps++;
  if (toolName && ev.toolsUsed[ev.toolsUsed.length - 1] !== toolName) {
    ev.toolsUsed.push(toolName);
    if (ev.toolsUsed.length > 12) ev.toolsUsed.shift();
  }
}

export function agentText(ev, delta) {
  if (!ev) return;
  ev.text = (ev.text + String(delta || "")).slice(-2000);
}

export function agentFinished(ev, { error = null } = {}) {
  if (!ev) return;
  ev.state = error ? "error" : "done";
  ev.error = error ? String(error).slice(0, 200) : null;
  ev.finishedAt = new Date().toISOString();
}

export function agentEvents({ limit = 40 } = {}) {
  return events.slice(-limit).reverse(); // newest first
}

export function runningAgents() {
  return events.filter((e) => e.state === "running");
}
