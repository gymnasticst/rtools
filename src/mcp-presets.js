// Built-in MCP presets the agent connects on demand: Context7 (library docs),
// Playwright (browser automation) and Context-mode (context sandbox). Missing
// npm packages install into a managed prefix (~/.rtools/mcp) and every
// connect/install goes through a tool that always asks the user first.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpConnection } from "./mcp.js";
import { saveConfig } from "./config.js";

const execFileP = promisify(execFile);

export const mcpManagedPrefix = () => path.join(os.homedir(), ".rtools", "mcp");

export const MCP_PRESETS = {
  context7: {
    pkg: "@upstash/context7-mcp",
    bin: "context7-mcp",
    args: [],
    description:
      "Context7 MCP: up-to-date library/framework/API documentation (resolve-library-id, get-library-docs). Use it whenever a task touches an external library or API instead of relying on memorised docs.",
  },
  playwright: {
    pkg: "@playwright/mcp",
    bin: "playwright-mcp",
    args: [],
    description:
      "Playwright MCP: drive a real browser — navigate, click, fill, screenshot, read the console. Use it for UI/E2E verification and any web automation.",
  },
  "context-mode": {
    pkg: "context-mode",
    bin: "context-mode",
    args: ["mcp"],
    minNode: "24.15.0",
    description:
      "Context-mode MCP: run shell commands and fetch web pages into a sandboxed context store with full-text search (ctx_execute, ctx_fetch_and_index, ctx_search). Use it for commands and pages with large output to keep the conversation context small.",
  },
};

export function presetBinPath(preset, prefix = mcpManagedPrefix()) {
  return path.join(prefix, "node_modules", ".bin", preset.bin);
}

export function presetInstalled(preset, prefix = mcpManagedPrefix()) {
  return existsSync(presetBinPath(preset, prefix));
}

function nodeVersionAtLeast(min) {
  const [a, b, c] = min.split(".").map(Number);
  const [x, y, z] = process.versions.node.split(".").map(Number);
  return x > a || (x === a && (y > b || (y === b && z >= c)));
}

// `npm install --prefix <prefix> <pkgs...>` into the managed prefix.
// The caller (mcp_connect / install_packages) already obtained the user's
// confirmation via the approval flow.
export async function npmInstallPrefix(packages, prefix = mcpManagedPrefix()) {
  mkdirSync(prefix, { recursive: true });
  const { stdout, stderr } = await execFileP("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", ...packages], {
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  return (stderr + "\n" + stdout).trim();
}

export function listPresets() {
  return Object.entries(MCP_PRESETS)
    .map(([name, p]) => `${name}: ${p.description}`)
    .join("\n");
}

// Connect a preset (or a user-configured server with the same name) to the
// live session: install the package if missing, spawn the server, register
// its tools as mcp__<server>__<tool> and persist the spec to config.toml.
export async function mcpConnect(name, ctx) {
  const clean = String(name || "").trim();
  if (!clean) return "Error: mcp_connect needs a server name. Available presets:\n" + listPresets();

  // user-configured server wins: connect it as is, nothing to install
  const configured = ctx.cfg?.mcp_servers?.[clean];
  if (configured) {
    const conn = await new McpConnection(clean, configured).start();
    return registerConnection(conn, ctx, "(already configured in config.toml; not modified)");
  }

  const preset = MCP_PRESETS[clean];
  if (!preset) return `Error: unknown MCP server "${clean}". Available presets:\n${listPresets()}`;
  if (preset.minNode && !nodeVersionAtLeast(preset.minNode)) {
    return `Error: ${clean} needs Node >= ${preset.minNode} (this is ${process.versions.node}). Upgrade Node and retry.`;
  }

  let installed = false;
  const binPath = presetBinPath(preset);
  if (!presetInstalled(preset)) {
    await npmInstallPrefix([preset.pkg]);
    if (!existsSync(binPath)) return `Error: npm installed ${preset.pkg} but the binary is still missing at ${binPath}`;
    installed = true;
  }

  const conn = await new McpConnection(clean, { command: binPath, args: preset.args }).start();
  const summary = registerConnection(conn, ctx);
  try {
    saveConfig({ mcp_servers: { [clean]: { command: binPath, args: preset.args } } });
  } catch {
    // persistence is best-effort: the session already works, and the user can
    // add the [mcp_servers.<name>] block to ~/.rtools/config.toml manually
  }
  return summary + (installed ? `\nInstalled ${preset.pkg} into ${mcpManagedPrefix()}.` : `\n${preset.pkg} was already installed.`);
}

function registerConnection(conn, ctx, note = "") {
  const names = [];
  for (const t of conn.tools) {
    ctx.tools.push({
      name: `mcp__${conn.name}__${t.name}`,
      kind: "mcp",
      description: t.description || `MCP tool ${t.name} from server ${conn.name}`,
      parameters: t.inputSchema || { type: "object", properties: {} },
      handler: async (args) => truncateMcp(await conn.callTool(t.name, args)),
    });
    names.push(t.name);
  }
  if (!ctx.mcpConnections.some((c) => c.name === conn.name)) ctx.mcpConnections.push(conn);
  return `Connected MCP server "${conn.name}"${note}. Tools now available: ${names.join(", ") || "(none)"}`;
}

function truncateMcp(s) {
  return s.length > 20000 ? s.slice(0, 20000) + "\n…(truncated)" : s;
}

// Package managers the agent may use to install missing tools. Each call asks
// the user for confirmation via the approval flow (askAlways on the tool).
const PACKAGE_MANAGERS = {
  npm: { cmd: "npm", args: ["install", "-g"], root: false },
  pip: { cmd: "pip", args: ["install"], root: false },
  pip3: { cmd: "pip3", args: ["install"], root: false },
  cargo: { cmd: "cargo", args: ["install"], root: false },
  apt: { cmd: "apt-get", args: ["install", "-y"], root: true },
};

const PACKAGE_NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@/_.+^~=-]*$/;

