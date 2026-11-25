// TUI panels (OpenCode-style, raw-mode pickers on top of palette.js):
//   - file browser: real directory listing, navigation, file preview
//   - terminal: run a shell command and show its real output
//   - sub-agents: live delegate/team activity from agent-registry.js
//   - MCP status: real connection state and tool lists from McpConnection
//   - plugin status: real installed plugins from ~/.rtools/plugins.toml
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { pick } from "./palette.js";
import { agentEvents, runningAgents } from "./agent-registry.js";
import { readInstalled, pluginInstalledNames } from "./marketplace.js";

const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;

// ---------- file browser ----------
// Browses the real filesystem from `startDir`. Enter on a directory descends,
// on a file previews it. Resolves { action: "preview", path, text } |
// { action: "insert", path } | null.
export async function fileBrowser({ startDir = process.cwd(), maxPreview = 4000 } = {}) {
  let dir = path.resolve(startDir);
  for (;;) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { action: "error", error: e.message };
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    const items = [
      { label: "..", hint: "up", value: { go: "up" } },
      ...dirs.map((d) => ({ label: d + "/", hint: "dir", value: { go: path.join(dir, d) } })),
      ...files.map((f) => {
        let size = "";
        try { size = `${statSync(path.join(dir, f)).size}b`; } catch {}
        return { label: f, hint: size, value: { file: path.join(dir, f) } };
      }),
    ].slice(0, 200);
    const sel = await pick({
      title: `${dir} — Enter: open/preview · Esc: close`,
      items,
      pageSize: 14,
    });
    if (!sel) return null;
    if (sel.value.go === "up") {
      dir = path.dirname(dir);
      continue;
    }
    if (sel.value.go) {
      dir = sel.value.go;
      continue;
    }
    // file selected: preview or insert path
    const file = sel.value.file;
    const action = await pick({
      title: `${file}`,
      items: [
        { label: "Preview content", hint: "show the first lines", value: "preview" },
        { label: "Insert @path into prompt", hint: "attach to the next message", value: "insert" },
      ],
      pageSize: 4,
    });
    if (!action) continue;
    if (action.value === "insert") return { action: "insert", path: file };
    let text = "";
    try {
      text = readFileSync(file, "utf8").slice(0, maxPreview);
    } catch (e) {
      text = `(cannot read: ${e.message})`;
    }
    return { action: "preview", path: file, text };
  }
}

// ---------- terminal ----------
// Asks for a shell command, runs it for real, shows stdout/stderr/exit code,
// then offers "run another" / "close". Resolves the last output or null.
export async function terminalPanel({ cwd = process.cwd(), run = null } = {}) {
  const exec = run || (await import("./sandbox.js")).execWithSandbox;
  let last = null;
  for (;;) {
    const cmd = await (await import("./palette.js")).typeText({
      title: `Terminal — ${cwd} (Esc: close)`,
      prompt: "$",
    });
    if (!cmd || !cmd.trim()) return last;
    let out;
    try {
      if (run) {
        out = await run({ command: cmd.trim() });
      } else {
        const r = await exec({ command: cmd.trim(), cwd, mode: "off", env: process.env });
        out = `exit ${r.code}${r.timedOut ? " (timed out)" : ""}\n${r.stdout || ""}${r.stderr ? `stderr:\n${r.stderr}` : ""}`.trim() || "(no output)";
      }
    } catch (e) {
      out = `error: ${e.message}`;
    }
    last = { command: cmd.trim(), output: String(out).slice(0, 8000) };
    const next = await pick({
      title: `Terminal — output (${last.output.split("\n").length} lines)`,
      items: [
        { label: "Show output", hint: "print to the session log", value: "show" },
        { label: "Run another command", value: "again" },
        { label: "Close terminal", value: "close" },
      ],
      pageSize: 4,
    });
    if (!next || next.value === "close") return last;
    if (next.value === "show") {
      console.log(DIM(`$ ${last.command}`));
      console.log(last.output);
    }
  }
}

