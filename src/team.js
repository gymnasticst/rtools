// team tool: run 2-4 role-assigned sub-agents in parallel on the same repo
// (e.g. research / implement / review) and merge their reports.
import { runAgentLoop, systemPrompt, READ_KINDS } from "./agent.js";
import { agentStarted, agentStep, agentText, agentFinished } from "./agent-registry.js";

export function teamTool({ ctx, depth = 0 }) {
  return {
    name: "team",
    kind: "read",
    description:
      "Run a small parallel agent team. Each role gets a fresh sub-agent with its own context and works on the same task; " +
      "all reports are merged. Use for independent angles (research / implement / review). Sub-agents cannot ask questions.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Self-contained task for every team member" },
        roles: {
          type: "array",
          items: { type: "string" },
          description: "Role names, 2 to 4, e.g. [\"research\", \"implement\", \"review\"]",
        },
      },
      required: ["task", "roles"],
    },
    handler: async ({ task, roles }) => {
      if (depth >= 2) return "Error: team depth limit (2) reached.";
      const list = (roles || []).filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim().slice(0, 40));
      if (list.length > 4) return "Error: max 4 roles";
      if (list.length < 2) return "Error: give at least 2 roles (max 4)";
      const subTools = ctx.tools.filter((t) => t.name !== "delegate" && t.name !== "team");
      // Sub-agents cannot ask the user for approval: when the session is not
      // permissive, they get read-only tools only instead of a silent bypass.
      const permissive = (ctx.cfg.approval_policy ?? "untrusted") === "never";
      const allowed = permissive ? subTools : subTools.filter((t) => READ_KINDS.has(t.kind));
      const reports = await Promise.all(
        list.map(async (role) => {
          try {
            const messages = [
              {
                role: "system",
                content:
                  systemPrompt(ctx) +
                  `\n\nYou are the "${role}" member of a small agent team. Stay strictly in your role. Finish with a concise report.`,
              },
              { role: "user", content: task },
            ];
            let final = "";
            const ev = agentStarted({ kind: "team", name: role, task });
            try {
              await runAgentLoop({
                provider: ctx.provider,
                apiKey: ctx.apiKey,
                model: ctx.cfg.model,
                messages,
                tools: allowed,
                approval: "never",
                sandbox: ctx.cfg.sandbox_mode,
                maxSteps: 12,
                _depth: depth + 1,
                onText: (d) => { final += d; agentText(ev, d); },
                onToolUse: (tool) => agentStep(ev, tool?.name),
              });
              agentFinished(ev);
            } catch (e) {
              agentFinished(ev, { error: e.message });
              throw e;
            }
            return `## ${role}\n${final.trim().slice(0, 8000) || "(no text)"}`;
          } catch (e) {
            return `## ${role}\nError: ${e.message}`;
          }
        })
      );
      return reports.join("\n\n").slice(0, 24000);
    },
  };
}
