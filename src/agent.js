import { loadConfig, resolveProvider, getApiKey, projectTrusted } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import { connectMcpServers } from "./mcp.js";
import { discoverSkills } from "./skills.js";
import { builtinTools } from "./tools.js";
import { stream } from "./providers.js";
import { applyPatchTool } from "./apply-patch.js";
import { updatePlanTool } from "./plan.js";
import { execWithSandbox } from "./sandbox.js";
import { webSearchTool } from "./web-search.js";
import { delegateTool } from "./delegate.js";

export function loadAgentsMd(cwd) {
  const file = existsSync(`${cwd}/AGENTS.md`) ? `${cwd}/AGENTS.md` : existsSync(`${cwd}/agents.md`) ? `${cwd}/agents.md` : null;
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").slice(0, 20000);
  } catch {
    return null;
  }
}

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
  return lines.join("\n");
}

export function needsApproval(tool, policy, planMode = false) {
  if (policy === "never" && !planMode) return false;
  if (policy === "always") return true;
  // plan mode: everything effectful asks, even with policy=never
  if (planMode && (tool.kind === "shell" || tool.kind === "write" || tool.kind === "mcp")) return true;
  // untrusted: read-only helpers run freely, anything effectful asks
  return tool.kind === "shell" || tool.kind === "write" || tool.kind === "mcp";
}

export async function buildContext(opts) {
  const cfg = loadConfig(opts);
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
  const planState = {};
  tools.push(updatePlanTool({ state: planState }));
  if (cfg.tools?.web_search) tools.push(webSearchTool({ maxResults: cfg.tools.web_search_max_results }));
  tools.push(delegateTool({ ctx: { cfg, provider, apiKey, cwd, skills, tools, mcpConnections } }));
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

export async function runAgentLoop({ provider, apiKey, model, messages, tools, approval, sandbox, maxSteps = 40, settings = {}, planMode = false, onText, onToolUse, onToolResult, askApproval }) {
  for (let step = 0; step < maxSteps; step++) {
    const { text, toolCalls } = await stream({ provider, apiKey, model, messages, tools, onText, settings });
    messages.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
        : {}),
    });
    if (!toolCalls.length) return;

    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let result;
      if (!tool) {
        result = `Error: unknown tool "${call.name}"`;
      } else if (needsApproval(tool, approval, planMode) && !(await askApproval?.(tool, call))) {
        result = "The user denied this tool call.";
      } else {
        onToolUse?.(tool, call);
        try {
          const args = safeParse(call.arguments);
          if (tool.kind === "shell" && sandbox) args.__sandboxMode = sandbox;
          result = await tool.handler(args);
        } catch (e) {
          result = `Error: ${e.message}`;
        }
      }
      onToolResult?.(tool, result);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`Reached the ${maxSteps}-step limit for one request.`);
}

function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
}
