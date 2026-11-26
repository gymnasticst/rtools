// Regression tests for the review findings:
// 1. apply_patch files are checkpointed before mutation (undo can restore them)
// 2. htmlToText resists double-escaping and strips script/style content
// 3. config writes cannot pollute Object.prototype
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
const fail = (label, e) => { failures++; console.error(`FAIL: ${label}: ${e?.message || e}`); };
const ok = (label) => console.log(`PASS: ${label}`);

const home = mkdtempSync(path.join(tmpdir(), "rt-regression-"));
process.env.HOME = home; // checkpoints and config live under ~/.rtools

// --- 1. apply_patch checkpointing -------------------------------------
try {
  const { snapshotFile, undoLast } = await import("../src/checkpoints.js");
  const { applyPatchTool, patchTargets } = await import("../src/apply-patch.js");

  const cwd = mkdtempSync(path.join(home, "cwd-"));
  const file = path.join(cwd, "a.txt");
  writeFileSync(file, "line1\nline2\n", "utf8");

  const patch =
    "*** Begin Patch\n" +
    "*** Update File: a.txt\n" +
    "@@\n" +
    "-line1\n" +
    "+line1-edited\n" +
    "*** Delete File: a.txt\n" +
    "*** End Patch\n";

  // the agent snapshots each patch target before the handler runs
  assert.deepStrictEqual(patchTargets(patch), ["a.txt", "a.txt"]);
  for (const p of patchTargets(patch)) snapshotFile(path.resolve(cwd, p), cwd);

  const tool = applyPatchTool({ cwd });
  const result = await tool.handler({ patch });
  assert.ok(result.includes("success"), result);
  assert.ok(!existsSync(file), "patch should have deleted the file");

  const restored = undoLast({ cwd });
  assert.ok(restored, "undoLast should report a restore");
  assert.ok(existsSync(file), "deleted file must be restored by /undo");
  assert.strictEqual(readFileSync(file, "utf8"), "line1\nline2\n", "restored content must match the snapshot");
  ok("apply_patch targets are checkpointed and restorable via undo");
} catch (e) { fail("apply_patch checkpointing", e); }

