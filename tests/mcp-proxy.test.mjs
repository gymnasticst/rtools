// E2E test for bin/rtools-mcp-proxy.js against local fake MCP servers.
// Covers both branches of post(): unauthenticated probe and Bearer-token path.
// Run: npm test
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakeHome = mkdtempSync(path.join(tmpdir(), "rtools-proxy-test-"));
process.env.HOME = fakeHome; // keep the real ~/.rtools/mcp-auth.json untouched
mkdirSync(path.join(fakeHome, ".rtools"), { recursive: true });
writeFileSync(path.join(fakeHome, ".rtools", "mcp-auth.json"), JSON.stringify({}));

let failures = 0;

function fakeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, JSON.parse(body)));
    });
    s.listen(0, () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

function rpc(url) {
  return new Promise((resolve) => {
    const p = spawn("node", [path.join(root, "bin", "rtools-mcp-proxy.js"), "http", url]);
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) {
        p.kill();
        resolve(out.trim());
      }
    });
    p.stderr.on("data", () => {});
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    setTimeout(() => {
      p.kill();
      resolve(out.trim() || "TIMEOUT: no proxy response");
    }, 5000);
  });
}

const okJson = (result) => (req, res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
};

// Case 1: server with no auth — the path that used to throw res.text is not a function
const open = await fakeServer(okJson({ echo: "open-ok" }));
const openRes = await rpc(open.url);
console.log("OPEN :", openRes);
if (JSON.parse(openRes)?.result?.echo !== "open-ok") { console.error("FAIL: unauthenticated path"); failures++; }
open.s.close();

// Case 2: server requiring a Bearer token, pre-seeded in the fake-home cache
const auth = await fakeServer((req, res, body) => {
  if (req.headers.authorization !== "Bearer tok") { res.writeHead(401); res.end(); return; }
  okJson({ echo: "auth-ok" })(req, res, body);
});
const authUrl = auth.url;
writeFileSync(path.join(fakeHome, ".rtools", "mcp-auth.json"),
  JSON.stringify({ [authUrl]: { access_token: "tok", expires_at: Date.now() + 3600_000 } }));
const authRes = await rpc(authUrl);
console.log("AUTH :", authRes);
if (JSON.parse(authRes)?.result?.echo !== "auth-ok") { console.error("FAIL: authenticated path"); failures++; }
auth.s.close();

rmSync(fakeHome, { recursive: true, force: true });
if (failures) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("ALL_PROXY_TESTS_PASSED");
