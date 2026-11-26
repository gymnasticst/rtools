// First-run welcome window and /setup wizard inside the TUI. Both are real
// interactive flows: pick() for choices, nextLine for free text, and the
// results are written to the user's config.toml via saveConfig.
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pick, confirm, PALETTE_CANCEL } from "./palette.js";
import { saveConfig, BUILTIN_PROVIDERS } from "./config.js";

const C = { cyan: (s) => `\x1b[36m${s}\x1b[0m`, gray: (s) => `\x1b[90m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

export function configPath() {
  return path.join(os.homedir(), ".rtools", "config.toml");
}

export function isFirstRun() {
  return !existsSync(configPath());
}

export function welcomeBox({ version }) {
  return [
    "",
    C.cyan(`  ${C.bold(">_ Welcome to RTools")} ${C.gray(`(${version})`)}`),
    C.gray("  This looks like your first run — a short setup will walk you through:"),
    C.gray("    1. provider and model     2. approval policy     3. optional API key"),
    C.gray("  (run /setup any time; skip now by just pressing Enter)"),
    "",
  ].join("\n");
}

// The wizard: returns a summary string of what was changed ("" if skipped).
export async function runSetupWizard({ version, nextLine }) {
  console.log(welcomeBox({ version }));
  const changed = [];
  const first = await pick({
    title: "Setup — model provider (Enter to pick, Esc/Ctrl+C to skip)",
    items: Object.entries(BUILTIN_PROVIDERS).map(([value, p]) => ({ label: p.name, hint: p.default_model, value })),
  });
  if (first === PALETTE_CANCEL) return "";
  saveConfig({ model_provider: first });
  changed.push(`provider: ${first} (default model: ${BUILTIN_PROVIDERS[first].default_model})`);

  const policy = await pick({
    title: "Setup — approval policy",
    items: [
      { label: "untrusted", hint: "ask before every write/shell (recommended)", value: "untrusted" },
      { label: "always", hint: "ask for every tool call", value: "always" },
      { label: "never", hint: "never ask (auto mode)", value: "never" },
    ],
  });
  if (policy !== PALETTE_CANCEL) {
    saveConfig({ approval_policy: policy });
    changed.push(`approval_policy: ${policy}`);
  }

  const wantsKey = await confirm({ prompt: "Store an API key now? (openai/anthropic need one; zen free tier does not)" });
  if (wantsKey) {
    const key = await nextLine("paste key (saved to config.toml): ");
    if (key && key.trim()) {
      const provider = first || "openai";
      saveConfig({ [provider === "openai" ? "api_key" : `${provider}_api_key`]: key.trim() });
      changed.push(`api key stored for ${provider}`);
    }
  }

  return changed.join("\n  ");
}
