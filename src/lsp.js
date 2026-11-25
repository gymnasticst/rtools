// LSP tool: hover, definitions, references and document symbols through a
// real language server (typescript-language-server, gopls, rust-analyzer,
// pyright...). The server is started lazily per workspace on first use and
// reused; if none is configured/available the tool reports that honestly.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SERVERS = {
  ts: { cmd: ["typescript-language-server", "--stdio"], exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
  py: { cmd: ["pyright-langserver", "--stdio"], exts: [".py"] },
  go: { cmd: ["gopls"], exts: [".go"] },
  rs: { cmd: ["rust-analyzer"], exts: [".rs"] },
};

const servers = new Map(); // lang -> child process

function langFor(file) {
  const ext = path.extname(file);
  for (const [lang, s] of Object.entries(SERVERS)) if (s.exts.includes(ext)) return lang;
  return null;
}

function nextId() { return servers.get("__id") || 1 && 1; }
let idSeq = 1;

function rpc(lang, cwd, method, params, { notification = false } = {}) {
  return new Promise((resolve, reject) => {
    let s = servers.get(lang);
    if (!s) {
      const conf = SERVERS[lang];
      try {
        const child = spawn(conf.cmd[0], conf.cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
        s = { child, buf: "", pending: new Map() };
        child.stdout.on("data", (d) => {
          s.buf += d;
          let idx;
          while ((idx = s.buf.indexOf("\r\n\r\n")) !== -1) {
            const head = s.buf.slice(0, idx);
            const len = Number((head.match(/Content-Length: (\d+)/) || [])[1]);
            if (!len) { s.buf = s.buf.slice(idx + 4); continue; }
            const body = s.buf.slice(idx + 4, idx + 4 + len);
            s.buf = s.buf.slice(idx + 4 + len);
            try {
              const msg = JSON.parse(body);
              if (msg.id && s.pending.has(msg.id)) {
                const { resolve: res, reject: rej } = s.pending.get(msg.id);
                s.pending.delete(msg.id);
                msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
              }
            } catch {}
          }
        });
        child.on("error", (e) => { servers.delete(lang); for (const p of s.pending.values()) p.reject(e); });
        servers.set(lang, s);
      } catch (e) {
        return reject(new Error(`LSP server for ${lang} is not available (${e.message}). Install it, e.g. npm i -g typescript-language-server typescript`));
      }
    }
    const id = idSeq++;
    const msg = { jsonrpc: "2.0", id, method, params };
    s.pending.set(id, { resolve, reject });
    s.child.stdin.write(`Content-Length: ${Buffer.byteLength(JSON.stringify(msg))}\r\n\r\n${JSON.stringify(msg)}`);
    if (notification) {
      // notifications get no response; resolve immediately after write
      s.pending.delete(id);
      resolve(null);
    }
    setTimeout(() => {
      if (s.pending.has(id)) { s.pending.delete(id); reject(new Error(`LSP ${method} timed out`)); }
    }, 15000);
  });
}

async function ensureInitialized(lang, cwd) {
  const root = process.cwd();
  if (!servers.get(lang)?.initialized) {
    await rpc(lang, cwd, "initialize", {
      processId: process.pid,
      rootUri: "file://" + root,
      capabilities: {},
    });
    servers.get(lang).initialized = true;
    rpc(lang, cwd, "initialized", {}, { notification: true });
  }
}

export function lspTool({ cwd }) {
  return {
    name: "lsp",
    kind: "read",
    description:
      "Query the language server for the current project: hover documentation, go to definition, " +
      "find references, or list document symbols. Needs the matching LSP server installed " +
      "(typescript-language-server, pyright-langserver, gopls, rust-analyzer).",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["hover", "definition", "references", "symbols"] },
        file: { type: "string", description: "File path (absolute or relative to the project)" },
        line: { type: "integer", description: "0-based line (hover/definition/references)" },
        character: { type: "integer", description: "0-based character (hover/definition/references)" },
      },
      required: ["operation", "file"],
    },
    handler: async ({ operation, file, line, character }) => {
      const abs = file.startsWith("/") ? file : path.join(cwd, file);
      if (!existsSync(abs)) return `Error: no such file: ${file}`;
      const lang = langFor(abs);
      if (!lang) return `Error: no LSP support for ${path.extname(file) || file}`;
      const textPosition = operation !== "symbols";
      if (textPosition && (!Number.isInteger(line) || !Number.isInteger(character)))
        return "Error: line and character (0-based) are required for hover/definition/references";
      try {
        await ensureInitialized(lang, cwd);
        const uri = "file://" + abs;
        const pos = { line, character };
        if (operation === "hover") {
          const r = await rpc(lang, cwd, "textDocument/hover", { textDocument: { uri }, position: pos });
          if (!r?.contents) return "(no hover information)";
          const c = typeof r.contents === "string" ? r.contents : r.contents.value ?? JSON.stringify(r.contents);
          return c.slice(0, 4000);
        }
        if (operation === "definition" || operation === "references") {
          const method = operation === "definition" ? "textDocument/definition" : "textDocument/references";
          const params = { textDocument: { uri }, position: pos };
          if (operation === "references") params.context = { includeDeclaration: true };
          const r = await rpc(lang, cwd, method, params);
          const locs = Array.isArray(r) ? r : r ? [r] : [];
          if (!locs.length) return `(no ${operation})`;
          return locs.map((l) => `${l.uri.replace("file://", "")}:${l.range.start.line + 1}`).join("\n");
        }
        const r = await rpc(lang, cwd, "textDocument/documentSymbol", { textDocument: { uri } });
        const syms = Array.isArray(r) ? r : r?.symbols || [];
        if (!syms.length) return "(no symbols)";
        return syms.map((s) => `${s.kind ?? "?"} ${s.name} @ line ${(s.location?.range?.start?.line ?? s.range?.start?.line ?? 0) + 1}`).join("\n");
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  };
}

export function shutdownLspServers() {
  for (const [lang, s] of servers) {
    try { s.child.kill("SIGKILL"); } catch {}
  }
  servers.clear();
}
