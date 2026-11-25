// Pre/post tool hooks from config.toml [hooks]: plain shell commands run for
// every tool call with RTOOLS_TOOL / RTOOLS_TOOL_KIND / RTOOLS_ARGS in the
// environment. A non-zero pre_tool exit blocks the call; post_tool is
// best-effort and never blocks.
import { execFileSync } from "node:child_process";

export function runHook(hooks, phase, tool, args) {
  const cmd = hooks?.[phase];
  if (!cmd || typeof cmd !== "string") return { ok: true };
  try {
    const out = execFileSync("bash", ["-lc", cmd], {
      env: {
        ...process.env,
        RTOOLS_TOOL: tool?.name || "",
        RTOOLS_TOOL_KIND: tool?.kind || "",
        RTOOLS_ARGS: JSON.stringify(args ?? {}).slice(0, 8000),
      },
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: String(e.stderr || e.stdout || e.message).slice(0, 2000) };
  }
}
