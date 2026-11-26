// Remote sessions: run the agent's shell tools on a host reached over SSH.
// Connection: an ssh config entry name or user@host. Every command runs as
// `ssh <target> -- <command>`; file tools stay local unless the session is
// entered with /remote use, which re-points the sandbox cwd at the remote.
import { spawnSync } from "node:child_process";

// Runs a single command on the remote host. Returns { code, stdout, stderr }.
export function remoteExec(target, command, { timeoutMs = 60000 } = {}) {
  // The first char must not be '-': a leading-dash target (e.g. -oProxyCommand=…)
  // is parsed by ssh as an option before the '--' separator, which would run
  // arbitrary local commands via ProxyCommand/LocalCommand.
  if (!target || !/^[\w.@][\w.@-]*$/.test(target)) throw new Error(`bad ssh target: ${target}`);
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "--", command], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Sanity check used by /remote use <target>.
export function remoteAlive(target) {
  try {
    const r = remoteExec(target, "echo ok", { timeoutMs: 15000 });
    return r.code === 0 && r.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

// Wraps a shell-command handler so it executes remotely instead of locally.
export function remoteShellHandler(target, originalHandler) {
  return async (args) => {
    if (args?.command) {
      const r = remoteExec(target, args.command);
      return `$ ${args.command}\n${r.stdout}${r.stderr}\n(exit code ${r.code})`.trim();
    }
    return originalHandler ? originalHandler(args) : "Error: command required";
  };
}
