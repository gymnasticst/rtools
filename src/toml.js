// Minimal TOML-subset parser: [tables], [[arrays of tables]], dotted keys,
// strings (single/double quoted), numbers, booleans, single-line arrays.

function stripComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function splitDotted(s) {
  return s.split(".").map((p) => p.trim().replace(/^["']|["']$/g, ""));
}

function parseString(s) {
  const quote = s[0];
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"' && ch === "\\") {
      const next = s[++i];
      out += { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[next] ?? next;
    } else if (ch === quote) {
      return out;
    } else out += ch;
  }
  throw new Error("TOML: unterminated string");
}

function parseValue(s) {
  s = s.trim();
  if (!s) throw new Error("TOML: missing value");
  if (s[0] === '"' || s[0] === "'") return parseString(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s[0] === "{") {
    const obj = {};
    const inner = s.slice(1, s.lastIndexOf("}"));
    let depth = 0, inStr = null, part = "";
    const parts = [];
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inStr) {
        part += ch;
        if (ch === "\\") { part += inner[++i]; continue; }
        if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") { inStr = ch; part += ch; }
      else if (ch === "{" || ch === "[") { depth++; part += ch; }
      else if (ch === "}" || ch === "]") { depth--; part += ch; }
      else if (ch === "," && depth === 0) { parts.push(part); part = ""; }
      else part += ch;
    }
    if (part.trim()) parts.push(part);
    for (const item of parts) {
      const eq = item.indexOf("=");
      if (eq < 0) throw new Error(`TOML: bad inline table item: ${item}`);
      const rawKey = item.slice(0, eq).trim();
      obj[/^["']/.test(rawKey) ? parseString(rawKey) : rawKey] = parseValue(item.slice(eq + 1));
    }
    return obj;
  }
  if (s[0] === "[") {
    const items = [];
    let depth = 0, start = 1, inStr = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "[") depth++;
      else if (ch === "]") depth--;
      else if (ch === "," && depth === 1) {
        items.push(s.slice(start, i));
        start = i + 1;
      }
    }
    items.push(s.slice(start, s.lastIndexOf("]")));
    return items.filter((x) => x.trim()).map((x) => parseValue(x));
  }
  const num = Number(s);
  if (!Number.isNaN(num)) return num;
  throw new Error(`TOML: cannot parse value: ${s}`);
}

function findEq(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "=") return i;
  }
  return -1;
}

function getTable(root, path, create) {
  let cur = root;
  for (const key of path) {
    if (typeof cur[key] !== "object" || cur[key] === null) {
      if (!create) throw new Error(`TOML: unknown table ${path.join(".")}`);
      cur[key] = {};
    }
    cur = cur[key];
  }
  return cur;
}

export function parseTOML(text) {
  const root = {};
  let cur = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[")) {
      const path = splitDotted(line.slice(2, -2).trim());
      const parent = getTable(root, path.slice(0, -1), true);
      const key = path[path.length - 1];
      if (!Array.isArray(parent[key])) parent[key] = [];
      cur = {};
      parent[key].push(cur);
      continue;
    }
    if (line.startsWith("[")) {
      cur = getTable(root, splitDotted(line.slice(1, -1).trim()), true);
      continue;
    }
    const eq = findEq(line);
    if (eq < 0) throw new Error(`TOML: cannot parse line: ${rawLine}`);
    const keyPath = splitDotted(line.slice(0, eq).trim());
    const value = parseValue(line.slice(eq + 1));
    const parent = getTable(cur, keyPath.slice(0, -1), true);
    parent[keyPath[keyPath.length - 1]] = value;
  }
  return root;
}
