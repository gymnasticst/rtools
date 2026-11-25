// Unified-diff previews for tool approvals (no dependencies, small LCS-free
// diff via common prefix/suffix trimming — good enough for a preview).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function unifiedDiff(oldText = "", newText = "", { file = "file", context = 3 } = {}) {
  const a = String(oldText).split("\n");
  const b = String(newText).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return "";
  const ctx0 = Math.max(0, start - context);
  const aEnd = Math.min(a.length, endA + context);
  const bEnd = Math.min(b.length, endB + context);
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -${ctx0 + 1},${aEnd - ctx0} +${ctx0 + 1},${bEnd - ctx0} @@`];
  for (let i = ctx0; i < start; i++) lines.push(" " + a[i]);
  for (let i = start; i < endA; i++) lines.push("-" + a[i]);
  for (let i = start; i < endB; i++) lines.push("+" + b[i]);
  for (let i = endB; i < bEnd; i++) lines.push(" " + b[i]);
  return lines.join("\n");
}

const cap = (s, max = 4000, lines = 60) => {
  const cut = s.split("\n").slice(0, lines).join("\n");
  return cut.length > max ? cut.slice(0, max) + "\n…(truncated)" : cut;
};

// Human-readable preview of what a tool call would do, shown before the
// y/n approval. Returns "" when nothing can be shown.
export function approvalPreview(tool, args, cwd) {
  if (!args) return "";
  try {
    if (tool.name === "shell") return cap(`$ ${args.command || args.cmd || ""}`);
    if (tool.name === "write_file") {
      const abs = path.resolve(cwd, args.path);
      const old = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      return cap(unifiedDiff(old, args.content ?? "", { file: args.path }));
    }
    if (tool.name === "edit") {
      const abs = path.resolve(cwd, args.path);
      const old = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      if (!old) return cap(`edit ${args.path} — new content:\n${args.new_string ?? ""}`);
      const all = args.replace_all ? " (all occurrences)" : "";
      const replaced = old.includes(args.old_string)
        ? old.split(args.old_string).join(args.new_string ?? "")
        : `<<old_string not found>>\n${args.new_string ?? ""}`;
      const header = old.includes(args.old_string) ? "" : `warning: old_string not found in ${args.path}${all}\n`;
      return cap(header + unifiedDiff(old, replaced, { file: args.path }));
    }
    if (tool.name === "apply_patch") return cap(String(args.patch ?? ""));
  } catch {
    // fall through to the generic preview
  }
  try {
    return cap(JSON.stringify(args, null, 2));
  } catch {
    return "";
  }
}
