// Monitor tool: run a command in the background and wake the agent when its
// output matches a pattern or the process exits — openclaude MonitorTool-style.
// Unlike a plain job, the tool call *blocks* until the trigger fires, so the
// agent continues in the same turn with the matching line as its result.
import { spawn } from "node:child_process";

const MAX_WAIT_MS = 30 * 60 * 1000;

export function monitorTool({ cwd }) {
  return {
    name: "monitor",
    kind: "shell",
    description:
      "Run a shell command and watch its output. Returns as soon as a line matches `pattern` " +
      "(regular expression) or the command exits. Use for builds, tests, dev servers, log tails. " +
      "Waits up to 30 minutes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        pattern: { type: "string", description: "Regular expression; return the first matching line" },
        timeout_seconds: { type: "integer", description: "Give up after this many seconds (default 300)" },
      },
      required: ["command"],
    },
    handler: async ({ command, pattern, timeout_seconds }) => {
      const timeoutMs = Math.min(Math.max(Number(timeout_seconds) || 300, 1) * 1000, MAX_WAIT_MS);
      let regex = null;
      if (pattern) {
        try {
          regex = new RegExp(pattern);
        } catch (e) {
          return `Error: invalid pattern: ${e.message}`;
        }
      }
      return await new Promise((resolve) => {
        const env = { ...process.env };
        const child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill("SIGKILL"); } catch {}
          resolve(result);
        };
        const onData = (d) => {
          out += d;
          if (!regex) return;
          const line = out.split("\n").find((l) => regex.test(l));
          if (line) finish(`matched: ${line.trim()}\n\noutput so far:\n${out.slice(-4000)}`);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (e) => finish(`Error: spawn failed: ${e.message}`));
        child.on("close", (code) => {
          if (regex) {
            const line = out.split("\n").find((l) => regex.test(l));
            if (line) return finish(`matched: ${line.trim()}\n\noutput:\n${out.slice(-4000)}`);
          }
          finish(
            `command exited with code ${code}\n\noutput:\n${out.slice(-4000) || "(no output)"}`
          );
        });
        const timer = setTimeout(() => finish(`timeout after ${timeoutMs / 1000}s without a match\n\noutput so far:\n${out.slice(-2000) || "(none)"}`), timeoutMs);
      });
    },
  };
}
