import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execWithSandbox } from "./sandbox.js";

// Codex-style [shell_environment_policy]: inherit all|core|none, ignore list, set map
export function buildShellEnv(policy) {
  if (!policy) return process.env;
  const core = ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PWD"];
  let env;
  if (policy.inherit === "none") env = {};
  else if (policy.inherit === "core") env = Object.fromEntries(core.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  else env = { ...process.env };
  for (const key of policy.ignore || []) delete env[key];
  return { ...env, ...(policy.set || {}) };
}

export const TOOL_OUTPUT_LIMIT = 20000;

function truncate(s) {
  return s.length > TOOL_OUTPUT_LIMIT ? s.slice(0, TOOL_OUTPUT_LIMIT) + "\n…(truncated)" : s;
}

// read a response body up to limit bytes, then stop (avoids unbounded memory)
async function capBody(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

export function builtinTools({ cwd, skills, sandboxMode = "danger", cfg = {} }) {
  return [
    {
      name: "shell",
      kind: "shell",
      description: "Run a shell command in the working directory and return stdout/stderr and the exit code.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run" } },
        required: ["command"],
      },
      handler: async ({ command, __sandboxMode }) => {
        const env = buildShellEnv(cfg?.shell_environment_policy);
        const { code, stdout, stderr, sandboxed } = await execWithSandbox({ command, cwd, mode: __sandboxMode || sandboxMode, env });
        let out = `exit code: ${code}${sandboxed ? " (sandboxed)" : ""}\n`;
        if (stdout) out += `stdout:\n${stdout}`;
        if (stderr) out += `stderr:\n${stderr}`;
        return truncate(out.trim());
      },
    },
    {
      name: "read_file",
      kind: "read",
      description: "Read a text file. Optionally read only a range of lines (1-based, inclusive).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative or absolute" },
          start_line: { type: "integer", description: "First line to read (optional)" },
          end_line: { type: "integer", description: "Last line to read (optional)" },
        },
        required: ["path"],
      },
      handler: async ({ path: file, start_line: start = 1, end_line: end }) => {
        const abs = path.resolve(cwd, file);
        const lines = (await readFile(abs, "utf8")).split("\n");
        const from = Math.max(1, start) - 1;
        const to = end ? Math.min(lines.length, end) : lines.length;
        return truncate(lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join("\n") || "(empty)");
      },
    },
    {
      name: "write_file",
      kind: "write",
      description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative or absolute" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
      handler: async ({ path: file, content }) => {
        const abs = path.resolve(cwd, file);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return `Wrote ${content.length} bytes to ${file}`;
      },
    },
    {
      name: "skill",
      kind: "read",
      description: "Load the full instructions of a skill by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name" } },
        required: ["name"],
      },
      handler: async ({ name }) => {
        const skill = skills.find((s) => s.name === name);
        if (!skill) return `Unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ") || "none"}`;
        return skill.body;
      },
    },
    {
      name: "grep",
      kind: "read",
      description: "Search file contents with a regular expression under a directory (skips binary files, .git, node_modules). Returns file:line:match.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression (Rust/JS syntax)" },
          path: { type: "string", description: "Directory or file to search (default: working directory)" },
          max_results: { type: "integer", description: "Maximum matches to return (default 50)" },
        },
        required: ["pattern"],
      },
      handler: async ({ pattern, path: dir = ".", max_results: max = 50 }) => {
        let regex;
        try {
          regex = new RegExp(pattern);
        } catch (e) {
          return `Error: invalid regex: ${e.message}`;
        }
        const base = path.resolve(cwd, dir);
        const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "target"]);
        const results = [];
        async function walk(d) {
          if (results.length >= max) return;
          let entries;
          try {
            entries = await import("node:fs/promises").then((fs) => fs.readdir(d, { withFileTypes: true }));
          } catch {
            return;
          }
          for (const entry of entries) {
            if (results.length >= max) return;
            if (SKIP.has(entry.name)) continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
              await walk(full);
            } else if (entry.isFile()) {
              let content;
              try {
                content = await import("node:fs/promises").then((fs) => fs.readFile(full, "utf8"));
              } catch {
                continue; // unreadable or binary
              }
              if (content.includes("\u0000")) continue; // binary
              const lines = content.split("\n");
              for (let i = 0; i < lines.length && results.length < max; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${path.relative(cwd, full)}:${i + 1}:${lines[i].slice(0, 300)}`);
                }
              }
            }
          }
        }
        const stat = await import("node:fs/promises").then((fs) => fs.stat(base)).catch(() => null);
        if (!stat) return `Error: no such path: ${dir}`;
        if (stat.isFile()) {
          const content = (await readFile(base, "utf8")).split("\n");
          content.forEach((l, i) => {
            if (regex.test(l) && results.length < max) results.push(`${path.relative(cwd, base)}:${i + 1}:${l.slice(0, 300)}`);
          });
        } else {
          await walk(base);
        }
        return results.length ? truncate(results.join("\n")) : `No matches for /${pattern}/`;
      },
    },
    {
      name: "glob",
      kind: "read",
      description: "Find files by glob pattern (e.g. \"src/**/*.ts\", \"*.json\"). Returns relative paths sorted by modification time, newest first.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Base directory (default: working directory)" },
        },
        required: ["pattern"],
      },
      handler: async ({ pattern, path: dir = "." }) => {
        const base = path.resolve(cwd, dir);
        const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "target"]);
        const found = [];
        // regex from glob: ** → any depth, * → within segment, ? → one char
        const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        const regexSrc = esc(pattern)
          .replace(/\*\*\//g, "\u0000")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, "(?:.*/)?")
          .replace(/\u0001/g, ".*");
        const regex = new RegExp(`^${pattern.startsWith("/") ? "" : "(?:.*/)?"}${regexSrc}$`);
        async function walk(d) {
          let entries;
          try {
            entries = await import("node:fs/promises").then((fs) => fs.readdir(d, { withFileTypes: true }));
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(d, entry.name);
            const rel = path.relative(base, full);
            if (entry.isDirectory()) {
              if (SKIP.has(entry.name)) continue;
              await walk(full);
            } else if (regex.test(rel)) {
              try {
                const st = await import("node:fs/promises").then((fs) => fs.stat(full));
                found.push({ rel, mtime: st.mtimeMs });
              } catch {
                found.push({ rel, mtime: 0 });
              }
            }
          }
        }
        await walk(base);
        found.sort((a, b) => b.mtime - a.mtime);
        return found.length ? found.map((f) => f.rel).slice(0, 500).join("\n") : `No files match ${pattern}`;
      },
    },
    {
      name: "edit",
      kind: "write",
      description: "Replace an exact substring in a file. old_string must appear exactly once unless replace_all is true. Use read_file first to copy the exact text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      handler: async ({ path: file, old_string: oldStr, new_string: newStr, replace_all: all = false }) => {
        const abs = path.resolve(cwd, file);
        const content = await readFile(abs, "utf8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${file}`;
        if (occurrences > 1 && !all) {
          return `Error: old_string appears ${occurrences} times in ${file}. Provide more surrounding context or set replace_all=true.`;
        }
        const next = all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
        await writeFile(abs, next, "utf8");
        return `Edited ${file}: replaced ${all ? occurrences : 1} occurrence(s).`;
      },
    },
    {
      name: "ls",
      kind: "read",
      description: "List a directory: names with type and size, one entry per line.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory (default: working directory)" } },
      },
      handler: async ({ path: dir = "." }) => {
        const base = path.resolve(cwd, dir);
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(base, { withFileTypes: true });
        if (!entries.length) return "(empty directory)";
        const lines = await Promise.all(
          entries.map(async (e) => {
            if (e.isDirectory()) return `${e.name}/`;
            let size = "";
            try {
              size = ` ${String((await fs.stat(path.join(base, e.name))).size)}B`;
            } catch {
              // size unavailable
            }
            return e.name + size;
          })
        );
        return truncate(lines.sort().join("\n"));
      },
    },
    {
      name: "fetch",
      kind: "read",
      description: "Fetch a URL (http/https) and return the body as text (HTML stripped to text if applicable, JSON as-is).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https:// URL" },
          max_chars: { type: "integer", description: "Max characters to return (default 8000)" },
        },
        required: ["url"],
      },
      handler: async ({ url: target, max_chars: max = 8000 }) => {
        if (!/^https?:\/\//.test(target)) return "Error: url must start with http:// or https://";
        let host;
        try {
          host = new URL(target).hostname;
        } catch {
          return "Error: invalid url";
        }
        // SSRF guard: no loopback, private, link-local or cloud-metadata hosts
        const hostLc = host.toLowerCase();
        const isPrivate =
          hostLc === "localhost" ||
          hostLc === "metadata.google.internal" ||
          hostLc.endsWith(".local") ||
          hostLc.endsWith(".internal") ||
          /^\[?\]?::1$/.test(hostLc) ||
          /^127\./.test(hostLc) ||
          /^10\./.test(hostLc) ||
          /^192\.168\./.test(hostLc) ||
          /^169\.254\./.test(hostLc) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(hostLc) ||
          /^0\./.test(hostLc);
        if (isPrivate) return "Error: fetching private/loopback addresses is blocked";
        const res = await fetch(target, { signal: AbortSignal.timeout(20000), redirect: "follow" });
        // cap the download: read at most a few MB so a huge body can't blow memory
        const capped = await capBody(res, 4 * 1024 * 1024);
        const raw = capped;
        const type = res.headers.get("content-type") || "";
        let body = raw;
        if (type.includes("text/html")) {
          body = raw
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim();
        }
        return `HTTP ${res.status} ${type.split(";")[0]}\n\n${truncate(body.slice(0, max))}`;
      },
    },
  ];
}
