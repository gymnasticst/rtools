// Custom keybindings: user keybindings.toml (same dirs as config.toml)
// overrides the built-in REPL shortcuts. Only action names may be bound;
// reserved keys (Ctrl+C hard interrupt) cannot be redefined.
//
//   [keybindings]
//   palette = "ctrl+p"
//   settings = "ctrl+o"
//   multiline_editor = "ctrl+g"
//   copy_last = "ctrl+y"
//
// Format: a single chord "ctrl+shift+p" / "alt+enter" / "f5" / "escape".

export const ACTIONS = {
  palette: { default: "ctrl+p", description: "command & file palette" },
  settings: { default: "ctrl+o", description: "settings menu" },
  multiline_editor: { default: "ctrl+g", description: "open the external editor" },
  copy_last: { default: "ctrl+y", description: "copy the last answer" },
  interrupt: { default: "ctrl+c", description: "interrupt the current step", reserved: true },
};

const CHORD_RE = /^(?:(?:ctrl|alt|shift)\+)*(?:f(?:[1-9]|1[0-2])|escape|enter|tab|backspace|[a-z0-9])$/i;

export function normalizeChord(chord) {
  const parts = String(chord).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    if (p === "ctrl" || p === "alt" || p === "shift") mods.add(p);
    else if (key === null) key = p;
    else return null; // two non-modifier keys
  }
  if (key === null) return null;
  const k = /^[a-z0-9]$/.test(key) || /^(f(?:[1-9]|1[0-2])|escape|enter|tab|backspace)$/.test(key) ? key : null;
  if (!k) return null;
  return [...mods].sort().map((m) => m + "+").join("") + k;
}

// Returns { action: chord } with defaults applied, then user overrides.
// Unknown actions and invalid chords are reported, not applied.
export function loadKeybindings(cfg = {}) {
  const user = cfg?.keybindings || {};
  const bindings = {};
  const problems = [];
  for (const [action, spec] of Object.entries(ACTIONS)) bindings[action] = spec.default;
  for (const [action, chord] of Object.entries(user)) {
    if (!ACTIONS[action]) {
      problems.push(`unknown action "${action}" (known: ${Object.keys(ACTIONS).join(", ")})`);
      continue;
    }
    if (ACTIONS[action].reserved) {
      problems.push(`"${action}" is reserved and cannot be rebound`);
      continue;
    }
    const norm = normalizeChord(chord);
    if (!norm) {
      problems.push(`invalid chord "${chord}" for ${action}`);
      continue;
    }
    bindings[action] = norm;
  }
  // a chord bound to two actions keeps the first; later duplicates are dropped
  const seen = new Set();
  for (const [action, chord] of Object.entries(bindings)) {
    if (seen.has(chord)) { problems.push(`duplicate binding for ${chord} (${action} ignored)`); continue; }
    seen.add(chord);
  }
  return { bindings, problems };
}

// node keypress name for a stored chord ("ctrl+p" -> matches key.ctrl && key.name === "p")
export function matchKeypress(key, chord) {
  if (!key || !chord) return false;
  const parts = chord.split("+");
  const keyName = parts[parts.length - 1];
  const needCtrl = parts.includes("ctrl");
  const needAlt = parts.includes("alt");
  const needShift = parts.includes("shift");
  const isFn = /^f(?:[1-9]|1[0-2])$/.test(keyName);
  if (isFn) return key.name === keyName && !!key.ctrl === needCtrl && !!key.meta === needAlt;
  const pressed = key.name || "";
  const plainMatch = pressed.length === 1 ? pressed === keyName : pressed === keyName;
  return plainMatch && (needCtrl ? !!key.ctrl : !key.ctrl) && (needAlt ? !!key.meta : !key.meta) && (!!key.shift === needShift);
}
