// Smart auto-routing: pick a cheap "simple" model for easy turns and the
// strong model for hard ones. Off by default; configured via [smart_routing]:
//   enabled = true
//   simple = "gpt-5-mini"     # model id or saved /model alias
//   strong = "gpt-5.1"
// Heuristic only (mirrors openclaude's experimental classifier): prompt length,
// code blocks, reasoning/planning keywords, first turn of the session.
import { resolveAlias } from "./alias.js";

const HARD_WORDS = [
  "refactor", "архитектур", "optimize", "оптимиз", "why", "почему", "debug",
  "отлад", "design", "спроектир", "migrate", "миграц", "security", "безопасн",
  "race condition", "memory leak", "утечк", "concurrency", "многопот", "plan ",
  "план ", "algorithm", "алгоритм", "root cause", "perf", "производительн",
];

const EASY_WORDS = [
  "rename", "переимен", "typo", "опечатк", "comment", "комментари", "log",
  "print", "format", "ls", "list files", "покажи файл", "what is",
  "что такое", "where is", "где находится", "read", "прочитай",
];

export function classifyTurn(text, { firstTurn = false } = {}) {
  const t = String(text || "");
  const trimmed = t.trim();
  if (!trimmed) return "simple";
  if (firstTurn) return "strong"; // opening turn sets direction; keep quality
  const lower = trimmed.toLowerCase();
  if (/```/.test(trimmed) || trimmed.length > 2000) return "strong";
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words > 120) return "strong";
  if (HARD_WORDS.some((w) => lower.includes(w))) return "strong";
  if (words <= 6 && !/\?$/.test(trimmed)) return "simple";
  if (EASY_WORDS.some((w) => lower.includes(w)) && words <= 30) return "simple";
  return "strong";
}

// Returns the model id to use for this turn, or null when routing is off /
// the turn is not "simple" (null = keep the currently selected model).
export function routeModel(cfg, text, { firstTurn = false } = {}) {
  const r = cfg?.smart_routing;
  if (!r?.enabled || !r.simple) return null;
  const tier = classifyTurn(text, { firstTurn });
  if (tier !== "simple") return null;
  return resolveAlias(cfg, r.simple);
}
