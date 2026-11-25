// /share, /summary, /wiki: export the session and generate documentation.
// All three write markdown files next to the conversation output.

// Transcript to markdown (used by /share).
export function sessionToMarkdown({ id, model, provider, messages }) {
  const lines = [`# Session ${id || "(unsaved)"}`, "", `Model: ${model || "?"} (${provider || "?"})`, ""];
  for (const m of messages) {
    if (m.role === "system") continue;
    const who = m.role === "user" ? "## User" : m.role === "assistant" ? "## Assistant" : `## ${m.role}`;
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c) => (c.type === "text" ? c.text : c.type === "tool_use" ? `\`\`\`\n${c.name} ${JSON.stringify(c.input)}\n\`\`\`` : `[${c.type}]`)).join("\n\n")
        : String(m.content ?? "");
    lines.push(who, "", content.trim() || "(empty)", "");
  }
  return lines.join("\n");
}

// Structured summary from the transcript (used by /summary and /wiki).
export function summarizeTranscript(messages) {
  const turns = messages.filter((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("/"));
  const answers = messages.filter((m) => m.role === "assistant");
  const toolUses = messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_use") : []));
  const byTool = new Map();
  for (const t of toolUses) byTool.set(t.name, (byTool.get(t.name) || 0) + 1);
  const files = new Set();
  for (const t of toolUses) {
    const p = t.input?.file_path || t.input?.path;
    if (p) files.add(p);
  }
  return { userTurns: turns.map((t) => t.content), answerCount: answers.length, toolCalls: [...byTool.entries()], files: [...files] };
}

export function summaryToMarkdown(summary, { id } = {}) {
  const lines = [`# Session summary${id ? ` — ${id}` : ""}`, ""];
  lines.push(`User requests (${summary.userTurns.length}):`);
  for (const t of summary.userTurns) lines.push(`- ${t.split("\n")[0].slice(0, 120)}`);
  lines.push("", `Assistant answers: ${summary.answerCount}`);
  if (summary.toolCalls.length) {
    lines.push("", "Tool usage:");
    for (const [name, n] of summary.toolCalls) lines.push(`- ${name}: ${n}`);
  }
  if (summary.files.length) {
    lines.push("", "Files touched:");
    for (const f of summary.files) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}

// /wiki: one markdown page per top-level source directory + an index, written
// into <outDir>. Content is derived from the real repo tree, not invented.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname, sep as pathSep } from "node:path";

const CODE_EXTS = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".sh"]);

export function buildWiki(repo, { maxFilesPerSection = 30 } = {}) {
  const sections = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE_EXTS.has(extname(e.name))) {
        const rel = relative(repo, p);
        const top = rel.includes(pathSep) ? rel.split(pathSep)[0] : "(root)";
        if (!sections.has(top)) sections.set(top, []);
        if (sections.get(top).length < maxFilesPerSection) sections.get(top).push(rel);
      }
    }
  };
  walk(repo);
  const pages = [];
  for (const [section, files] of sections) {
    const body = [`# ${section}`, "", `${files.length} source file(s).`, ""];
    for (const f of files) {
      let head = "";
      try {
        head = readFileSync(join(repo, f), "utf8").split("\n").find((l) => l.trim()) || "";
      } catch {}
      body.push(`- \`${f}\`${head ? ` — starts with: \`${head.slice(0, 90)}\`` : ""}`);
    }
    pages.push({ file: `wiki-${section.replace(/[^\w-]/g, "_")}.md`, markdown: body.join("\n") });
  }
  const index = ["# Project wiki", "", "Sections:", "", ...pages.map((p) => `- [${p.file}](./${p.file})`)].join("\n");
  return { pages: [{ file: "wiki-index.md", markdown: index }, ...pages] };
}
