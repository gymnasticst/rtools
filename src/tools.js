import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { execWithSandbox } from "./sandbox.js";
import { monitorTool } from "./monitor.js";
import { lspTool } from "./lsp.js";
import { memoryTool } from "./memory-vector.js";
import { createTodoState } from "./todos.js";
import { goalTools } from "./goal.js";
import { remoteExec } from "./remote.js";

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

// headless fallback when no TUI hook is installed (e.g. non-interactive runs)
async function askUserFallback(questions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = [];
  for (const q of questions) {
    const a = await rl.question(`? ${q}\n> `);
    out.push(`${q}\n  answer: ${a.trim() || "(no answer)"}`);
  }
  rl.close();
  return out.join("\n");
}

export function builtinTools({ cwd, skills, sandboxMode = "danger", cfg = {} }) {
  const todoState = createTodoState();
  builtinTools._todos = todoState;
  builtinTools._remoteTarget = null;
  return [
    monitorTool({ cwd }),
    lspTool({ cwd }),
    memoryTool(),
    todoState.tool,
    ...goalTools(),
    {
      name: "ask_user",
      kind: "read",
      description:
        "Ask the user clarifying questions and wait for their real answers. MANDATORY before starting any task that changes files, runs commands or builds anything — keep asking until you are 100% sure what the user wants. Skip only for trivial read-only questions you can answer yourself.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { type: "string" },
            description: "1-5 concrete questions; each with 2-3 options if a choice is involved",
          },
        },
        required: ["questions"],
      },
      handler: async ({ questions }) => {
        const list = (Array.isArray(questions) ? questions : [String(questions)]).map(String).filter(Boolean).slice(0, 5);
        if (!list.length) return "Error: no questions given.";
        const ask = builtinTools._askUser;
        const text = ask ? await ask(list) : await askUserFallback(list);
        return `USER ANSWERS:\n${text}`;
      },
    },
    {
      name: "survey_project",
      kind: "read",
      description:
        "Collect real project facts for writing AGENTS.md: manifests, build/test scripts, languages by file count, git branch/remote, top-level layout, existing AGENTS.md.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const facts = [];
        const pkgPath = path.join(cwd, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
            facts.push(`package.json: name=${pkg.name || "?"} version=${pkg.version || "?"}`);
            if (pkg.scripts) facts.push("scripts:\n" + Object.entries(pkg.scripts).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            const names = Object.keys(deps);
            if (names.length) facts.push(`dependencies (${names.length}): ${names.slice(0, 20).join(", ")}${names.length > 20 ? " …" : ""}`);
          } catch {
            facts.push("package.json: present but not valid JSON");
          }
        } else {
          facts.push("package.json: not found");
        }
        for (const m of ["pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Gemfile", "composer.json", "pom.xml", "build.gradle"]) {
          if (existsSync(path.join(cwd, m))) facts.push(`manifest: ${m}`);
        }
        const counts = new Map();
        let scanned = 0;
        const skip = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", "coverage"]);
        const walk = (dir, depth) => {
          if (depth > 4 || scanned > 5000) return;
          let entries;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (skip.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else {
              scanned++;
              const ext = path.extname(e.name).slice(1).toLowerCase();
              if (ext) counts.set(ext, (counts.get(ext) || 0) + 1);
            }
          }
        };
        walk(cwd, 0);
        facts.push("files by extension (top 10): " + [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, n]) => `${e}=${n}`).join(", "));
        try {
          const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
          let remote = "";
          try {
            remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
          } catch {}
          facts.push(`git: branch=${branch}${remote ? ` origin=${remote}` : ""}`);
        } catch {
          facts.push("git: not a repository");
        }
        try {
          const top = readdirSync(cwd, { withFileTypes: true })
            .filter((e) => !e.name.startsWith("."))
            .slice(0, 25)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          facts.push(`top-level: ${top.join(", ")}`);
        } catch {}
        const agentsPath = path.join(cwd, "AGENTS.md");
        if (existsSync(agentsPath)) {
          const head = readFileSync(agentsPath, "utf8").split("\n").slice(0, 15).join("\n");
          facts.push(`AGENTS.md exists (first lines):\n${head}`);
        } else {
          facts.push("AGENTS.md: missing — after clarifying questions, survey the project and write one yourself");
        }
        return truncate(facts.join("\n\n"));
      },
    },
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
        // remote session (/remote use <target>): shell runs over ssh instead
        const remote = builtinTools._remoteTarget;
        if (remote) {
          const r = remoteExec(remote, command);
          return truncate(`exit code: ${r.code}\n${r.stdout ? `stdout:\n${r.stdout}` : ""}${r.stderr ? `stderr:\n${r.stderr}` : ""}`.trim());
        }
        const env = buildShellEnv(cfg?.shell_environment_policy);
        const { code, stdout, stderr, sandboxed, timedOut, spawnError, refused } = await execWithSandbox({ command, cwd, mode: __sandboxMode || sandboxMode, env });
        let out = `exit code: ${code}`;
        if (timedOut) out += " (timed out)";
        if (spawnError) out += " (spawn error)";
        if (refused) out += " (refused by sandbox)";
        if (sandboxed) out += " (sandboxed)";
        out += "\n";
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
        // same containment as apply_patch: writes must stay inside the workspace
        const rel = path.relative(path.resolve(cwd), abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return `Error: path escapes working directory: ${file}`;
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
        // same containment as apply_patch: edits must stay inside the workspace
        const rel = path.relative(path.resolve(cwd), abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return `Error: path escapes working directory: ${file}`;
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
      name: "git",
      kind: "read",
      description: "Read-only git inspection: status, diff, log, show, branch, blame, rev-parse. Returns the command output.",
      parameters: {
        type: "object",
        properties: {
          subcommand: { type: "string", description: "One of: status, diff, log, show, branch, blame, rev-parse" },
          args: { type: "array", items: { type: "string" }, description: "Extra arguments, e.g. [\"--stat\"] or [\"HEAD~1\"]" },
        },
        required: ["subcommand"],
      },
      handler: async ({ subcommand, args = [] }) => {
        const ALLOWED = ["status", "diff", "log", "show", "branch", "blame", "rev-parse"];
        if (!ALLOWED.includes(subcommand)) {
          return `Error: git "${subcommand}" not allowed (read-only subcommands: ${ALLOWED.join(", ")})`;
        }
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return "Error: args must be an array of strings";
        try {
          return truncate(execFileSync("git", [subcommand, ...args], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
        } catch (e) {
          return `Error: git ${subcommand} failed: ${String(e.stderr || e.message).slice(0, 300)}`;
        }
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
        // SSRF guard per hop: no loopback, private, link-local or cloud-metadata
        // hosts. Redirects are followed manually so every hop is re-checked —
        // a public URL that 302s to 169.254.169.254 used to slip through.
        const isPrivateHost = (host) => {
          const h = host.toLowerCase().replace(/^\[|\]$/g, "");
          if (h === "localhost" || h === "metadata.google.internal") return true;
          if (h.endsWith(".local") || h.endsWith(".internal")) return true;
          if (h.includes(":")) {
            // IPv6: loopback ::1, unspecified ::, unique-local fc00::/7, link-local fe80::/10
            return h === "::1" || h === "::" || /^f[cd][0-9a-f]{0,3}:/.test(h) || /^fe[89ab][0-9a-f]?(:|$)/.test(h);
          }
          return (
            /^127\./.test(h) ||
            /^10\./.test(h) ||
            /^192\.168\./.test(h) ||
            /^169\.254\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
            /^0\./.test(h) ||
            /^\d+$/.test(h) // integer host form (e.g. http://2130706433/ = 127.0.0.1)
          );
        };
        let current = target;
        let res;
        for (let hops = 0; ; hops++) {
          let u;
          try {
            u = new URL(current);
          } catch {
            return "Error: invalid url";
          }
          if (!/^https?:$/.test(u.protocol)) return "Error: only http(s) urls are fetched";
          if (isPrivateHost(u.hostname)) return `Error: fetching private/loopback addresses is blocked (${u.hostname})`;
          if (hops >= 6) return "Error: too many redirects";
          res = await fetch(current, { signal: AbortSignal.timeout(20000), redirect: "manual" });
          if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
            current = new URL(res.headers.get("location"), current).toString();
            continue;
          }
          break;
        }
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

// view_image: attach a local image (screenshot, mockup) as a user-visible
// message so vision models can look at it. The REPL wires the display side.
export function viewImageTool({ cwd }) {
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
  return {
    name: "view_image",
    kind: "read",
    description:
      "Load a local image file (png, jpg, gif, webp) so you can see it. " +
      "Returns a note; the image itself is attached to the conversation as a user message.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Image path (relative to the working directory or absolute)" } },
      required: ["path"],
    },
    handler: async ({ path: file }) => {
      if (!file || typeof file !== "string") return "Error: path is required";
      if (!IMAGE_EXT.test(file)) return `Error: not an image path: ${file}`;
      const abs = path.resolve(cwd, file);
      const rel = path.relative(cwd, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return `Error: path escapes working directory: ${file}`;
      if (!existsSync(abs)) return `Error: no such file: ${file}`;
      const { statSync } = await import("node:fs");
      const size = statSync(abs).size;
      if (size > 20 * 1024 * 1024) return `Error: image too large (${size} bytes, max 20 MiB)`;
      const b64 = readFileSync(abs).toString("base64");
      const mime = /\.png$/i.test(abs) ? "image/png" : /\.gif$/i.test(abs) ? "image/gif" : /\.webp$/i.test(abs) ? "image/webp" : "image/jpeg";
      viewImageTool._pending = { path: abs, base64: b64, mime };
      return `image loaded: ${file} (${size} bytes) — attached to the conversation`;
    },
  };
}

// The REPL/agent loop drains this after the tool call completes.
export function takePendingImage() {
  const p = viewImageTool._pending;
  viewImageTool._pending = null;
  return p;
}
