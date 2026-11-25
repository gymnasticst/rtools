// rtools-mcp-proxy: bridge a remote (HTTP/SSE) MCP server to stdio so the
// agent's stdio MCP client can talk to it. Used by plugins whose .mcp.json
// declares `{"type": "http", "url": ...}` servers.
// On 401 performs a real MCP OAuth flow (PKCE + dynamic registration),
// caching tokens in ~/.rtools/mcp-auth.json.
// Usage: rtools-mcp-proxy http <url>
import { createInterface } from "node:readline";
import { getMcpAccessToken, authorizedFetch } from "../src/mcp-oauth.js";

const url = process.argv[3];
if (process.argv[2] !== "http" || !url) {
  console.error("usage: rtools-mcp-proxy http <url>");
  process.exit(2);
}

let token = null;

async function post(body) {
  const headers = {};
  if (!token) {
    // probe: first request without auth; on 401 run the OAuth flow once
    const probe = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    if (probe.status === 401) {
      token = await getMcpAccessToken(url, url);
      return authorizedFetch(url, body, token);
    }
    if (body.id === undefined) return null;
    const text = await probe.text();
    if (!probe.ok || !text.trim()) {
      throw new Error(`remote MCP ${probe.status} ${probe.statusText || ""}`.trim());
    }
    return { text, status: probe.status };
  }
  return authorizedFetch(url, body, token);
}

function extractJson(text) {
  const dataLine = text.split("\n").map((l) => l.trim()).reverse().find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

async function handle(msg) {
  if (msg.id === undefined) {
    await post(msg); // notification, no response expected
    return null;
  }
  const res = await post(msg);
  const text = typeof res === "string" ? res : res.text;
  return extractJson(text);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: e.message } }) + "\n");
    }
  }
});
