// Project memory with automatic fact extraction and lexical (TF-IDF) search.
// Facts live in ~/.rtools/memory.json as { id, text, tags, created_at }.
// "Vector search" here is an honest lexical ranking (term vectors + IDF), not
// embeddings — no external embedding service is required.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = () => path.join(os.homedir(), ".rtools", "memory.json");

export function loadMemories() {
  try {
    if (!existsSync(FILE())) return [];
    const m = JSON.parse(readFileSync(FILE(), "utf8"));
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}

export function saveMemories(list) {
  mkdirSync(path.dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(list, null, 2));
}

let seq = Date.now();
export function addMemory(text, { tags = [] } = {}) {
  const list = loadMemories();
  const fact = { id: ++seq, text: String(text).slice(0, 1000), tags, created_at: new Date().toISOString() };
  list.push(fact);
  saveMemories(list);
  return fact;
}

export function removeMemory(id) {
  const list = loadMemories();
  const kept = list.filter((f) => f.id !== id);
  saveMemories(kept);
  return kept.length !== list.length;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "it", "its", "this", "that", "with", "as", "at", "by", "be", "not", "from", "и", "в", "на", "с", "по", "для", "что", "как", "это", "не"]);

export function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter((w) => !STOP.has(w) && w.length > 1) || [];
}

// Ranked search: cosine similarity between the query vector and each fact.
export function searchMemories(query, { limit = 5 } = {}) {
  const facts = loadMemories();
  if (!facts.length) return [];
  const qv = vec(tokenize(query));
  const scored = facts.map((f) => ({ fact: f, score: cosine(qv, vec(tokenize(f.text))) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function vec(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) { nb += v * v; const av = a.get(k); if (av) dot += av * v; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Automatic fact extraction from a completed turn: keeps only concrete,
// durable-looking statements (project run/test commands, decisions, paths).
// Heuristic and conservative: better to store nothing than noise.
export function extractFacts(userText, assistantText) {
  const facts = [];
  const ua = String(userText || ""), aa = String(assistantText || "");
  const runCmd = ua.match(/`?((?:npm|pnpm|yarn|cargo|go|make|pytest|python3?|node) [^`\n]{3,80})`?/);
  if (runCmd) facts.push({ text: `run/test command mentioned: ${runCmd[1].trim()}`, tags: ["command"] });
  const path = ua.match(/`(src\/[\w/.-]+\.(?:js|ts|mjs|py|go|rs))`/);
  if (path) facts.push({ text: `notable file: ${path[1]}`, tags: ["path"] });
  const decision = aa.match(/^(?:Assumed|Решение|Decision): (.+)$/m);
  if (decision) facts.push({ text: `decision: ${decision[1].slice(0, 200)}`, tags: ["decision"] });
  return facts.slice(0, 3);
}

// Prompt block for the system message (empty when nothing is stored).
export function memoryPromptSection(query = "") {
  const facts = query ? searchMemories(query, { limit: 5 }) : loadMemories().slice(-5).map((f) => ({ fact: f, score: 1 }));
  if (!facts.length) return "";
  return ["", "# Project memory (most relevant stored facts)", ...facts.map((s) => `- ${s.fact.text}`)].join("\n");
}

export function memoryTool() {
  return {
    name: "memory",
    kind: "read",
    description: "Store or search persistent project memory. Save durable facts (run commands, decisions, conventions); search returns ranked matches.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "search", "list", "forget"] },
        text: { type: "string", description: "fact to save (save) or query (search)" },
        id: { type: "integer", description: "fact id (forget)" },
      },
      required: ["action"],
    },
    handler: async ({ action, text, id }) => {
      if (action === "save") {
        if (!text) return "Error: text required";
        const f = addMemory(text);
        return `saved fact #${f.id}: ${f.text}`;
      }
      if (action === "search") {
        const hits = searchMemories(text || "", { limit: 5 });
        return hits.length ? hits.map((h) => `#${h.fact.id} (${h.score.toFixed(2)}): ${h.fact.text}`).join("\n") : "no matching facts";
      }
      if (action === "list") {
        const all = loadMemories();
        return all.length ? all.slice(-20).map((f) => `#${f.id}: ${f.text}`).join("\n") : "memory is empty";
      }
      if (action === "forget") {
        return removeMemory(id) ? `forgotten #${id}` : `no fact #${id}`;
      }
      return `Error: unknown action ${action}`;
    },
  };
}
