// Vim mode for the REPL input line (openclaude src/vim-style, minimal but
// real): normal/insert/visual-free modal editing with motions, operators and
// registers over a plain string cursor model. Used by repl.js raw keypresses
// when config `vim_mode = true`.

export function createVimState(initial = "") {
  return { line: initial, cursor: 0, mode: "normal", register: "", pending: null };
}

// Applies one printable char or named key to the state; returns true if the
// event was consumed (caller then re-renders the line).
export function vimKey(st, key) {
  if (st.mode === "insert") {
    if (key.name === "escape") { st.mode = "normal"; st.cursor = Math.max(0, st.cursor - (st.cursor > 0 && st.cursor >= st.line.length ? 1 : 0)); return true; }
    if (key.name === "backspace") {
      if (st.cursor > 0) { st.line = st.line.slice(0, st.cursor - 1) + st.line.slice(st.cursor); st.cursor--; }
      return true;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      st.line = st.line.slice(0, st.cursor) + key.sequence + st.line.slice(st.cursor);
      st.cursor++;
      return true;
    }
    return false; // arrows etc. fall through to the default handler
  }
  // normal mode
  if (key.sequence === "i") { st.mode = "insert"; return true; }
  if (key.sequence === "a") { st.mode = "insert"; st.cursor = Math.min(st.line.length, st.cursor + 1); return true; }
  if (key.sequence === "A") { st.mode = "insert"; st.cursor = st.line.length; return true; }
  if (key.sequence === "0") { st.cursor = 0; return true; }
  if (key.sequence === "$") { st.cursor = Math.max(0, st.line.length - 1); return true; }
  if (key.name === "left" || key.sequence === "h") { st.cursor = Math.max(0, st.cursor - 1); return true; }
  if (key.name === "right" || key.sequence === "l") { st.cursor = Math.min(Math.max(0, st.line.length - 1), st.cursor + 1); return true; }
  if (!st.pending && key.sequence === "w") {
    const m = /\S+\s*/y; m.lastIndex = st.cursor + 1;
    const r = m.exec(st.line);
    st.cursor = r ? Math.min(st.line.length - 1, st.cursor + 1 + r[0].length - (r[0].endsWith(" ") ? 0 : 0)) : Math.max(0, st.line.length - 1);
    if (r) st.cursor = Math.min(st.line.length - 1, m.lastIndex);
    return true;
  }
  if (key.sequence === "b") {
    const left = st.line.slice(0, st.cursor).replace(/\s*\S+\s*$/, "");
    st.cursor = left.length;
    return true;
  }
  if ((key.sequence === "d" || key.sequence === "c" || key.sequence === "y") && !st.pending) {
    st.pending = key.sequence;
    return true;
  }
  if (st.pending) {
    const op = st.pending;
    st.pending = null;
    const delRange = (to) => {
      const [a, b] = [Math.min(st.cursor, to), Math.max(st.cursor, to) + (to >= st.cursor ? 1 : 0)];
      const cut = st.line.slice(a, b);
      st.register = cut;
      st.line = st.line.slice(0, a) + st.line.slice(b);
      if (op === "c") { st.cursor = a; st.mode = "insert"; }
      else st.cursor = Math.min(a, Math.max(0, st.line.length - 1));
    };
    if (key.sequence === "w") {
      const rest = st.line.slice(st.cursor);
      const m = rest.match(/^\s*\S+/);
      const to = st.cursor + (m ? m[0].length : rest.length) - 1;
      delRange(Math.min(st.line.length - 1, Math.max(st.cursor, to)));
      return true;
    }
    if (key.sequence === "d" || key.sequence === "D") {
      if (op === "d") { st.register = st.line; st.line = ""; st.cursor = 0; return true; }
    }
    if (key.sequence === "0") { delRange(0); return true; }
    if (key.sequence === "$") { delRange(Math.max(0, st.line.length - 1)); return true; }
    st.pending = op === "c" ? "c" : null; // cancel unknown operator target
    return true;
  }
  if (key.sequence === "p") {
    if (st.register) {
      st.line = st.line.slice(0, st.cursor + 1) + st.register + st.line.slice(st.cursor + 1);
      st.cursor = Math.min(st.line.length - 1, st.cursor + st.register.length);
    }
    return true;
  }
  if (key.name === "backspace") { st.cursor = Math.max(0, st.cursor - 1); return true; }
  return false;
}

export function renderPrompt(st) {
  const mark = st.mode === "insert" ? "insert" : "normal";
  return { text: st.line, cursor: st.cursor, mode: mark };
}
