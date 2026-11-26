import { loadConfig, resolveProvider, getApiKey, projectTrusted } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { connectMcpServers } from "./mcp.js";
import { discoverSkills } from "./skills.js";
import { builtinTools, viewImageTool } from "./tools.js";
import { stream } from "./providers.js";
import { applyPatchTool } from "./apply-patch.js";
import { updatePlanTool } from "./plan.js";
import { execWithSandbox } from "./sandbox.js";
import { webSearchTool } from "./web-search.js";
import { delegateTool } from "./delegate.js";
import { teamTool } from "./team.js";
import { jobTool } from "./jobs.js";
import { mcpConnectTool, installPackagesTool } from "./mcp-presets.js";
import { runHook } from "./hooks.js";
import { snapshotFile } from "./checkpoints.js";
import { addUsage } from "./usage.js";

export function loadAgentsMd(cwd) {
  const file = existsSync(`${cwd}/AGENTS.md`) ? `${cwd}/AGENTS.md` : existsSync(`${cwd}/agents.md`) ? `${cwd}/agents.md` : null;
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").slice(0, 20000);
  } catch {
    return null;
  }
}

import { goalPromptSection } from "./goal.js";
import { memoryPromptSection } from "./memory-vector.js";
import { routeModel } from "./smart-routing.js";

export function systemPrompt({ cfg, cwd, skills = [], mcpConnections = [] }) {
  if (cfg.instructions_file && existsSync(cfg.instructions_file)) {
    try {
      return readFileSync(cfg.instructions_file, "utf8");
    } catch {
      // fall through to built-in instructions
    }
  }
  const lines = [
    "You are RTools, a command-line coding agent. You help the user with software engineering tasks:",
    "reading and editing files, running shell commands, and building features.",
    `Working directory: ${cwd}`,
    "",
    "Use the provided tools whenever you need to inspect or change anything.",
    "After acting on a tool result, briefly report what you did and the outcome.",
  ];
  if (cfg.ask_questions !== false) {
    lines.push(
      "",
      "## Mandatory clarifying questions",
      "Before starting any task that changes files, runs commands or builds anything, you MUST call the `ask_user` tool with concrete clarifying questions and wait for the real answers. Keep asking follow-up `ask_user` rounds until you are 100% sure what the user wants; never invent requirements or guess between alternatives. Skip this only for a trivial read-only question you can answer yourself with the read tools.",
      "",
      "## Project AGENTS.md is your responsibility",
      "After the clarifying answers, check `survey_project`: if the project has no AGENTS.md, you MUST survey the project and write a real AGENTS.md yourself (with write_file) before doing the task. Fill it only with facts you verified: real build/test commands from the actual manifests, real conventions you saw in the code, key files. If AGENTS.md exists but is clearly wrong about build/test commands, fix those sections."
    );
  }
  const autoInstall = cfg.auto_install === true;
  lines.push(
    "",
    "## Required MCP integrations (use them when needed)",
    autoInstall
      ? "Three MCP servers are available as built-in presets: context7, playwright, context-mode. If a task needs one of them and it is not connected yet, call `mcp_connect` first (with an empty name it lists them): it installs the missing npm package into ~/.rtools/mcp and connects the server. auto_install is on: dependency installations run automatically, without asking the user for confirmation."
      : "Three MCP servers are available as built-in presets: context7, playwright, context-mode. If a task needs one of them and it is not connected yet, call `mcp_connect` first (with an empty name it lists them): it installs the missing npm package into ~/.rtools/mcp and connects the server, asking the user to confirm the installation.",
    "Using the right integration is mandatory when relevant: never guess library or API details from memory while context7 is available; verify UI and web work through a real browser via playwright; route shell commands and page fetches with large output through context-mode to keep the context small.",
    "",
    "## Installing missing tools",
    autoInstall
      ? "If a task needs a CLI, library or package that is not installed, call `install_packages` (npm, pip, cargo, apt). auto_install is on: installations run automatically without asking the user, so install whatever the task needs directly."
      : "If a task needs a CLI, library or package that is not installed, call `install_packages` (npm, pip, cargo, apt). Every installation asks the user for confirmation — never install packages silently through the shell tool."
  );
  const agentsMd = loadAgentsMd(cwd);
  if (agentsMd) lines.push("", "# Project guidance (AGENTS.md)", agentsMd);
  if (mcpConnections.length) {
    lines.push("", `Connected MCP plugin servers: ${mcpConnections.map((c) => c.name).join(", ")}.`);
  }
  if (skills.length) {
    lines.push(
      "",
      "Available skills (load full instructions with the `skill` tool when relevant):",
      ...skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`)
    );
  }
  lines.push(goalPromptSection());
  lines.push(memoryPromptSection());
  return lines.join("\n");
}

export function needsApproval(tool, policy, planMode = false) {
  // auto_install: dependency installs (packages, MCP presets) run without
  // confirmation — except in plan mode, which stays read-only
  if (tool.autoAllowed && !planMode) return false;
  // installs and MCP connects always confirm, even with approval=never
  if (tool.askAlways) return true;
  if (policy === "never" && !planMode) return false;
  if (policy === "always") return true;
  // plan mode: everything effectful asks, even with policy=never
  if (planMode && (tool.kind === "shell" || tool.kind === "write" || tool.kind === "mcp")) return true;
  // untrusted: read-only helpers run freely, anything effectful asks
  return tool.kind === "shell" || tool.kind === "write" || tool.kind === "mcp";
}

export async function buildContext(opts) {
  const cfg = loadConfig({ ...opts, cwd: opts.cwd });
  // merge marketplace-installed plugins (~/.rtools/plugins.toml)
  try {
    const { readInstalled } = await import("./marketplace.js");
    cfg.mcp_servers = { ...readInstalled(), ...(cfg.mcp_servers || {}) };
  } catch {
    // marketplace optional
  }
  const provider = resolveProvider(cfg, opts.provider);
  const apiKey = getApiKey(provider);
  const cwd = opts.cwd || process.cwd();
  const skills = await discoverSkills(cfg.skills_dirs || []);
  const mcpConnections = projectTrusted(cfg, cwd) ? await connectMcpServers(cfg) : [];

  const tools = builtinTools({ cwd, skills, sandboxMode: cfg.sandbox_mode, cfg });
  tools.push(applyPatchTool({ cwd }));
  const sessionTodo = builtinTools._todos; // todo_write state for /todos
  if (sessionTodo) tools._todos = sessionTodo;
  const planState = {};
  tools.push(updatePlanTool({ state: planState }));
  if (cfg.tools?.web_search) tools.push(webSearchTool({ maxResults: cfg.tools.web_search_max_results }));
  if (cfg.tools?.view_image !== false) tools.push(viewImageTool({ cwd }));
  tools.push(jobTool({ cwd }));
  tools.push(mcpConnectTool({ cfg, tools, mcpConnections }));
  tools.push(installPackagesTool(cfg));
  tools.push(delegateTool({ ctx: { cfg, provider, apiKey, cwd, skills, tools, mcpConnections } }));
  tools.push(teamTool({ ctx: { cfg, provider, apiKey, cwd, skills, tools, mcpConnections } }));
  for (const conn of mcpConnections) {
    for (const t of conn.tools) {
      tools.push({
        name: `mcp__${conn.name}__${t.name}`,
        kind: "mcp",
        description: t.description || `MCP tool ${t.name} from server ${conn.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
        handler: async (args) => truncateMcp(await conn.callTool(t.name, args)),
      });
    }
  }
  return { cfg, provider, apiKey, cwd, skills, mcpConnections, tools };
}

