// /worktree: run a task in an isolated git worktree. Enter creates (or
// reuses) .rtools-worktrees/<name>, switches the agent's working directory,
// exit returns to the original repo.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE = (repo) => path.join(repo, ".rtools-worktrees");

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function inWorktree(repo) {
  try {
    const dir = git(["rev-parse", "--git-common-dir"], repo);
    const gitDir = path.resolve(repo, dir);
    return gitDir !== path.join(path.resolve(repo), ".git") ? path.dirname(gitDir) : null;
  } catch {
    return null;
  }
}

export function listWorktrees(repo) {
  const out = git(["worktree", "list", "--porcelain"], repo);
  return out.split("\n\n").filter(Boolean).map((block) => {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    return line ? line.slice("worktree ".length) : "";
  }).filter(Boolean);
}

export function enterWorktree(repo, name, { base = null } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad worktree name: ${name}`);
  const dir = path.join(BASE(repo), name);
  if (existsSync(dir)) return { dir, created: false };
  const args = ["worktree", "add", dir];
  if (base) args.push(base);
  git(args, repo); // -b <name> would fight existing branch names; detached add is safe
  return { dir, created: true };
}

export function exitWorktree(repo, name, { force = false } = {}) {
  const dir = path.join(BASE(repo), name);
  if (!existsSync(dir)) return false;
  git(["worktree", "remove", dir, ...(force ? ["--force"] : [])], repo);
  return true;
}
