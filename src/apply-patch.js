// apply_patch: Codex-style V4A patch format.
// *** Begin Patch / *** Update File: <path> / @@ context / +/- lines / *** End Patch
// Also supports *** Add File and *** Delete File.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function parsePatch(patchText) {
  const lines = patchText.split("\n").map((l) => l.replace(/\r$/, ""));
  const start = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  if (start === -1) throw new Error("patch must start with `*** Begin Patch`");
  const end = lines.findIndex((l) => l.trim() === "*** End Patch");
  if (end === -1) throw new Error("patch must end with `*** End Patch`");
  const body = lines.slice(start + 1, end);

  const hunks = [];
  let cur = null;
  for (const line of body) {
    if (line.startsWith("*** Add File: ")) {
      cur = { type: "add", path: line.slice(13).trim(), lines: [] };
      hunks.push(cur);
    } else if (line.startsWith("*** Delete File: ")) {
      hunks.push({ type: "delete", path: line.slice(17).trim() });
      cur = null;
    } else if (line.startsWith("*** Update File: ")) {
      cur = { type: "update", path: line.slice(16).trim(), chunks: [], chunk: null };
      hunks.push(cur);
    } else if (line.startsWith("@@")) {
      if (!cur || cur.type !== "update") throw new Error("@@ outside Update File");
      cur.chunk = { context: line.replace(/^@@\s*/, "").trim(), lines: [] };
      cur.chunks.push(cur.chunk);
    } else if (line.startsWith("***")) {
      throw new Error(`unsupported patch directive: ${line}`);
    } else if (line.trim() === "") {
      // Blank lines are data inside an Add File body (a blank line of the new
      // file) and inside an update chunk (a blank context line); skip them
      // only between directives.
      if (cur?.type === "add") cur.lines.push("");
      else if (cur?.chunk) cur.chunk.lines.push(" ");
      continue;
    } else if (cur) {
      if (cur.type === "add") cur.lines.push(line);
      else if (cur.chunk) cur.chunk.lines.push(line);
      else throw new Error("patch lines before @@ in Update File");
    }
  }
  return hunks;
}

function matchLine(content, index, text) {
  // match a context/del line, allowing a leading space (context) or "-" (remove)
  const stripped = text.slice(1);
  return content[index] === stripped;
}

function applyUpdate(content, chunks) {
  const contentLines = content.split("\n");
  // Prefer matches at/after the previous chunk so identical context blocks
  // (repeated case arms, duplicated stubs) edit the occurrence the patch
  // reached, not always the first one in the file.
  let searchFrom = 0;
  for (const chunk of chunks) {
    const ctxLines = chunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("-"));
    const find = ctxLines.length
      ? ctxLines.map((l) => l.slice(1))
      : [];
    if (!find.length) {
      // no removal context: append at end
      contentLines.push(...chunk.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)));
      continue;
    }
    let at = -1;
    for (const from of [searchFrom, 0]) {
      outer: for (let i = from; i <= contentLines.length - find.length; i++) {
        for (let j = 0; j < find.length; j++) {
          if (contentLines[i + j] !== find[j]) continue outer;
        }
        at = i;
        break;
      }
      if (at !== -1) break;
    }
    if (at === -1) throw new Error(`context not found: ${find[0].slice(0, 60)}`);
    const replacements = [];
    for (const l of chunk.lines) {
      if (l.startsWith("-")) continue;
      if (l.startsWith("+")) replacements.push(l.slice(1));
      else replacements.push(l.slice(1));
    }
    contentLines.splice(at, find.length, ...replacements);
    searchFrom = at + replacements.length;
  }
  return contentLines.join("\n");
}

// Target paths of a patch, in order, so the caller can checkpoint the files
// before the patch mutates them (including files it will delete).
export function patchTargets(patchText) {
  return parsePatch(patchText).map((h) => h.path);
}

export function applyPatchTool({ cwd }) {
  return {
    name: "apply_patch",
    kind: "write",
    description:
      "Apply a Codex-style V4A patch to create, update or delete files. Format: '*** Begin Patch', " +
      "'*** Add File: <path>' with '+' lines, '*** Update File: <path>' with '@@' context and +/- lines, " +
      "'*** Delete File: <path>', '*** End Patch'.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", description: "The full patch text" } },
      required: ["patch"],
    },
    handler: async ({ patch }) => {
      const hunks = parsePatch(patch);
      // Two-phase apply: containment-check and compute every hunk against the
      // current files first, then write. A failure in hunk 3 no longer leaves
      // hunks 1-2 already on disk (a model retry would patch a half-applied tree).
      const plan = [];
      for (const hunk of hunks) {
        const abs = path.resolve(cwd, hunk.path);
        // containment: relative path must stay inside cwd (catches ../ and
        // sibling dirs that share a prefix, e.g. cwd=/repo vs /repo-evil)
        const rel = path.relative(path.resolve(cwd), abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes working directory: ${hunk.path}`);
        if (hunk.type === "add") {
          plan.push({ abs, write: hunk.lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n"), label: `A ${hunk.path}` });
        } else if (hunk.type === "delete") {
          plan.push({ rm: abs, label: `D ${hunk.path}` });
        } else {
          const before = await readFile(abs, "utf8");
          const after = applyUpdate(before, hunk.chunks);
          if (after === before) plan.push({ label: `(no change) ${hunk.path}` });
          else plan.push({ abs, write: after, label: `M ${hunk.path}` });
        }
      }
      const results = [];
      for (const op of plan) {
        if (op.rm !== undefined) {
          await rm(op.rm);
        } else if (op.write !== undefined) {
          await mkdir(path.dirname(op.abs), { recursive: true });
          await writeFile(op.abs, op.write, "utf8");
        }
        results.push(op.label);
      }
      return `success. Updated files:\n${results.join("\n")}`;
    },
  };
}

// Used for sandbox checks and /diff
export async function changedFilesSince({ cwd, git = true }) {
  if (!git) return [];
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(exec);
  try {
    const { stdout } = await run("git status --porcelain", { cwd });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