export function validatePackageList(packages) {
  if (!Array.isArray(packages) || !packages.length) return "Error: packages must be a non-empty array of names.";
  for (const p of packages) {
    if (typeof p !== "string" || !PACKAGE_NAME_RE.test(p) || p.startsWith("-")) {
      return `Error: invalid package name "${p}".`;
    }
  }
  return null;
}

export async function installPackages({ manager, packages }) {
  const spec = PACKAGE_MANAGERS[manager];
  if (!spec) {
    return `Error: unknown package manager "${manager}". Allowed: ${Object.keys(PACKAGE_MANAGERS).join(", ")}.`;
  }
  const bad = validatePackageList(packages);
  if (bad) return bad;

  const sudo = spec.root && typeof process.getuid === "function" && process.getuid() !== 0;
  const cmd = sudo ? "sudo" : spec.cmd;
  const args = sudo ? ["-n", spec.cmd, ...spec.args, ...packages] : [...spec.args, ...packages];
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: 15 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = (stderr + "\n" + stdout).trim();
    return `Installed ${packages.join(", ")} via ${manager}.\n` + out.slice(-4000);
  } catch (e) {
    const out = ((e.stderr || "") + "\n" + (e.stdout || "")).trim();
    return `Error: ${manager} install failed for ${packages.join(", ")}: ${e.message}\n${out.slice(-4000)}`;
  }
}

export function mcpConnectTool(ctx) {
  const auto = ctx?.cfg?.auto_install === true;
  return {
    name: "mcp_connect",
    kind: "mcp",
    // auto_install: installs run without confirmation; otherwise every
    // connect/install is confirmed, even with approval=never
    askAlways: !auto,
    autoAllowed: auto,
    description:
      "Connect a built-in MCP server to this session by name (installs the missing npm package first). " +
      "Presets: " + Object.keys(MCP_PRESETS).join(", ") + ". " +
      "Call it with an empty name to list them. " +
      (auto
        ? "auto_install is on: the installation runs automatically without asking for confirmation."
        : "Every connect/install asks the user for confirmation."),
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Preset or configured server name, e.g. context7" } },
      required: [],
    },
    handler: ({ name }) => mcpConnect(name, ctx),
  };
}

// Auto-install every missing preset package up front (auto_install mode).
// Idempotent: presets already present in the managed prefix are skipped.
export async function ensureAllPresetsInstalled(prefix = mcpManagedPrefix()) {
  const results = [];
  for (const [name, preset] of Object.entries(MCP_PRESETS)) {
    if (preset.minNode && !nodeVersionAtLeast(preset.minNode)) {
      results.push(`${name}: skipped (needs Node >= ${preset.minNode})`);
      continue;
    }
    if (presetInstalled(preset, prefix)) {
      results.push(`${name}: already installed`);
      continue;
    }
    try {
      await npmInstallPrefix([preset.pkg], prefix);
      results.push(
        presetBinPath(preset, prefix) && existsSync(presetBinPath(preset, prefix))
          ? `${name}: installed ${preset.pkg}`
          : `${name}: install finished but binary missing at ${presetBinPath(preset, prefix)}`
      );
    } catch (e) {
      results.push(`${name}: install failed (${e.message})`);
    }
  }
  return results.join("\n");
}

export function installPackagesTool(cfg = {}) {
  const auto = cfg?.auto_install === true;
  return {
    name: "install_packages",
    kind: "shell",
    // auto_install: installs run without confirmation; otherwise every
    // installation is confirmed, even with approval=never
    askAlways: !auto,
    autoAllowed: auto,
    description:
      "Install missing CLI tools, libraries or language packages needed for the task. " +
      "Supported managers: npm (global), pip/pip3, cargo, apt-get. " +
      (auto
        ? "auto_install is on: installations run automatically without asking the user."
        : "Every installation asks the user for confirmation — never install packages silently through the shell tool."),
    parameters: {
      type: "object",
      properties: {
        manager: { type: "string", enum: Object.keys(PACKAGE_MANAGERS), description: "Package manager to use" },
        packages: { type: "array", items: { type: "string" }, description: "Package names to install" },
      },
      required: ["manager", "packages"],
    },
    handler: (args) => installPackages(args),
  };
}
