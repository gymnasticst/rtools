// Auto-compaction: when the token estimate of the conversation crosses a
// share of the model's context window, compact automatically before the next
// turn instead of failing with a provider overflow error.
import { compactMessages } from "./session.js";

// Rough public context windows; unknown models fall back to 128k.
const CONTEXT_WINDOWS = [
  [/gpt-5/i, 400000],
  [/o[34]/i, 200000],
  [/gpt-4o/i, 128000],
  [/claude-(sonnet|haiku|opus)/i, 200000],
  [/glm/i, 128000],
  [/deepseek/i, 128000],
];

export function contextWindowFor(model) {
  for (const [re, win] of CONTEXT_WINDOWS) if (re.test(String(model))) return win;
  return 128000;
}

// ~4 chars per token is close enough for a warning threshold; exact counts
// come from the provider and are tracked in usage.
export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return Math.ceil(messages.reduce((n, m) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return n + (c?.length || 0) + 8;
  }, 0) / 4);
}

// Returns { messages, compacted } — messages possibly replaced by a compacted
// version. warnAt (0..1) triggers a "context is filling up" notice,
// compactAt triggers the automatic compaction.
export function autoCompact({ messages, model, warnAt = 0.8, compactAt = 0.92, minKeep = 4 }) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, compacted: false, warn: false };
  const ratio = estimateTokens(messages) / contextWindowFor(model);
  if (ratio < warnAt) return { messages, compacted: false, warn: false };
  if (ratio < compactAt) return { messages, compacted: false, warn: true };
  const next = compactMessages(messages);
  if (!next || next.length >= messages.length) return { messages, compacted: false, warn: true };
  return { messages: next, compacted: true, warn: true };
}
