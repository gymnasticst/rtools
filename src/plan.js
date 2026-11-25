// update_plan tool + rendering, Codex-style
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PLANS_DIR = () => path.join(process.env.HOME || "/tmp", ".rtools", "plans");

export function updatePlanTool({ state }) {
  return {
    name: "update_plan",
    kind: "read",
    description:
      "Create or update a step-by-step task plan that the user can see. Provide the full list of steps each time, " +
      "exactly one step with status 'in_progress', others 'pending' or 'done'.",
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "One-line summary of the plan state" },
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["plan"],
    },
    handler: async ({ explanation, plan }) => {
      const inProgress = plan.filter((s) => s.status === "in_progress").length;
      if (inProgress !== 1) return `Error: exactly one step must be in_progress (got ${inProgress})`;
      state.plan = plan.map((s) => ({ step: s.step, status: s.status }));
      if (explanation) state.planExplanation = explanation;
      renderPlan(state.plan, explanation);
      try {
        mkdirSync(PLANS_DIR(), { recursive: true });
        writeFileSync(path.join(PLANS_DIR(), "current.json"), JSON.stringify(state.plan, null, 2));
      } catch {
        // best-effort persistence
      }
      return "Plan updated.";
    },
  };
}

export function renderPlan(plan, explanation) {
  const icons = { pending: "○", in_progress: "◐", done: "●" };
  console.log("\n  plan" + (explanation ? ` — ${explanation}` : ""));
  for (const s of plan) console.log(`  ${icons[s.status] || "○"} ${s.step}`);
  console.log("");
}

export function loadPersistedPlan() {
  try {
    const file = path.join(PLANS_DIR(), "current.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}
