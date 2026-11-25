import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTOML } from "./toml.js";

export const BUILTIN_PROVIDERS = {
  openai: {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    env_key: "OPENAI_API_KEY",
    wire_api: "chat",
    default_model: "gpt-5.1",
  },
  anthropic: {
    name: "Anthropic",
    base_url: "https://api.anthropic.com",
    env_key: "ANTHROPIC_API_KEY",
    wire_api: "anthropic",
    default_model: "claude-sonnet-4-5",
  },
};

const CONFIG_FILES = () => [
  path.join(os.homedir(), ".rtools", "config.toml"),
  path.resolve(".rtools/config.toml"),
];

export const DEFAULT_SKILLS_DIRS = () => [
  path.join(os.homedir(), ".rtools", "skills"),
  path.resolve(".rtools/skills"),
];

export const RTOOLS_HOME = () => path.join(os.homedir(), ".rtools");

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Defaults for every Codex-style setting.
export function defaults() {
  return {
    model: "gpt-5.1",
    model_provider: "openai",
    approval_policy: "untrusted", // untrusted | never | always
    sandbox_mode: "workspace", // read-only | workspace | danger
    model_reasoning_effort: "medium", // low | medium | high (responses API)
    model_reasoning_summary: "auto", // auto | concise | detailed
    model_verbosity: "medium", // low | medium | high (responses API)
    temperature: null, // float, null = provider default
    top_p: null,
    max_output_tokens: null,
    context_window_tokens: 128000,
    max_agent_steps: 40,
    shell_environment_policy: { inherit: "all", ignore: [], set: {} }, // inherit: all|core|none
    hide_agent_reasoning: false,
    show_raw_agent_reasoning: false,
    disable_response_storage: false,
    notify: null, // external program invoked on events
    history: { persistence: "save-all", max_bytes: 1048576 }, // save-all | none
    trust_policy: "off", // off: all projects untrusted; per-project trust via [projects]
    projects: {}, // [projects."/path"] trust = "trusted" | "untrusted"
    tools: { web_search: false, web_search_max_results: 5, view_image: false },
    mcp_servers: {},
    model_providers: {},
    skills_dirs: DEFAULT_SKILLS_DIRS(),
    instructions_file: null, // replaces built-in base instructions
    profiles: {}, // kept raw; applied via --profile
  };
}

const VALIDATORS = {
  approval_policy: (v) => ["untrusted", "never", "always"].includes(v),
  sandbox_mode: (v) => ["read-only", "workspace", "danger"].includes(v),
  model_reasoning_effort: (v) => ["low", "medium", "high"].includes(v),
  model_reasoning_summary: (v) => ["auto", "concise", "detailed"].includes(v),
  model_verbosity: (v) => ["low", "medium", "high"].includes(v),
  trust_policy: (v) => ["off", "on"].includes(v),
};

export function loadConfig({ configPath, cwd, model, provider, approval, sandbox, profile, effort, verbosity } = {}) {
  const cfg = defaults();
  const mergeFile = (file) => {
    if (existsSync(file)) deepMerge(cfg, parseTOML(readFileSync(file, "utf8")));
  };
  if (configPath) {
    // explicitly passed config is trusted by definition
    mergeFile(configPath);
  } else {
    // trust is decided from the user-level config only; a project cannot
    // mark itself trusted, so its config loads solely for trusted projects
    const [userFile, projectFile] = CONFIG_FILES();
    mergeFile(userFile);
    // the working dir the agent will operate in (-w/--workdir), not where the
    // CLI process happens to run: trust must be checked for the same dir
    if (projectTrusted(cfg, cwd || process.cwd())) mergeFile(projectFile);
  }
  // profile: [profile.<name>] overrides top-level keys
  if (cfg.profile && profile) {
    if (!cfg.profile[profile]) throw new Error(`Unknown profile "${profile}"`);
    deepMerge(cfg, cfg.profile[profile]);
  }
  if (model) cfg.model = model;
  if (provider) cfg.model_provider = provider;
  if (approval) cfg.approval_policy = approval;
  if (sandbox) cfg.sandbox_mode = sandbox;
  if (effort) cfg.model_reasoning_effort = effort;
  if (verbosity) cfg.model_verbosity = verbosity;

  for (const [key, ok] of Object.entries(VALIDATORS)) {
    if (!ok(cfg[key])) throw new Error(`Invalid ${key} "${cfg[key]}"`);
  }
  for (const numKey of ["temperature", "top_p", "max_output_tokens", "context_window_tokens", "max_agent_steps"]) {
    if (cfg[numKey] !== null && typeof cfg[numKey] !== "number") throw new Error(`${numKey} must be a number`);
  }
  return cfg;
}

export function projectTrusted(cfg, cwd) {
  const entry = cfg.projects?.[cwd];
  if (entry?.trust === "trusted") return true;
  if (entry?.trust === "untrusted") return false;
  return cfg.trust_policy === "on";
}

export function resolveProvider(cfg, nameArg) {
  const name = nameArg || cfg.model_provider;
  const builtin = BUILTIN_PROVIDERS[name];
  const custom = cfg.model_providers?.[name];
  if (!builtin && !custom) {
    throw new Error(
      `Unknown model provider "${name}". Define it in config.toml:\n\n` +
        `  [model_providers.${name}]\n` +
        `  name = "My Provider"\n` +
        `  base_url = "https://example.com/v1"\n` +
        `  env_key = "MY_API_KEY"\n` +
        `  wire_api = "chat"   # chat | responses | anthropic`
    );
  }
  const p = { ...(builtin || {}), ...(custom || {}) };
  return {
    id: name,
    label: p.name || name,
    base_url: p.base_url,
    env_key: p.env_key || null,
    wire_api: p.wire_api || "chat",
    default_model: p.default_model || builtin?.default_model || "gpt-5.1",
    query_params: p.query_params || null, // e.g. { api-version: "..." } for Azure
    http_headers: p.http_headers || {},
  };
}

export function getApiKey(provider) {
  if (!provider.env_key) return null;
  const key = process.env[provider.env_key];
  if (!key) {
    throw new Error(
      `Provider "${provider.id}" requires the environment variable ${provider.env_key} with its API key.`
    );
  }
  return key;
}
