// /trace: JSONL step/tool log under ~/.rtools/logs for post-hoc debugging.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export function createTracer({ enabled = false, sessionId } = {}) {
  const logsDir = path.join(os.homedir(), ".rtools", "logs");
  const file = path.join(logsDir, `trace-${sessionId || "session"}.jsonl`);
  return {
    enabled,
    file,
    log(event) {
      if (!this.enabled) return;
      try {
        mkdirSync(logsDir, { recursive: true });
        appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      } catch {
        // tracing is best-effort
      }
    },
  };
}