// --- 2. htmlToText ------------------------------------------------------
try {
  const { htmlToText } = await import("../src/tools.js");
  // double-escaped entity must come back as text, never as a live tag body
  assert.strictEqual(htmlToText("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.strictEqual(htmlToText("<p>hello</p>"), "hello");
  assert.strictEqual(htmlToText("a<script>evil()</script>b"), "ab");
  assert.strictEqual(htmlToText("a<style>.x{}</style>b"), "ab");
  assert.strictEqual(htmlToText("a&nbsp;b&nbsp;c"), "a b c");
  assert.strictEqual(htmlToText("no entities & unknown ; here"), "no entities & unknown ; here");
  ok("htmlToText: double-escaping safe, script/style stripped");
} catch (e) { fail("htmlToText", e); }

// --- 3. prototype pollution ---------------------------------------------
try {
  const { saveConfig } = await import("../src/config.js");
  const cfgFile = path.join(home, "config.toml");
  saveConfig({ __proto__: { polluted: "x" }, model: "test-model" }, { configPath: cfgFile });
  assert.strictEqual(({}).polluted, undefined, "Object.prototype must stay clean");
  assert.ok(!("polluted" in {}), "no inherited polluted key");
  assert.ok(readFileSync(cfgFile, "utf8").includes("test-model"));
  ok("saveConfig with __proto__ key does not pollute Object.prototype");
} catch (e) { fail("prototype pollution", e); }

// --- 3b. nested __proto__ in a patch must not route the walk onto Object.prototype
try {
  const { applyPatch } = await import("../src/settings-schema.js");
  const target = { model: "x" };
  applyPatch(target, JSON.parse('{"__proto__": {"polluted": "yes"}}'));
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(target.model, "x");
  applyPatch(target, JSON.parse('{"tools": {"__proto__": {"polluted": "yes"}}}'));
  assert.strictEqual(({}).polluted, undefined);
  ok("applyPatch with nested __proto__ value cannot reach Object.prototype");
} catch (e) { fail("nested prototype pollution", e); }

// --- 4. saveConfig must not wipe a malformed config ----------------------
try {
  const { saveConfig } = await import("../src/config.js");
  const broken = path.join(home, "broken.toml");
  writeFileSync(broken, "this is [ not valid toml", "utf8");
  let threw = null;
  try {
    saveConfig({ model: "x" }, { configPath: broken });
  } catch (e) { threw = e; }
  assert.ok(threw, "saveConfig must throw on a malformed config");
  assert.ok(threw.message.includes("not valid TOML"), `error must name the problem: ${threw.message}`);
  assert.strictEqual(readFileSync(broken, "utf8"), "this is [ not valid toml", "malformed config must be left untouched");
  ok("saveConfig throws on malformed config instead of wiping it");
} catch (e) { fail("saveConfig malformed config", e); }

// --- 5. apply_patch edits the occurrence the patch reached, not the first match
try {
  const { applyPatchTool } = await import("../src/apply-patch.js");
  const cwd = mkdtempSync(path.join(home, "dup-"));
  const file = path.join(cwd, "dup.txt");
  writeFileSync(file, "case a:\n  return 1;\ncase b:\n  return 1;\n", "utf8");
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: dup.txt\n" +
    "@@\n" +
    " case b:\n" +
    "-  return 20;\n" +
    "+  return 2;\n" +
    "*** End Patch\n";
  const tool = applyPatchTool({ cwd });
  // chunk context "case b:\n  return 1;" is unique here; the moving cursor is
  // exercised by the second chunk of a two-chunk patch over identical context
  const patch2 =
    "*** Begin Patch\n" +
    "*** Update File: dup.txt\n" +
    "@@\n" +
    "-  return 1;\n" +
    "+  return 10;\n" +
    "@@\n" +
    "-  return 1;\n" +
    "+  return 20;\n" +
    "*** End Patch\n";
  writeFileSync(file, "case a:\n  return 1;\ncase b:\n  return 1;\n", "utf8");
  await tool.handler({ patch: patch2 });
  assert.strictEqual(readFileSync(file, "utf8"), "case a:\n  return 10;\ncase b:\n  return 20;\n", "identical context blocks must be edited in order, first chunk first");
  writeFileSync(file, "case a:\n  return 10;\ncase b:\n  return 20;\n", "utf8");
  await tool.handler({ patch });
  assert.strictEqual(readFileSync(file, "utf8"), "case a:\n  return 10;\ncase b:\n  return 2;\n", "chunk after earlier edits must match at its own position");
  ok("apply_patch duplicate context: chunks apply in order via a moving cursor");
} catch (e) { fail("apply_patch duplicate context", e); }

// --- 6. multi-file patch is atomic: no partial application ----------------
try {
  const { applyPatchTool } = await import("../src/apply-patch.js");
  const cwd = mkdtempSync(path.join(home, "atomic-"));
  const good = path.join(cwd, "good.txt");
  writeFileSync(good, "alpha\n", "utf8");
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: good.txt\n" +
    "@@\n" +
    "-alpha\n" +
    "+alpha-edited\n" +
    "*** Update File: missing.txt\n" +
    "@@\n" +
    "-nope\n" +
    "+nope-edited\n" +
    "*** End Patch\n";
  const tool = applyPatchTool({ cwd });
  await assert.rejects(() => tool.handler({ patch }));
  assert.strictEqual(readFileSync(good, "utf8"), "alpha\n", "a failing hunk must not leave earlier hunks applied");
  ok("apply_patch multi-file failure leaves no partially applied tree");
} catch (e) { fail("apply_patch atomicity", e); }

// --- 7. expired MCP access token is refreshed silently --------------------
try {
  const http = await import("node:http");
  const mkdirSync = (await import("node:fs")).mkdirSync;
  const { getMcpAccessToken } = await import("../src/mcp-oauth.js");
  const serverName = "refresh-test";
  const cachePath = path.join(home, ".rtools", "mcp-auth.json");
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ [serverName]: { access_token: "stale", refresh_token: "rt-1", expires_at: Date.now() - 1000 } }));

  const grants = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({ registration_endpoint: `http://127.0.0.1:${srv.address().port}/register`, token_endpoint: `http://127.0.0.1:${srv.address().port}/token` });
    } else if (url.pathname === "/register") {
      json({ client_id: "cli-1" });
    } else if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        grants.push(Object.fromEntries(new URLSearchParams(body)));
        json({ access_token: "fresh-1", refresh_token: "rt-2", expires_in: 3600 });
      });
    } else { res.writeHead(404).end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const token = await getMcpAccessToken(serverName, `http://127.0.0.1:${srv.address().port}`);
    assert.strictEqual(token, "fresh-1", "refreshed access token must be returned");
    assert.strictEqual(grants.length, 1, "exactly one token request (the refresh) — no browser flow");
    assert.strictEqual(grants[0].grant_type, "refresh_token");
    assert.strictEqual(grants[0].refresh_token, "rt-1");
    const saved = JSON.parse(readFileSync(cachePath, "utf8"))[serverName];
    assert.strictEqual(saved.access_token, "fresh-1");
    assert.strictEqual(saved.refresh_token, "rt-2", "rotated refresh token must be cached");
  } finally { srv.close(); srv.closeAllConnections?.(); }
  ok("expired MCP token is refreshed via refresh_token grant without the browser flow");
} catch (e) { fail("mcp token refresh", e); }

