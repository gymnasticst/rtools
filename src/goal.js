// Goal mode: a long-lived objective persisted in ~/.rtools/goal.json. The
// agent gets the goal and its status in every system prompt; /goal tracks,
// pauses and closes it. Progress is a short status the agent updates with the
// goal_status tool.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = () => path.join(os.homedir(), ".rtools", "goal.json");

export function loadGoal() {
  try {
    if (!existsSync(FILE())) return null;
    const g = JSON.parse(readFileSync(FILE(), "utf8"));
    return g && g.text ? g : null;
  } catch {
    return null;
  }
}

export function saveGoal(goal) {
  mkdirSync(path.dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(goal, null, 2));
}

export function clearGoal() {
  try { existsSync(FILE()) && writeFileSync(FILE(), JSON.stringify({ state: "none" })); } catch {}
}

export function setGoal(text) {
  const goal = { text, state: "active", status: "just started", updated_at: new Date().toISOString() };
  saveGoal(goal);
  return goal;
}

export function updateGoalStatus(status, state) {
  const goal = loadGoal();
  if (!goal) return null;
  if (state && !["active", "paused", "done", "blocked"].includes(state)) throw new Error(`bad goal state: ${state}`);
  goal.status = String(status || goal.status).slice(0, 300);
  if (state) goal.state = state;
  goal.updated_at = new Date().toISOString();
  saveGoal(goal);
  return goal;
}

// Rendering for the system prompt (empty string when no active goal).
export function goalPromptSection() {
  const g = loadGoal();
  if (!g || g.state !== "active") return "";
  return [
    "",
    "# Active goal",
    g.text,
    `Status: ${g.status}`,
    "Work toward the goal; update progress with the goal_status tool when it changes materially.",
  ].join("\n");
}

export function goalTools() {
  return [
    {
      name: "goal_status",
      kind: "read",
      description:
        "Update the status of the active session goal (set via /goal). Pass state=done when the goal is " +
        "fully achieved, state=blocked when something outside your control stops it.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "One-line progress summary" },
          state: { type: "string", enum: ["active", "paused", "done", "blocked"] },
        },
        required: ["status"],
      },
      handler: async ({ status, state }) => {
        const g = updateGoalStatus(status, state);
        return g ? `goal state: ${g.state} — ${g.status}` : "Error: no active goal (set one with /goal <text>)";
      },
    },
  ];
}
