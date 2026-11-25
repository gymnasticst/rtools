// TUI in the Codex style: rounded banner, live status bar, spinner,
// streamed assistant text, inline tool notices. Terminal-only (ANSI).
import { execSync, execFileSync } from "node:child_process";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// Plain mode: no ANSI at all (NO_COLOR env, non-TTY, or theme = "plain" in config).
export const plain = Boolean(process.env.NO_COLOR) || process.stdout.isTTY === false;

export function theme(cfg = {}) {
  if (cfg.theme === "plain" || (plain && !cfg.color)) {
    return Object.fromEntries(Object.keys(C).map((k) => [k, (s) => String(s)]));
  }
  return C;
}

function termWidth() {
  try {
    return process.stdout.columns || 60;
  } catch {
    return 60;
  }
}

function shorten(p) {
  return p.startsWith(osHome()) ? "~" + p.slice(osHome().length) : p;
}
function osHome() {
  return process.env.HOME || "";
}

export function banner({ version, model, effort, provider, cwd }) {
  const w = Math.min(termWidth(), 58);
  const top = "╭" + "─".repeat(w - 2) + "╮";
  const bot = "╰" + "─".repeat(w - 2) + "╯";
  const row = (label, value) => {
    const text = ` ${label}${value}`;
    return "│" + text + " ".repeat(Math.max(1, w - 2 - text.replace(/\x1b\[[0-9;]*m/g, "").length)) + "│";
  };
  console.log(
    [
      "",
      C.cyan(top),
      C.cyan(row(C.bold(`>_ RTools`), C.gray(`(${version})`))),
      C.cyan(row("", "")),
      C.cyan(row("model:     ", `${model} ${C.gray(effort)} ${C.gray("/model to change")}`)),
      C.cyan(row("provider:  ", provider)),
      C.cyan(row("directory: ", shorten(cwd))),
      C.cyan(bot),
      "",
      "  To get started, describe a task or try one of these commands:",
      "",
      C.gray("  /init - create an AGENTS.md file with instructions for RTools"),
      C.gray("  /status - show current session configuration"),
      C.gray("  /permissions - choose what RTools is allowed to do"),
      C.gray("  /model - choose what model and reasoning effort to use"),
      C.gray("  /review - review any changes and find issues"),
      "",
    ].join("\n")
  );
}

export function statusBar({ model, effort, tokensLeft = 100, tokensUsed = 0, git = "", jobs = 0 }) {
  const parts = [`  ${tokensLeft}% context left`, `~${tokensUsed} tok`];
  if (git) parts.push(git);
  parts.push(`${model} ${effort}`);
  if (jobs) parts.push(`${jobs} job${jobs > 1 ? "s" : ""}`);
  parts.push("? for shortcuts");
  return C.gray(parts.join(" · "));
}

// "main*" / "(no git)" for the status bar.
export function gitStatus() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
    return dirty ? `${branch}*` : branch;
  } catch {
    return "(no git)";
  }
}

// Copy text to the system clipboard: native tools first, OSC52 escape as a
// fallback (works over ssh in supported terminals). Returns "" or an error.
export function copyToClipboard(text) {
  for (const [cmd, args] of [["xclip", ["-selection", "clipboard"]], ["wl-copy", []], ["pbcopy", []]]) {
    try {
      const { execFileSync } = { execFileSync };
      execFileSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return "";
    } catch {}
  }
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    return "";
  } catch (e) {
    return e.message;
  }
}

export class Spinner {
  constructor(label) {
    this.label = label;
    this.frame = 0;
    this.timer = null;
  }
  start() {
    if (process.stdout.isTTY === false) return this; // no spinner without TTY
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const f = C.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]);
      const secs = Math.floor((Date.now() - this.startedAt) / 1000);
      process.stdout.write(`\r  ${f} ${this.label}${C.gray(`… ${secs}s`)}   `);
      this.frame++;
    }, 90);
    return this;
  }
  // Update the label while spinning (e.g. last shell output line).
  setLabel(label) {
    this.label = String(label).slice(0, 60);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write("\r\x1b[K");
    }
  }
}

// tool call notice, Codex-style: `• ran echo "hi"` with the first output line
export function toolNotice(name, detail) {
  console.log(C.gray(`  • ${name}: ${String(detail).slice(0, 100).replace(/\n/g, " ")}`));
}

export function turnStart(text) {
  console.log(C.bold(`\n› ${text}`));
}

export function agentText() {
  // plain streaming already; kept for symmetry
}

// Streamed Markdown highlighting: bolds headings, dims fenced code blocks,
// underlines inline code. Chunk-based — state (in a code fence) persists
// across chunks of one answer via the returned closer.
export function mdStreamer(opts = {}) {
  const t = theme(opts);
  let inFence = false;
  let lineBuf = "";
  const colorize = (line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return t.gray("  ┌ " + line.trim());
    }
    if (inFence) return t.gray("  │ " + line);
    let out = line.replace(/`([^`]+)`/g, (m, code) => t.cyan(code));
    out = out.replace(/^(#{1,6})\s+(.*)$/, (m, h, rest) => t.bold(rest));
    out = out.replace(/^(\s*)([-*])\s+/, (m, sp, b) => sp + t.cyan("•") + " ");
    return out;
  };
  return {
    write(chunk) {
      lineBuf += String(chunk);
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // keep the partial last line buffered
      for (const line of lines) process.stdout.write(colorize(line) + "\n");
    },
    end() {
      if (lineBuf) process.stdout.write(colorize(lineBuf));
      lineBuf = "";
    },
  };
}