// --- 8. blank lines inside add bodies and update chunks are data ---------
try {
  const { applyPatchTool } = await import("../src/apply-patch.js");
  const cwd = mkdtempSync(path.join(home, "blank-"));
  const tool = applyPatchTool({ cwd });

  // Add File with blank lines: they must survive into the written file
  const addPatch =
    "*** Begin Patch\n" +
    "*** Add File: blank.txt\n" +
    "+first\n" +
    "\n" +
    "+third\n" +
    "*** End Patch\n";
  await tool.handler({ patch: addPatch });
  assert.strictEqual(
    readFileSync(path.join(cwd, "blank.txt"), "utf8"),
    "first\n\nthird",
    "blank lines in an Add File body must be written verbatim"
  );

  // Update chunk whose context spans a blank line: it must still match
  const upd = path.join(cwd, "upd.txt");
  writeFileSync(upd, "before\n\nafter\n", "utf8");
  const updPatch =
    "*** Begin Patch\n" +
    "*** Update File: upd.txt\n" +
    "@@\n" +
    " before\n" +
    " \n" +
    "-after\n" +
    "+AFTER\n" +
    "*** End Patch\n";
  await tool.handler({ patch: updPatch });
  assert.strictEqual(
    readFileSync(upd, "utf8"),
    "before\n\nAFTER\n",
    "a chunk context containing a blank line must match and apply"
  );

  ok("apply_patch keeps blank lines in add bodies and update chunk context");
} catch (e) { fail("apply_patch blank lines", e); }

// --- 9. writing to a dead LSP server's stdin does not crash the process ---
try {
  const { spawn } = await import("node:child_process");
  const { lspTool, shutdownLspServers, servers } = await import("../src/lsp.js");
  const cwd = mkdtempSync(path.join(home, "lsp-"));
  const f = path.join(cwd, "a.ts");
  writeFileSync(f, "const x = 1;\n", "utf8");
  // A server that exits immediately: its stdin pipe loses its read end, so a
  // write emits an async EPIPE 'error' on the stream.
  const dead = spawn("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
  dead.stdout.on("error", () => {});
  dead.stderr.on("error", () => {});
  const epipeSeen = new Promise((res) => dead.stdin.on("error", () => res(true)));
  servers.set("ts", { child: dead, buf: "", pending: new Map(), initialized: true });
  const tool = lspTool({ cwd });
  const out = await tool.handler({ operation: "hover", file: f, line: 0, character: 0 });
  let timer;
  const sawEpipe = await Promise.race([epipeSeen, new Promise((r) => { timer = setTimeout(() => r(false), 1000); })]);
  clearTimeout(timer);
  assert.ok(sawEpipe, "the dead server's stdin must actually emit EPIPE in this scenario");
  assert.strictEqual(typeof out, "string", "handler must return a string, not crash the process");
  assert.match(out, /^Error:/, `expected an Error message from the tool, got: ${out}`);
  shutdownLspServers();
  ok("lsp write to dead server stdin returns Error instead of crashing (EPIPE handled)");
} catch (e) { fail("lsp dead stdin", e); }

// --- 10. marketplaces whose names collide after sanitization are refused ---
try {
  const { addMarketplace } = await import("../src/marketplace.js");
  const cwd = mkdtempSync(path.join(home, "mkt-"));
  // collides with the default marketplace "openai/plugins" after sanitization
  assert.throws(
    () => addMarketplace("openai_plugins"),
    /collides/,
    "a name colliding with an existing marketplace's cache dir must be refused"
  );
  const rtools = path.join(home, ".rtools");
  rmSync(path.join(rtools, "marketplaces.json"), { force: true });
  writeFileSync(path.join(rtools, "marketplaces.json"), JSON.stringify([
    { name: "owner/plugins", repo: "https://github.com/owner/plugins", ref: "main" },
  ]));
  assert.throws(
    () => addMarketplace("owner_plugins"),
    /collides/,
    "a name colliding with an added marketplace's cache dir must be refused"
  );
  const entry = addMarketplace("owner/other");
  assert.strictEqual(entry.name, "owner/other", "a non-colliding marketplace must still be added");
  ok("marketplace add refuses names colliding after sanitization (owner/plugins vs owner_plugins)");
} catch (e) { fail("marketplace cache collision", e); }

try { rmSync(home, { recursive: true, force: true }); } catch {}

if (failures) {
  console.error(`REGRESSION: ${failures} FAILED`);
  process.exit(1);
}
console.log("REGRESSION_ALL_PASSED");
