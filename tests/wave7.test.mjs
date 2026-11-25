// WAVE7: built-in MCP presets (Context7, Playwright, Context-mode),
// mcp_connect and install_packages with mandatory user confirmation.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (label) => { console.log(`  ok - ${label}`); };
const fail = (label, e) => { failures++; console.error(`FAIL: ${label}: ${e?.message || e}`); };
const test = (label, fn) => { try { fn(); ok(label); } catch (e) { fail(label, e); } };
const asyncTests = [];
const testAsync = (label, fn) => asyncTests.push(() => fn().then(() => ok(label), (e) => fail(label, e)));

const { MCP_PRESETS, presetBinPath, presetInstalled, mcpConnect, installPackages, validatePackageList, mcpConnectTool, installPackagesTool } =
  await import(path.join(root, "src", "mcp-presets.js"));
const { needsApproval, systemPrompt } = await import(path.join(root, "src", "agent.js"));

test("presets: context7, playwright, context-mode with real packages", () => {
  assert.equal(MCP_PRESETS.context7.pkg, "@upstash/context7-mcp");
  assert.equal(MCP_PRESETS.playwright.pkg, "@playwright/mcp");
  assert.deepEqual(MCP_PRESETS["context-mode"].args, ["mcp"]);
  assert.equal(MCP_PRESETS["context-mode"].pkg, "context-mode");
});

test("mcp_connect: unknown name lists presets", async () => {
  const res = await mcpConnect("nope", { cfg: {}, tools: [], mcpConnections: [] });
  assert.match(res, /unknown MCP server/);
  for (const name of ["context7", "playwright", "context-mode"]) assert.ok(res.includes(name), res);
});

test("mcp_connect: empty name lists presets", async () => {
  const res = await mcpConnect("", { cfg: {}, tools: [], mcpConnections: [] });
  assert.match(res, /Available presets/);
});

test("install_packages: manager whitelist and package name validation", async () => {
  assert.match(await installPackages({ manager: "yum", packages: ["x"] }), /unknown package manager/);
  assert.match(await installPackages({ manager: "npm", packages: [] }), /non-empty array/);
  assert.match(await installPackages({ manager: "npm", packages: ["-rf /"] }), /invalid package name/);
  assert.match(await installPackages({ manager: "apt", packages: ["x;y"] }), /invalid package name/);
  assert.equal(validatePackageList(["@scope/pkg@1.2.3"]), null);
});

test("needsApproval: installs ask even with approval=never", () => {
  const tool = { name: "install_packages", kind: "shell", askAlways: true };
  const conn = { name: "mcp_connect", kind: "mcp", askAlways: true };
  assert.equal(needsApproval(tool, "never"), true);
  assert.equal(needsApproval(conn, "never"), true);
  const plain = { name: "read_file", kind: "read" };
  assert.equal(needsApproval(plain, "never"), false);
});

test("system prompt mandates context7/playwright/context-mode and confirms installs", () => {
  const p = systemPrompt({ cfg: {}, cwd: root, skills: [] });
  assert.match(p, /context7/);
  assert.match(p, /playwright/);
  assert.match(p, /context-mode/);
  assert.match(p, /mcp_connect/);
  assert.match(p, /install_packages/);
  assert.match(p, /never install packages silently/);
});

// End-to-end: a preset whose package is "already installed" (fake .bin entry)
// connects a real stdio MCP server, registers tools and persists to config.
testAsync("mcp_connect: fake context7 preset connects, registers tools, persists", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "wave7-home-"));
  const prevHome = process.env.HOME;
  let ctx;
  process.env.HOME = home;
  try {
    const srv = path.join(home, "fake-mcp.mjs");
    writeFileSync(
      srv,
      `let buf="";
process.stdin.on("data",(d)=>{buf+=d;let i;
while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;
const m=JSON.parse(line);let r;
if(m.method==="tools/list")r={tools:[{name:"get-library-docs",description:"docs",inputSchema:{type:"object"}}]};
else if(m.method==="tools/call")r={content:[{type:"text",text:"DOCS-OK "+JSON.stringify(m.params.arguments)}]};
else if(m.id===undefined)continue;else r={};
if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n");}});`
    );
    const prefix = path.join(home, ".rtools", "mcp");
    const binDir = path.join(prefix, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, MCP_PRESETS.context7.bin);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${srv}" "$@"\n`);
    chmodSync(bin, 0o755);

    const ctx0 = { cfg: { projects: { [root]: { trust: "trusted" } } }, tools: [], mcpConnections: [] };
    ctx = ctx0;
    const res = await mcpConnect("context7", ctx0);
    assert.match(res, /Connected MCP server "context7"/, res);
    assert.match(res, /get-library-docs/, res);

    const tool = ctx.tools.find((t) => t.name === "mcp__context7__get-library-docs");
    assert.ok(tool, "mcp tool registered into session tools");
    assert.equal(await tool.handler({ library: "react" }), "DOCS-OK {\"library\":\"react\"}");
    assert.equal(ctx.mcpConnections.length, 1);

    const { parseTOML } = await import(path.join(root, "src", "toml.js"));
    const saved = parseTOML(await import("node:fs").then((fs) => fs.readFileSync(path.join(home, ".rtools", "config.toml"), "utf8")));
    assert.equal(saved.mcp_servers.context7.command, bin);
    assert.deepEqual(saved.mcp_servers.context7.args, []);
  } finally {
    for (const c of ctx.mcpConnections) try { c.stop(); } catch {}
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tools: mcp_connect and install_packages are exposed with askAlways", () => {
  const ctx = { cfg: {}, tools: [], mcpConnections: [] };
  const conn = mcpConnectTool(ctx);
  const inst = installPackagesTool();
  assert.equal(conn.askAlways, true);
  assert.equal(inst.askAlways, true);
  assert.equal(conn.name, "mcp_connect");
  assert.equal(inst.name, "install_packages");
});

for (const run of asyncTests) await run();

console.log(`\nWAVE7: ${failures ? "FAILED" : "ALL PASSED"}`);
if (failures) { console.error(`WAVE7: ${failures} failed`); process.exit(1); }
console.log("WAVE7_ALL_PASSED");
