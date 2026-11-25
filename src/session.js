// Session persistence (/resume) and context compaction (/compact)
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SESSIONS_DIR = () => path.join(os.homedir(), ".rtools", "sessions");

const MAX_SESSIONS = () => Number(process.env.RTOOLS_MAX_SESSIONS) || 50;

export async function saveSession({ id, model, provider, messages, cwd }) {
  await mkdir(SESSIONS_DIR(), { recursive: true });
  const file = path.join(SESSIONS_DIR(), `${id}.json`);
  await writeFile(file, JSON.stringify({ id, model, provider, messages, cwd, saved_at: new Date().toISOString() }), "utf8");
  try {
    await pruneSessions(MAX_SESSIONS());
  } catch {
    // pruning is best-effort
  }
  return file;
}

// Keep only the newest `max` session files; returns the number removed.
export async function pruneSessions(max) {
  const all = await listSessions();
  const old = all.slice(max);
  for (const s of old) {
    try {
      await unlink(path.join(SESSIONS_DIR(), `${s.id}.json`));
    } catch {
      // already gone
    }
  }
  return old.length;
}

export async function listSessions() {
  try {
    const files = await readdir(SESSIONS_DIR());
    const out = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const s = JSON.parse(await readFile(path.join(SESSIONS_DIR(), f), "utf8"));
        const firstUser = s.messages.find((m) => m.role === "user")?.content?.slice(0, 60) || "(empty)";
        out.push({ id: s.id, model: s.model, saved_at: s.saved_at, preview: firstUser });
      } catch {
        // skip corrupt sessions
      }
    }
    return out.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));
  } catch {
    return [];
  }
}

export async function loadSession(id) {
  return JSON.parse(await readFile(path.join(SESSIONS_DIR(), `${id}.json`), "utf8"));
}

// Compaction: replace all but the system message and the last `keep` messages
// with a summary user message.
export function compactMessages(messages, keep = 6) {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= keep) return null;
  const head = rest.slice(0, rest.length - keep);
  const tail = rest.slice(-keep);
  const digest = head
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      const toolInfo = (m.tool_calls || []).map((tc) => `[called ${tc.function.name}]`).join(" ");
      return `${m.role}: ${(text || toolInfo).slice(0, 200)}`;
    })
    .join("\n");
  const summary = {
    role: "user",
    content: `[Earlier conversation, compacted. Digest of the older part:\n${digest}\nContinue from here.]`,
  };
  return [...system, summary, ...tail];
}

// Rough context-size estimate (~4 chars per token) for the status bar.
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    for (const tc of m.tool_calls || []) chars += (tc.function?.arguments || "").length + tc.function?.name.length;
  }
  return Math.ceil(chars / 4);
}

// Export a session to Markdown (chat + tool calls) for reports and reviews.
// Returns the path of the written file.
export async function exportSession({ id = "session", messages, model, provider, outPath }) {
  const lines = [
    `# RTools session ${id}`,
    "",
    `- model: ${model || "(unknown)"}`,
    `- provider: ${provider || "(unknown)"}`,
    `- exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  for (const m of messages || []) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      lines.push(`## User`, "", `${m.content}`, "");
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`## Assistant`, "", `${m.content}`, "");
      for (const tc of m.tool_calls || []) {
        lines.push(`- called \`${tc.function?.name}\` with \`${tc.function?.arguments}\``);
      }
      if (m.tool_calls?.length) lines.push("");
    } else if (m.role === "tool") {
      lines.push(`<details><summary>tool result</summary>`, "", "````", `${String(m.content).slice(0, 4000)}`, "````", "</details>", "");
    }
  }
  const { writeFile } = await import("node:fs/promises");
  const file = outPath || `rtools-session-${String(id).slice(0, 8)}.md`;
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}
