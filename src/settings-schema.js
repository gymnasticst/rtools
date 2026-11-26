// Catalog of user-facing settings for the settings palette (Ctrl+O).
// Pure data + helpers, no TTY — testable without a terminal.
// `live` means the REPL applies the change to the running session; the rest
// take effect on the next launch (marked in the palette as a hint).

export const SETTING_DEFS = [
  { id: "model", label: "model", desc: "model id used for requests", kind: "string", live: true },
  { id: "model_provider", label: "provider", desc: "openai, anthropic or a custom provider id", kind: "enum", values: null, live: false, note: "restart to apply" },
  { id: "approval_policy", label: "approval policy", desc: "when tool calls ask for approval", kind: "enum", values: ["untrusted", "never", "always"], live: true },
  { id: "auto_install", label: "auto install", desc: "install missing dependencies (packages, MCP presets) without asking", kind: "toggle", live: false, note: "new session" },
  { id: "sandbox_mode", label: "sandbox", desc: "filesystem/network sandbox for shell and writes", kind: "enum", values: ["read-only", "workspace", "danger"], live: true },
  { id: "model_reasoning_effort", label: "reasoning effort", desc: "low | medium | high", kind: "enum", values: ["low", "medium", "high"], live: true },
  { id: "model_reasoning_summary", label: "reasoning summary", desc: "auto | concise | detailed", kind: "enum", values: ["auto", "concise", "detailed"], live: false },
  { id: "model_verbosity", label: "verbosity", desc: "answer verbosity", kind: "enum", values: ["low", "medium", "high"], live: true },
  { id: "temperature", label: "temperature", desc: "sampling temperature", kind: "number", nullable: true, min: 0, max: 2, live: true },
  { id: "top_p", label: "top_p", desc: "nucleus sampling", kind: "number", nullable: true, min: 0, max: 1, live: true },
  { id: "max_output_tokens", label: "max output tokens", desc: "response size cap", kind: "number", nullable: true, min: 1, live: true },
  { id: "context_window_tokens", label: "context window", desc: "tokens before auto-compact kicks in", kind: "number", min: 1024, live: false },
  { id: "max_agent_steps", label: "max agent steps", desc: "tool-call rounds per turn", kind: "number", min: 1, live: true },
  { id: "theme", label: "theme", desc: "ANSI colours in the terminal", kind: "enum", values: ["auto", "plain", "color"], live: false, note: "new output" },
  { id: "hide_agent_reasoning", label: "hide agent reasoning", desc: "do not print reasoning text", kind: "toggle", live: false },
  { id: "show_raw_agent_reasoning", label: "show raw reasoning", desc: "print raw model reasoning", kind: "toggle", live: false },
  { id: "disable_response_storage", label: "disable response storage", desc: "send store:false to the API", kind: "toggle", live: false },
  { id: "history.persistence", label: "history persistence", desc: "save-all | none", kind: "enum", values: ["save-all", "none"], live: false },
  { id: "tools.web_search", label: "web search tool", desc: "enable the web_search tool", kind: "toggle", live: false, note: "new session" },
  { id: "tools.web_search_max_results", label: "web search max results", desc: "results per web_search call", kind: "number", min: 1, max: 20, live: false, note: "new session" },
  { id: "tools.view_image", label: "view image tool", desc: "let the model look at local images", kind: "toggle", live: false, note: "new session" },
  { id: "trace", label: "trace log", desc: "JSONL log of steps and tools in ~/.rtools/logs", kind: "toggle", live: false, note: "new session" },
  { id: "hooks.pre_tool", label: "pre-tool hook", desc: "shell command before every tool call (non-zero blocks it)", kind: "string", live: false, note: "restart to apply" },
  { id: "hooks.post_tool", label: "post-tool hook", desc: "shell command after every tool call", kind: "string", live: false, note: "restart to apply" },
  { id: "trust_policy", label: "trust policy", desc: "on: every project is trusted", kind: "enum", values: ["off", "on"], live: false },
];

const dottedGet = (obj, id) => id.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function getSetting(cfg, id) {
  return dottedGet(cfg, id);
}

// Keys that must never be set through a user-controlled dotted id or patch:
// assigning them pollutes Object.prototype.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Nested patch for one setting: "tools.web_search" -> { tools: { web_search: v } }.
export function setSettingPatch(id, value) {
  const keys = id.split(".");
  const patch = {};
  let node = patch;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (FORBIDDEN_KEYS.has(k)) return {};
    node = node[k] ??= {};
  }
  const last = keys[keys.length - 1];
  if (FORBIDDEN_KEYS.has(last)) return patch;
  node[last] = value;
  return patch;
}

// Mutate a live config object with a nested patch.
export function applyPatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) applyPatch(target[k] ??= {}, v);
    else target[k] = v;
  }
  return target;
}

// Next value of an enum setting, wrapping around (Enter-to-cycle).
export function nextEnum(def, current, options) {
  const vals = def.values || options || [];
  if (!vals.length) return current;
  const i = vals.indexOf(current);
  return vals[(i + 1) % vals.length];
}

// Parse typed input for number settings; "off"/"" -> null when nullable.
// Returns { ok: true, value } or { ok: false, error }.
export function parseSettingInput(def, text) {
  const t = String(text ?? "").trim();
  if (def.kind === "number") {
    if (t === "" || t === "off" || t === "default") {
      if (def.nullable) return { ok: true, value: null };
      return { ok: false, error: `${def.label} needs a number` };
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, error: `"${t}" is not a number` };
    if (def.min != null && n < def.min) return { ok: false, error: `minimum is ${def.min}` };
    if (def.max != null && n > def.max) return { ok: false, error: `maximum is ${def.max}` };
    return { ok: true, value: n };
  }
  if (def.kind === "enum") {
    const vals = def.values || [];
    if (!vals.includes(t)) return { ok: false, error: `one of: ${vals.join(", ")}` };
    return { ok: true, value: t };
  }
  if (def.kind === "toggle") return { ok: true, value: ["1", "true", "on", "yes", "y"].includes(t.toLowerCase()) };
  if (t === "") return { ok: false, error: `${def.label} cannot be empty` };
  return { ok: true, value: t };
}

export function formatSettingValue(def, value) {
  if (def.kind === "toggle") return value ? "on" : "off";
  if (def.kind === "number" && def.nullable && (value == null)) return "default";
  return String(value ?? "");
}
