// Persistent usage history for /stats: one line per turn appended to
// ~/.rtools/usage.jsonl (model, tokens, cost, turn duration).
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = () => path.join(os.homedir(), ".rtools", "usage.jsonl");

export function recordTurn({ model, input, output, seconds, pricing }) {
  try {
    mkdirSync(path.dirname(FILE()), { recursive: true });
    const cost = pricing?.input != null && pricing?.output != null
      ? (input * pricing.input + output * pricing.output) / 1e6
      : null;
    appendFileSync(FILE(), JSON.stringify({ at: new Date().toISOString(), model, input, output, seconds, cost }) + "\n");
  } catch {
    // history is best-effort; live /usage keeps working without it
  }
}

// Aggregates over the stored history. days=0 means "all time".
export function usageStats({ days = 7 } = {}) {
  let rows = [];
  try {
    if (existsSync(FILE())) {
      rows = readFileSync(FILE(), "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    }
  } catch {
    rows = [];
  }
  if (days > 0) {
    const since = Date.now() - days * 86400000;
    rows = rows.filter((r) => new Date(r.at).getTime() >= since);
  }
  const byModel = new Map();
  for (const r of rows) {
    const m = byModel.get(r.model) || { turns: 0, input: 0, output: 0, cost: 0, seconds: 0 };
    m.turns++; m.input += r.input || 0; m.output += r.output || 0;
    m.cost += r.cost || 0; m.seconds += r.seconds || 0;
    byModel.set(r.model, m);
  }
  const total = { turns: rows.length, input: 0, output: 0, cost: 0 };
  for (const m of byModel.values()) { total.input += m.input; total.output += m.output; total.cost += m.cost; }
  return { byModel: [...byModel.entries()], total };
}

export function formatStats({ days = 7 } = {}) {
  const { byModel, total } = usageStats({ days });
  const lines = [`period: ${days > 0 ? `last ${days} day(s)` : "all time"}`, ""];
  if (!byModel.length) return "no usage recorded yet (turns are logged as you work)";
  lines.push("model                turns     tokens in   tokens out   est. cost   time");
  for (const [model, m] of byModel) {
    lines.push(
      model.slice(0, 20).padEnd(21) +
      String(m.turns).padStart(5) + String(m.input).padStart(13) + String(m.output).padStart(13) +
      ("$" + m.cost.toFixed(4)).padStart(12) + (Math.round(m.seconds) + "s").padStart(8)
    );
  }
  lines.push(
    "",
    "TOTAL".padEnd(21) +
    String(total.turns).padStart(5) + String(total.input).padStart(13) + String(total.output).padStart(13) +
    ("$" + total.cost.toFixed(4)).padStart(12)
  );
  return lines.join("\n");
}
