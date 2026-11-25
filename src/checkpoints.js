// File checkpoints: before a write/edit/apply_patch touches a file, a copy is
// kept in ~/.rtools/checkpoints so /undo can restore it. Pure node, no deps.
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const dir = () => path.join(os.homedir(), ".rtools", "checkpoints");

// Back up absPath before it is modified. Returns the checkpoint id or null
// when the file does not exist yet (a new file has nothing to restore).
export function snapshotFile(absPath, cwd) {
  if (!existsSync(absPath)) return null;
  try {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const id = `${Date.now().toString(36)}-${createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 8)}`;
    copyFileSync(absPath, path.join(d, `${id}.bak`));
    writeFileSync(
      path.join(d, `${id}.json`),
      JSON.stringify({ id, abs: path.resolve(absPath), cwd: path.resolve(cwd), at: new Date().toISOString() })
    );
    return id;
  } catch {
    return null; // checkpoints are best-effort, never block a tool call
  }
}

export function listCheckpoints() {
  try {
    const d = dir();
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(d, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  } catch {
    return [];
  }
}

// Restore the newest checkpoint (preferring ones taken in this cwd) and
// consume it. Returns { file, id } or null when there is nothing to undo.
export function undoLast({ cwd } = {}) {
  const list = listCheckpoints();
  if (!list.length) return null;
  const here = cwd ? list.filter((c) => c.cwd === path.resolve(cwd)) : list;
  const pool = here.length ? here : list;
  const c = pool[pool.length - 1];
  const bak = path.join(dir(), `${c.id}.bak`);
  if (!existsSync(bak)) {
    try {
      unlinkSync(path.join(dir(), `${c.id}.json`));
    } catch {}
    return null;
  }
  mkdirSync(path.dirname(c.abs), { recursive: true });
  copyFileSync(bak, c.abs);
  try {
    unlinkSync(bak);
    unlinkSync(path.join(dir(), `${c.id}.json`));
  } catch {}
  return { file: c.abs, id: c.id };
}

export function clearCheckpoints() {
  try {
    rmSync(dir(), { recursive: true, force: true });
  } catch {}
}
