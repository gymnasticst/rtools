// Minimal MCP (Model Context Protocol) stdio client: newline-delimited JSON-RPC.
import { spawn } from "node:child_process";

export class McpConnection {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    this.child.stderr.on("data", (d) => {
      stderr += d;
    });
    // a server that just died makes stdin emit EPIPE; swallow it once — the
    // exit listener already rejects every pending request with a clear error
    this.child.stdin.on("error", () => {});
    // Exit listener stays alive for the whole connection lifetime: it records
    // the exit and fails every pending request instead of leaving it to hang
    // until the request timeout.
    this.exitedCode = undefined;
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exitedCode = code === null ? signal : code;
        this.exitError = stderr;
        resolve(code);
        const err = new Error(`MCP server "${this.name}" exited (code ${this.exitedCode}): ${stderr.slice(0, 300)}`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      });
    });
    this.child.stdout.setEncoding("utf8");
    let buf = "";
    this.child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          // ignore malformed lines from the server
        }
      }
    });
    // Fire-and-forget: the handshake result is not used, and a rejection (e.g.
    // the server dying) is handled by the exit listener / tools/list below.
    this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rtools", version: "0.1.0" },
    }).catch(() => {});
    this.notify("notifications/initialized", {});
    this.tools = (await this.request("tools/list", {})).tools || [];
    // If the server died immediately, surface it.
    const code = await Promise.race([this.exited.then((c) => (c === null ? undefined : c)), new Promise((r) => setTimeout(() => r(undefined), 50))]);
    if (code !== undefined && !this.tools.length) throw new Error(`MCP server exited (${code}): ${stderr.slice(0, 300)}`);
    this.exitError = stderr;
    return this;
  }

  handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    if (this.exitedCode !== undefined) {
      return Promise.reject(new Error(`MCP ${this.name}: server exited (code ${this.exitedCode}) before ${method}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: timeout on ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error((result.content || []).map((c) => c.text).join("\n"));
    return (result.content || []).map((c) => c.text || "").join("\n") || "(empty result)";
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

export async function connectMcpServers(cfg) {
  const connections = [];
  for (const [name, spec] of Object.entries(cfg.mcp_servers || {})) {
    try {
      connections.push(await new McpConnection(name, spec).start());
    } catch (e) {
      console.error(`warning: MCP server "${name}" failed to start: ${e.message}`);
    }
  }
  return connections;
}
