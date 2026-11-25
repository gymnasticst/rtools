// OpenCode-style palette UI: raw-mode, ANSI-redrawn pickers used by the REPL
// for the Ctrl+P command palette and the Ctrl+O settings screen. Requires a
// TTY that already emits keypress events (the REPL's readline sets that up).
// Keybinds: Ctrl+P command palette, Ctrl+O settings; inside: type to filter,
// arrows move, Enter selects, Esc / Ctrl+C cancel.

export const PALETTE_CANCEL = Symbol("palette-cancel");

const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;

const width = () => process.stdout.columns || 60;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function rowFor(item, selected) {
  const cursor = selected ? CYAN("› ") : "  ";
  const label = selected ? BOLD(item.label) : item.label;
  const hint = item.hint ? DIM(clip(item.hint, Math.max(8, width() - item.label.length - 10))) : "";
  return `${cursor}${label}  ${hint}`;
}

function windowFor(n, sel, max) {
  if (n <= max) return [0, n];
  const start = Math.max(0, Math.min(sel - Math.floor(max / 2), n - max));
  return [start, start + max];
}

// Common raw-mode keypress loop. `onKey(str, key)` handles one key; call
// `finish(value)` to resolve. Renders via `render()` set up by the caller.
function captureKeys({ onKey, finish, cleanup }) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const { promise, resolve } = Promise.withResolvers();
  let done = false;
  const listener = (str, key) => {
    if (done || !key) return;
    if (key.ctrl && key.name === "c") return stop(null);
    onKey(str, key);
  };
  const stop = (value) => {
    if (done) return;
    done = true;
    process.stdin.removeListener("keypress", listener);
    cleanup();
    process.stdin.setRawMode(wasRaw);
    resolve(value);
  };
  process.stdin.on("keypress", listener);
  return Object.assign(promise, { finish: (v) => stop(v) });
}

// Searchable picker. items: { label, hint?, value }. Resolves the selected
// value, null on Esc, PALETTE_CANCEL on Ctrl+C (distinguishable from Esc).
export function pick({ title, items, pageSize = 8 }) {
  let filter = "";
  let sel = 0;
  let printed = 0;
  const matches = () => {
    const f = filter.toLowerCase();
    return items.filter((i) => !f || i.label.toLowerCase().includes(f) || (i.hint || "").toLowerCase().includes(f));
  };
  const render = () => {
    const list = matches();
    sel = Math.max(0, Math.min(sel, list.length - 1));
    const [a, b] = windowFor(list.length, sel, pageSize);
    const lines = [
      DIM(`${title}`),
      `${DIM("filter ▸ ")}${filter}${DIM("  (↑/↓ · Enter · Esc)")}`,
      ...list.slice(a, b).map((item, i) => rowFor(item, a + i === sel)),
    ];
    if (!list.length) lines.push(DIM("  (no matches)"));
    if (printed) process.stdout.write(`\x1b[${printed}A\x1b[J`);
    process.stdout.write(lines.join("\n") + "\n");
    printed = lines.length;
  };
  const cleanup = () => {
    if (printed) process.stdout.write(`\x1b[${printed}A\x1b[J`);
    printed = 0;
  };
  const cap = captureKeys({
    cleanup,
    onKey: (str, key) => {
      if (key.name === "up") { sel--; render(); return; }
      if (key.name === "down") { sel++; render(); return; }
      if (key.name === "return" || key.name === "enter") {
        const list = matches();
        return cap.finish(list[sel] ? list[sel].value : null);
      }
      if (key.name === "backspace") { filter = filter.slice(0, -1); sel = 0; render(); return; }
      if (str && !key.ctrl && !key.meta && str >= " ") { filter += str; sel = 0; render(); }
    },
  });
  if (cap === null) return Promise.resolve(null);
  render();
  return cap;
}

// One-line text input with an initial value. Resolves the string or null.
export function typeText({ title, prompt = "", initial = "" }) {
  let buf = String(initial);
  let printed = 0;
  const render = () => {
    const lines = [DIM(title), `${DIM(prompt + " ▸ ")}${buf}\x1b[K`];
    if (printed) process.stdout.write(`\x1b[${printed}A\x1b[J`);
    process.stdout.write(lines.join("\n") + "\n");
    printed = lines.length;
  };
  const cleanup = () => {
    if (printed) process.stdout.write(`\x1b[${printed}A\x1b[J`);
    printed = 0;
  };
  const cap = captureKeys({
    cleanup,
    onKey: (str, key) => {
      if (key.name === "return" || key.name === "enter") return cap.finish(buf);
      if (key.name === "backspace") { buf = buf.slice(0, -1); render(); return; }
      if (str && !key.ctrl && !key.meta && str >= " ") { buf += str; render(); }
    },
  });
  if (cap === null) return Promise.resolve(null);
  render();
  return cap;
}

// Single-key y/N confirm printed on the current line. Resolves true/false.
export function confirm({ prompt }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdout.write(`${prompt} `);
    const listener = (str, key) => {
      if (!key) return;
      process.stdin.removeListener("keypress", listener);
      process.stdin.setRawMode(wasRaw);
      const yes = str === "y" || str === "Y";
      process.stdout.write(`${str ?? ""}\n`);
      resolve(yes);
    };
    process.stdin.on("keypress", listener);
  });
}
