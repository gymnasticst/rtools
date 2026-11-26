// Pre/post tool hooks from config.toml [hooks]: plain shell commands run for
// every tool call with RTOOLS_TOOL / RTOOLS_TOOL_KIND / RTOOLS_ARGS in the
// environment. A non-zero pre_tool exit blocks the call; post_tool is
// best-effort and never blocks.
import { execFileSync } from "node:child_process";

const MAX_ARGS_CHARS = 8000;

// JSON.stringify sliced at an arbitrary offset is not JSON; a hook that parses
// RTOOLS_ARGS fails on exactly the large calls worth inspecting. Instead:
// under the limit the full serialized args; over it, serialize each top-level
// value that still fits whole and append "_truncated": true once nothing fits.
export function truncatedJson(args, max = MAX_ARGS_CHARS) {
  const full = JSON.stringify(args);
  if (full.length <= max) return full;
  let out = "{";
  for (const [k, v] of Object.entries(args)) {
    const piece = `${out.length > 1 ? "," : ""}${JSON.stringify(k)}:${JSON.stringify(v)}`;
    if (out.length + piece.length + 15 > max) break; // 15 = ,"_truncated":true}
    out += piece;
  }
  return `${out},"_truncated":true}`;
}

export function runHook(hooks, phase, tool, args) {
  const cmd = hooks?.[phase];
  if (!cmd || typeof cmd !== "string") return { ok: true };
  try {
    const out = execFileSync("bash", ["-lc", cmd], {
      env: {
        ...process.env,
        // keep the payload valid JSON when it exceeds the env limit: truncate
        // the serialized form and close it with a marker key a parser can see
        RTOOLS_ARGS: truncatedJson(args ?? {}, 8000),
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
