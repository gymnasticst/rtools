// Session persistence (/resume) and context compaction (/compact)
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SESSIONS_DIR = () => path.join(os.homedir(), ".rtools", "sessions");

export async function saveSession({ id, model, provider, messages, cwd }) {
  await mkdir(SESSIONS_DIR(), { recursive: true });
  const file = path.join(SESSIONS_DIR(), `${id}.json`);
  await writeFile(file, JSON.stringify({ id, model, provider, messages, cwd, saved_at: new Date().toISOString() }), "utf8");
  return file;
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
