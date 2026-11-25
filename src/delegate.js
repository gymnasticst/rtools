// delegate tool: run an independent sub-agent with a fresh context and a
// restricted toolset (no nested delegation). Codex-style delegation.
import { runAgentLoop, systemPrompt, READ_KINDS } from "./agent.js";

export function delegateTool({ ctx, depth = 0 }) {
  return {
    name: "delegate",
    kind: "read",
    description:
      "Run an independent sub-agent with a fresh context to do a focused sub-task (research, analysis, " +
      "multi-file reading) and return its final answer. The sub-agent cannot ask the user questions. " +
      "Use for independent parts; do not use for trivial lookups.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Self-contained task description for the sub-agent" },
        tools: {
          type: "array",
          description: "Tool names the sub-agent may use (default: everything except delegate)",
          items: { type: "string" },
        },
      },
      required: ["task"],
    },
    handler: async ({ task, tools: allowed }) => {
      if (depth >= 2) return "Error: delegation depth limit (2) reached.";
      const pool = ctx.tools.filter((t) => t.name !== "delegate" && (!allowed?.length || allowed.includes(t.name)));
      // The sub-agent cannot ask the user for approval: when the session is not
      // permissive, it gets read-only tools only instead of a silent bypass.
      const permissive = (ctx.cfg.approval_policy ?? "untrusted") === "never";
      const subTools = permissive ? pool : pool.filter((t) => READ_KINDS.has(t.kind));
      const messages = [
        { role: "system", content: systemPrompt(ctx) + "\nYou are a sub-agent. Complete the task and give a final concise answer. You cannot ask the user anything." },
        { role: "user", content: task },
      ];
      let final = "";
      await runAgentLoop({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model: ctx.cfg.model,
        messages,
        tools: subTools,
        approval: "never",
        sandbox: ctx.cfg.sandbox_mode,
        maxSteps: 20,
        _depth: depth + 1,
        onText: (d) => (final += d),
      });
      return final.trim().slice(0, 20000) || "(sub-agent returned no text)";
    },
  };
}