// ---------- sub-agents ----------
// Live view: real registry events. Resolves a chosen event (for detail) or null.
export async function subagentsPanel() {
  const evs = agentEvents();
  if (!evs.length) {
    await pick({
      title: "Sub-agents — none ran in this session yet (delegate / team create them)",
      items: [{ label: "(empty)", hint: "run a task that delegates", value: "ok" }],
      pageSize: 2,
    });
    return null;
  }
  const sel = await pick({
    title: `Sub-agents — ${runningAgents().length} running, ${evs.length} total · Enter: detail`,
    items: evs.map((e) => ({
      label: `${e.state === "running" ? "▸" : e.state === "error" ? "✗" : "✓"} ${e.name}`,
      hint: `${e.steps} steps · ${e.toolsUsed.slice(-3).join(",") || "no tools"} · ${e.task.slice(0, 40)}`,
      value: e,
    })),
    pageSize: 12,
  });
  return sel ? sel.value : null;
}

// ---------- MCP status ----------
// Real connection objects: name, protocol state, tools reported by the server.
export function mcpStatusRows({ cfgMcp = {}, connections = [] } = {}) {
  const rows = [];
  for (const [name, spec] of Object.entries(cfgMcp)) {
    const conn = connections.find((c) => c.name === name);
    const down = conn?.exitedCode !== undefined;
    const state = conn ? (down ? `DOWN (exited, code ${conn.exitedCode})` : "connected") : "configured, not connected";
    const nTools = conn?.tools?.length ?? 0;
    rows.push({
      name,
      state,
      connected: !!conn && !down,
      tools: conn?.tools?.map((t) => t.name) || [],
      label: `${conn ? (down ? "✗" : "●") : "○"} ${name}`,
      hint: `${state}${nTools ? ` · ${nTools} tools: ${conn.tools.slice(0, 4).join(",").length ? conn.tools.slice(0, 4).map((t) => t.name).join(",") : ""}` : ""}`,
      value: { name, conn, spec },
    });
  }
  return rows;
}

export async function mcpPanel({ cfgMcp = {}, connections = [] } = {}) {
  const rows = mcpStatusRows({ cfgMcp, connections });
  if (!rows.length) {
    await pick({
      title: "MCP servers — none configured ([mcp_servers] in config.toml, /provider for setup)",
      items: [{ label: "(none)", value: "ok" }],
      pageSize: 2,
    });
    return null;
  }
  const sel = await pick({
    title: `MCP status — ${rows.filter((r) => r.connected).length}/${rows.length} connected`,
    items: rows,
    pageSize: 12,
  });
  if (sel?.value?.conn?.tools?.length) {
    await pick({
      title: `${sel.value.name} — ${sel.value.conn.tools.length} tools · Esc: back`,
      items: sel.value.conn.tools.map((t) => ({ label: t.name || "?", hint: (t.description || "").slice(0, 60), value: t.name })),
      pageSize: 12,
    });
  }
  return sel ? sel.value : null;
}

// ---------- plugin status ----------
// Real installed plugins: read from ~/.rtools/plugins.toml (readInstalled) and
// pluginInstalledNames; each installed plugin dir is checked on disk.
// Real installed-plugin rows (testable without a TTY).
export function pluginStatusRows({ skillsDirs = [] } = {}) {
  const installed = pluginInstalledNames(); // { mcp: [...], plugins: [...] }
  const installedMcp = readInstalled(); // ~/.rtools/plugins.toml mcp_servers
  const rows = [];
  for (const name of [...installed.mcp, ...installed.plugins]) {
    let kind = "plugin";
    let detail = "";
    if (installedMcp[name]) {
      kind = "mcp";
      detail = String(installedMcp[name].command || installedMcp[name].url || "");
    } else {
      const found = skillsDirs.some((d) => {
        try { return statSync(path.join(d, name)).isDirectory(); } catch { return false; }
      });
      detail = found ? "skill on disk" : "not found on disk";
    }
    rows.push({ name, kind, detail, label: `${installedMcp[name] ? "●" : "○"} ${name}`, hint: `${kind} · ${detail}`, value: { name, kind } });
  }
  return rows;
}

export async function pluginsPanel({ skillsDirs = [] } = {}) {
  const rows = pluginStatusRows({ skillsDirs });
  if (!rows.length) {
    await pick({
      title: "Plugins — none installed (rt plugin install <name>, /plugin list)",
      items: [{ label: "(none)", value: "ok" }],
      pageSize: 2,
    });
    return null;
  }
  const sel = await pick({
    title: `Plugins — ${rows.length} installed (real state from plugins.toml + disk)`,
    items: rows,
    pageSize: 12,
  });
  return sel ? sel.value : null;
}
