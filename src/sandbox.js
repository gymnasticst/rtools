// Sandbox modes for shell, Codex-style:
//   read-only  — command runs with no write access anywhere (network cut)
//   workspace  — writes allowed in the working directory tree and tmp
//   danger     — full access, no isolation
// Enforcement via Bubblewrap (bwrap). If bwrap is missing, read-only and
// workspace modes FAIL CLOSED: the command is refused rather than run outside
// the sandbox.
import { spawn } from "node:child_process";
import os from "node:os";
import { accessSync, constants } from "node:fs";

export const SANDBOX_MODES = ["read-only", "workspace", "danger"];

export function bwrapAvailable() {
  try {
    accessSync("/usr/bin/bwrap", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bwrapArgs({ mode, cwd }) {
  const args = [
    "--die-with-parent",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
  ];
  if (mode === "read-only") {
    args.push("--unshare-net", "--tmpfs", cwd, "--tmpfs", "/tmp");
  } else {
    // workspace: writes allowed in cwd and /tmp only; /tmp itself writable so
    // toolchains that need temp files work, but the root stays read-only
    args.push("--bind", cwd, cwd, "--bind", "/tmp", "/tmp", "--tmpfs", "/dev/shm");
  }
  return args;
}

export async function execWithSandbox({ command, cwd, mode, env = process.env, timeout = 120000 }) {
  if (mode === "danger") {
    const r = await runRaw(["bash", "-lc", command], { cwd, env, timeout });
    return { ...r, sandboxed: false };
  }
  if (!bwrapAvailable()) {
    return {
      code: 127,
      stdout: "",
      stderr: `sandbox mode "${mode}" requires bubblewrap (/usr/bin/bwrap). Install it: sudo apt-get install bubblewrap, or set sandbox_mode = "danger" in config.toml.`,
      sandboxed: false,
      refused: true,
    };
  }
  const argv = ["bwrap", ...bwrapArgs({ mode, cwd }), "--", "bash", "-lc", command];
  const r = await runRaw(argv, { cwd, env, timeout });
  return { ...r, sandboxed: true };
}

function runRaw(argv, { cwd, env, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: e.message, spawnError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          code: 124,
          stdout,
          stderr: stderr + (stderr ? "\n" : "") + `command timed out after ${timeout}ms and was killed`,
          timedOut: true,
        });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
