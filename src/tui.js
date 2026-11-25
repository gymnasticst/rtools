// TUI in the Codex style: rounded banner, live status bar, spinner,
// streamed assistant text, inline tool notices. Terminal-only (ANSI).
import { execSync } from "node:child_process";

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

export function statusBar({ model, effort, tokensLeft = 100, tokensUsed = 0 }) {
  return C.gray(`  ${tokensLeft}% context left · ~${tokensUsed} tok · ${model} ${effort} · ? for shortcuts`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  constructor(label) {
    this.label = label;
    this.frame = 0;
    this.timer = null;
  }
  start() {
    if (process.stdout.isTTY === false) return this; // no spinner without TTY
    this.timer = setInterval(() => {
      const f = C.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]);
      process.stdout.write(`\r  ${f} ${this.label}${C.gray("…")}   `);
      this.frame++;
    }, 90);
    return this;
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