function truncateMcp(s) {
  return s.length > 20000 ? s.slice(0, 20000) + "\n…(truncated)" : s;
}

export const READ_KINDS = new Set(["read", "git"]);

function shouldCheckpoint(tool) {
  return tool.kind === "write" || tool.name === "apply_patch" || tool.name === "edit";
}

export async function runAgentLoop({ provider, apiKey, model, messages, tools, approval, sandbox, maxSteps = 40, settings = {}, planMode = false, onText, onToolUse, onToolResult, askApproval, usageTracker, trace, cwd = process.cwd(), signal, _depth = 0 }) {
  const maxRetries = 2;
  let step = 0;
  for (; step < maxSteps; step++) {
    // stream with retry on transient provider failures (and Ctrl+C: rethrow)
    let text, toolCalls, usage;
    let attempt = 0;
    for (;;) {
      try {
        const r = await stream({ provider, apiKey, model: settings.turnModel || model, messages, tools, onText, settings, signal });
        text = r.text;
        toolCalls = r.toolCalls;
        usage = r.usage;
        break;
      } catch (e) {
        if (signal?.aborted || e.name === "AbortError") throw new Error("interrupted");
        if (attempt++ >= maxRetries) throw e;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    addUsage(usageTracker, usage);
    trace?.log({ type: "step", step, model, input: usage?.input_tokens, output: usage?.output_tokens });
    messages.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
        : {}),
    });
    if (!toolCalls.length) return { steps: step + 1 };

    const calls = toolCalls.map((call) => ({ call, tool: tools.find((t) => t.name === call.name) }));
    const runOne = async ({ call, tool }) => {
      let result;
      if (!tool) {
        result = `Error: unknown tool "${call.name}"`;
      } else if (needsApproval(tool, approval, planMode) && !(await askApproval?.(tool, call))) {
        result = "The user denied this tool call.";
      } else {
        const pre = runHook(settings.hooks, "pre_tool", tool, safeParse(call.arguments));
        if (!pre.ok) {
          result = `Blocked by pre_tool hook: ${pre.output}`;
        } else {
          onToolUse?.(tool, call);
          try {
            const args = safeParse(call.arguments);
            if (tool.kind === "shell" && sandbox) args.__sandboxMode = sandbox;
            if (shouldCheckpoint(tool) && typeof args.path === "string") {
              try {
                snapshotFile(path.resolve(cwd, args.path), cwd);
              } catch {
                // checkpointing is best-effort
              }
            }
            result = await tool.handler(args);
          } catch (e) {
            result = `Error: ${e.message}`;
          }
          runHook(settings.hooks, "post_tool", tool, safeParse(call.arguments));
        }
      }
      onToolResult?.(tool, result);
      return { role: "tool", tool_call_id: call.id, content: result };
    };
    // read-only tools run in parallel; effectful ones stay strictly ordered
    const ordered = calls.filter((c) => !READ_KINDS.has(c.tool?.kind));
    const parallel = calls.filter((c) => READ_KINDS.has(c.tool?.kind));
    const results = new Map();
    if (parallel.length > 1) {
      const done = await Promise.all(parallel.map((c) => runOne(c)));
      parallel.forEach((c, i) => results.set(c, done[i]));
    } else {
      for (const c of parallel) results.set(c, await runOne(c));
    }
    for (const c of ordered) results.set(c, await runOne(c));
    for (const c of calls) messages.push(results.get(c));
  }
  // step limit: report instead of throwing so the session survives
  return { steps: step, stepLimitReached: true };
}

function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
}
