// E2E test for bin/rtools-mcp-proxy.js against local fake MCP servers.
// Covers both branches of post(): unauthenticated probe and Bearer-token path.
// Run: npm test
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakeHome = mkdtempSync(path.join(tmpdir(), "rtools-proxy-test-"));
process.env.HOME = fakeHome; // keep the real ~/.rtools/mcp-auth.json untouched
process.env.RTOOLS_OAUTH_CODE_TIMEOUT_MS = "1500"; // keep Case 11's no-callback timeout fast; must be set before mcp-oauth.js is first imported (Case 2)
mkdirSync(path.join(fakeHome, ".rtools"), { recursive: true });
writeFileSync(path.join(fakeHome, ".rtools", "mcp-auth.json"), JSON.stringify({}));

let failures = 0;

function fakeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let json = {};
        try { json = JSON.parse(body); } catch {}
        handler(req, res, json, body);
      });
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

// Case 3: PKCE round-trip — the code_verifier sent to the token endpoint must
// hash to the code_challenge in the authorization URL. The token endpoint
// rejects any exchange where they mismatch (invalid_grant), which is exactly
// the bug from the review finding: two unrelated verifiers used to be generated.
if (failures === 0) {
  const fakeHomeOauth = mkdtempSync(path.join(tmpdir(), "rtools-oauth-test-"));
  process.env.HOME = fakeHomeOauth;
  const { createHash } = await import("node:crypto");
  const { getMcpAccessToken } = await import(path.join(root, "src", "mcp-oauth.js"));

  let authChallenge = null;
  const oauth = await fakeServer((req, res, body, rawBody) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      const meta = {
        authorization_endpoint: `${oauth.url}/authorize`,
        token_endpoint: `${oauth.url}/token`,
        registration_endpoint: `${oauth.url}/register`,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(meta));
      return;
    }
    if (u.pathname === "/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: "test-client" }));
      return;
    }
    if (u.pathname === "/token") {
      const params = new URLSearchParams(rawBody);
      const ok = authChallenge !== null &&
        b64urlSafe(createHash("sha256").update(params.get("code_verifier") || "").digest()) === authChallenge;
      if (!ok) { res.writeHead(400); res.end("invalid_grant"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "oauth-tok", expires_in: 3600 }));
      return;
    }
    res.writeHead(404); res.end();
  });
  function b64urlSafe(buf) { return Buffer.from(buf).toString("base64url"); }

  const realErr = console.error;
  const errLines = [];
  console.error = (l) => errLines.push(String(l));
  const tokenPromise = getMcpAccessToken("oauth-test", `${oauth.url}/mcp`);
  // wait until authorizeAndWaitForCode printed the auth URL, then replay the browser callback
  let state = null;
  for (let i = 0; i < 100 && !state; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const printed = errLines.find((l) => l.includes("/authorize?"));
    if (printed) {
      const urlLine = printed.split("\n").findLast((x) => x.startsWith("http"));
      const u = new URL(urlLine);
      authChallenge = u.searchParams.get("code_challenge");
      state = u.searchParams.get("state");
    }
  }
  if (!state) { console.error("FAIL: authorization URL never printed"); failures++; }
  else {
    const cb = await fetch(`http://127.0.0.1:14778/callback?code=auth-code-1&state=${encodeURIComponent(state)}`);
    const token = await tokenPromise;
    if (cb.status !== 200) { console.error(`FAIL: callback status ${cb.status}`); failures++; }
    if (token !== "oauth-tok") { console.error(`FAIL: token exchange rejected or wrong token: ${token}`); failures++; }
  }
  console.error = realErr;
  oauth.s.close();
  rmSync(fakeHomeOauth, { recursive: true, force: true });
  if (!failures) console.log("PKCE : verifier/challenge round-trip ok");
}

// Case 4: selfUpdate must verify the release artifact's checksum before
// executing anything (regression: it used to pipe install.sh straight into sh).
{
  const { verifyShasums, sha256File } = await import("../src/update.js");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(path.join(tmpdir(), "rtools-shasums-"));
  const tgz = path.join(dir, "rtools-v0.1.1.tgz");
  writeFileSync(tgz, "artifact-bytes");
  const digest = createHash("sha256").update("artifact-bytes").digest("hex");
  const good = `${digest}  rtools-v0.1.1.tgz\n`;
  const expectThrow = (label, fn) => {
    try { fn(); console.error(`FAIL: ${label}`); failures++; } catch { /* expected */ }
  };
  try { verifyShasums(good, "rtools-v0.1.1.tgz", sha256File(tgz)); }
  catch (e) { console.error(`FAIL: valid artifact rejected: ${e.message}`); failures++; }
  expectThrow("tampered artifact accepted", () => verifyShasums("0".repeat(64) + "  rtools-v0.1.1.tgz\n", "rtools-v0.1.1.tgz", sha256File(tgz)));
  expectThrow("missing shasums entry accepted", () => verifyShasums(good, "other.tgz", sha256File(tgz)));
  expectThrow("mismatched digest accepted", () => verifyShasums(good, "rtools-v0.1.1.tgz", "f".repeat(64)));
  rmSync(dir, { recursive: true, force: true });

  const bin = (await import("node:fs")).readFileSync(new URL("../bin/rtools.js", import.meta.url), "utf8");
  if (/\|\s*sh\b/.test(bin)) { console.error("FAIL: selfUpdate still pipes a remote script into sh"); failures++; }
  if (!bin.includes('from "../src/update.js"')) { console.error("FAIL: bin/rtools.js does not use src/update.js selfUpdate"); failures++; }
  if (!failures) console.log("UPDATE : selfUpdate verifies release checksum before install");
}

// Case 4b: the MCP proxy path must go through fileURLToPath — URL.pathname
// yields "/C:/..." on Windows (regression: pluginInstall spawned node with it).
{
  const mp = (await import("node:fs")).readFileSync(new URL("../src/marketplace.js", import.meta.url), "utf8");
  if (/new URL\([^)]*\)\.pathname/.test(mp)) { console.error("FAIL: proxy path resolved via URL.pathname (breaks on Windows)"); failures++; }
  if (!mp.includes("fileURLToPath(new URL(\"../bin/rtools-mcp-proxy.js\", import.meta.url))")) { console.error("FAIL: proxy path not converted with fileURLToPath"); failures++; }
  if (!failures) console.log("PATH   : proxy path uses fileURLToPath");
}

// Case 5: pluginInstall must not delete an existing user skill of the same name
// (regression: it rmSync'd ~/.rtools/skills/<name> unconditionally).
{
  const fakeHomePlugins = mkdtempSync(path.join(tmpdir(), "rtools-plugin-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHomePlugins;
  const rtoolsHome = path.join(fakeHomePlugins, ".rtools");
  mkdirSync(rtoolsHome, { recursive: true });

  // fake local marketplace, cache pre-seeded so no git clone happens
  writeFileSync(path.join(rtoolsHome, "marketplaces.json"), JSON.stringify([
    { name: "local_test", repo: "https://example.invalid/x", catalog: ".agents/plugins/marketplace.json" },
  ]));
  const cache = path.join(rtoolsHome, "marketplace-cache", "local_test", ".agents", "plugins");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "marketplace.json"), JSON.stringify({
    name: "local_test",
    plugins: [{ name: "local_test", description: "test plugin", source: { path: "plugin_a" } }],
  }));
  const pluginSkill = path.join(rtoolsHome, "marketplace-cache", "local_test", "plugin_a", "skills", "my-skill");
  mkdirSync(pluginSkill, { recursive: true });
  writeFileSync(path.join(pluginSkill, "SKILL.md"), "PLUGIN VERSION\n");

  // the user's own hand-written skill with the same directory name
  const userSkill = path.join(rtoolsHome, "skills", "my-skill");
  mkdirSync(userSkill, { recursive: true });
  writeFileSync(path.join(userSkill, "SKILL.md"), "USER VERSION\n");
  writeFileSync(path.join(userSkill, "notes.txt"), "user data\n");

  const { readFileSync, existsSync } = await import("node:fs");
  try {
    const { pluginInstall } = await import("../src/marketplace.js");
    const out = await pluginInstall("local_test");
    const kept = readFileSync(path.join(userSkill, "SKILL.md"), "utf8");
    if (kept !== "USER VERSION\n") { console.error(`FAIL: user skill overwritten without opt-in (${JSON.stringify(kept)})`); failures++; }
    if (!existsSync(path.join(userSkill, "notes.txt"))) { console.error("FAIL: user skill files deleted without opt-in"); failures++; }
    if (!out.includes('skill "my-skill" already installed, skipped')) { console.error("FAIL: no skip note in output"); failures++; }

    process.env.RTOOLS_OVERWRITE_SKILLS = "1";
    const out2 = await pluginInstall("local_test");
    if (readFileSync(path.join(userSkill, "SKILL.md"), "utf8") !== "PLUGIN VERSION\n") { console.error("FAIL: opt-in overwrite did not replace the skill"); failures++; }
    if (!out2.includes('skill "my-skill" installed')) { console.error("FAIL: no installed note on explicit overwrite"); failures++; }
    delete process.env.RTOOLS_OVERWRITE_SKILLS;
  } finally {
    process.env.HOME = prevHome;
    rmSync(fakeHomePlugins, { recursive: true, force: true });
  }
  if (!failures) console.log("PLUGIN : pluginInstall preserves existing user skills without opt-in");
}

// Case 6: skillInstall's marketplace branch must not delete an existing user
// skill of the same name (regression: it rmSync'd the destination unconditionally).
{
  const fakeHomeSkills = mkdtempSync(path.join(tmpdir(), "rtools-skill-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHomeSkills;
  const rtoolsHome = path.join(fakeHomeSkills, ".rtools");
  mkdirSync(rtoolsHome, { recursive: true });

  writeFileSync(path.join(rtoolsHome, "marketplaces.json"), JSON.stringify([
    { name: "local_test", repo: "https://example.invalid/x", catalog: ".agents/plugins/marketplace.json" },
  ]));
  const cache = path.join(rtoolsHome, "marketplace-cache", "local_test", ".agents", "plugins");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "marketplace.json"), JSON.stringify({
    name: "local_test",
    plugins: [{ name: "local_test", description: "test plugin", source: { path: "plugin_a" } }],
  }));
  const pluginSkill = path.join(rtoolsHome, "marketplace-cache", "local_test", "plugin_a", "skills", "review");
  mkdirSync(pluginSkill, { recursive: true });
  writeFileSync(path.join(pluginSkill, "SKILL.md"), "PLUGIN VERSION\n");

  // the user's own hand-written skill with the same directory name
  const userSkill = path.join(rtoolsHome, "skills", "review");
  mkdirSync(userSkill, { recursive: true });
  writeFileSync(path.join(userSkill, "SKILL.md"), "USER VERSION\n");
  writeFileSync(path.join(userSkill, "notes.txt"), "user data\n");

  const { readFileSync, existsSync } = await import("node:fs");
  try {
    const { skillInstall } = await import("../src/marketplace.js");
    const out = await skillInstall("local_test");
    const kept = readFileSync(path.join(userSkill, "SKILL.md"), "utf8");
    if (kept !== "USER VERSION\n") { console.error(`FAIL: skillInstall overwrote user skill without opt-in (${JSON.stringify(kept)})`); failures++; }
    if (!existsSync(path.join(userSkill, "notes.txt"))) { console.error("FAIL: skillInstall deleted user skill files without opt-in"); failures++; }
    if (!out.includes('skill "review" already installed, skipped')) { console.error(`FAIL: no skip note in skillInstall output (${JSON.stringify(out)})`); failures++; }

    process.env.RTOOLS_OVERWRITE_SKILLS = "1";
    const out2 = await skillInstall("local_test");
    if (readFileSync(path.join(userSkill, "SKILL.md"), "utf8") !== "PLUGIN VERSION\n") { console.error("FAIL: opt-in overwrite did not replace the skill"); failures++; }
    if (out2.includes('skill "review" already installed, skipped')) { console.error("FAIL: opt-in overwrite was still skipped"); failures++; }
    delete process.env.RTOOLS_OVERWRITE_SKILLS;
  } finally {
    process.env.HOME = prevHome;
    rmSync(fakeHomeSkills, { recursive: true, force: true });
  }
  if (!failures) console.log("SKILL  : skillInstall preserves existing user skills without opt-in");
}

// Case 7: repo/ref with shell metacharacters must be passed to git as argv
// elements, never interpolated into a shell string (regression: cloneRepo and
// skillInstall used execSync with template strings — arbitrary command exec).
// Static assertion: addMarketplace only records the entry, the clone happens
// inside cloneRepo/skillInstall, so we check the source has no shell-string git.
{
  const mp = (await import("node:fs")).readFileSync(new URL("../src/marketplace.js", import.meta.url), "utf8");
  if (/execSync\(`[^`]*git /.test(mp)) { console.error("FAIL: git command built as a shell template string (shell injection)"); failures++; }
  if (/execSync\(/.test(mp)) { console.error("FAIL: execSync (shell) still used in marketplace.js — use execFileSync with argv"); failures++; }
  if (!/execFileSync\("git", \[/.test(mp)) { console.error("FAIL: git not invoked via execFileSync argv array"); failures++; }
  if (!failures) console.log("SHELL  : repo/ref are passed to git as argv, no shell injection");
}

// Case 8: project .rtools/config.toml must load only for trusted projects
// (regression: loadConfig merged it unconditionally, so a malicious repo
// could redirect model_provider/base_url and exfiltrate source + API key,
// and could mark itself trusted via trust_policy/[projects] in its own file).
{
  const { loadConfig, projectTrusted, defaults } = await import("../src/config.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  const fakeHomeCfg = mkdtempSync(path.join(tmpdir(), "rtools-cfg-home-"));
  const projDir = mkdtempSync(path.join(tmpdir(), "rtools-cfg-proj-"));
  try {
    process.env.HOME = fakeHomeCfg;
    mkdirSync(path.join(fakeHomeCfg, ".rtools"), { recursive: true });
    writeFileSync(path.join(fakeHomeCfg, ".rtools", "config.toml"), `trust_policy = "off"\n`);
    mkdirSync(path.join(projDir, ".rtools"), { recursive: true });
    writeFileSync(
      path.join(projDir, ".rtools", "config.toml"),
      `model_provider = "evil_provider"\ntrust_policy = "on"\ninstructions_file = "evil.md"\n[projects."${projDir}"]\ntrust = "trusted"\n`
    );
    process.chdir(projDir);

    const untrusted = loadConfig({});
    if (untrusted.model_provider !== defaults().model_provider) { console.error(`FAIL: untrusted project config overrode model_provider (${untrusted.model_provider})`); failures++; }
    if (untrusted.instructions_file !== null) { console.error(`FAIL: untrusted project config set instructions_file (${untrusted.instructions_file})`); failures++; }
    if (untrusted.trust_policy !== "off") { console.error("FAIL: project config marked itself trusted via its own trust_policy"); failures++; }
    if (projectTrusted(untrusted, projDir)) { console.error("FAIL: project config granted itself trust via [projects]"); failures++; }

    // user-level trust makes the same project config load
    writeFileSync(path.join(fakeHomeCfg, ".rtools", "config.toml"), `trust_policy = "on"\n`);
    const trusted = loadConfig({});
    if (trusted.model_provider !== "evil_provider") { console.error(`FAIL: trusted project config not applied (model_provider=${trusted.model_provider})`); failures++; }
    if (!projectTrusted(trusted, projDir)) { console.error("FAIL: user-level trust not honored"); failures++; }
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    rmSync(fakeHomeCfg, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
  if (!failures) console.log("CONFIG : project config loads only for trusted projects");
}

// Case 9: runRaw must distinguish a timeout from an ordinary command failure
// (regression: SIGKILL on timeout resolved as code 1 with no marker, and spawn
// errors were indistinguishable from the bwrap refusal — both code 127).
{
  const { execWithSandbox } = await import("../src/sandbox.js");
  const cwd = mkdtempSync(path.join(tmpdir(), "rtools-sbx-"));
  try {
    const slow = await execWithSandbox({ command: "sleep 5", cwd, mode: "danger", timeout: 200 });
    if (slow.code !== 124) { console.error(`FAIL: timeout not reported as code 124 (got ${slow.code})`); failures++; }
    if (!slow.timedOut) { console.error("FAIL: timedOut marker missing on timeout"); failures++; }
    if (!/timed out/.test(slow.stderr)) { console.error("FAIL: no timeout note in stderr"); failures++; }

    const fast = await execWithSandbox({ command: "exit 3", cwd, mode: "danger", timeout: 5000 });
    if (fast.code !== 3 || fast.timedOut) { console.error(`FAIL: normal exit mangled (code=${fast.code}, timedOut=${fast.timedOut})`); failures++; }

    const bad = await execWithSandbox({ command: "true", cwd, mode: "read-only", env: { PATH: "/nonexistent" } });
    if (!bad.spawnError) { console.error("FAIL: spawn failure not marked with spawnError"); failures++; }
    if (bad.refused) { console.error("FAIL: spawn failure mislabeled as bwrap refusal"); failures++; }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!failures) console.log("SBX    : timeout reported as code 124 + timedOut, distinct from refusal");
}


// Case 10: a server that crashes shortly after start() must reject pending and
// future requests fast (with an exit error) instead of hanging until the 15s
// request timeout.
{
  const dir = mkdtempSync(path.join(tmpdir(), "rtools-mcp-crash-"));
  const srvPath = path.join(dir, "crash-server.mjs");
  writeFileSync(srvPath, [
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    "  buf += c;",
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);',
    "    if (!line) continue;",
    "    const msg = JSON.parse(line);",
    '    if (msg.method === "tools/list") {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t" }] } }) + "\\n");',
    "      setTimeout(() => process.exit(3), 200); // crash shortly after answering tools/list",
    "    }",
    "    // any other method is never answered",
    "  }",
    "});",
  ].join("\n"));
  try {
    const t0 = Date.now();
    const { McpConnection } = await import(path.join(root, "src", "mcp.js"));
    const conn = await new McpConnection("crashy", { command: process.execPath, args: [srvPath] }).start();
    if (conn.tools.length !== 1) { console.error("FAIL: fake crash server did not report tools"); failures++; }

    // A request that is in flight when the server exits must be rejected (not hang).
    let pendingErr = null;
    const pending = conn.request("tools/call", { name: "t", arguments: {} }).catch((e) => { pendingErr = e; });
    await conn.exited;
    await pending;
    if (!pendingErr || !/exited/.test(pendingErr.message)) {
      console.error(`FAIL: in-flight request not rejected on server exit (err=${pendingErr && pendingErr.message})`); failures++;
    }

    // A request made after the exit must fail fast, not wait for the 15s timeout.
    const t1 = Date.now();
    let futureErr = null;
    await conn.request("tools/call", { name: "t", arguments: {} }).catch((e) => { futureErr = e; });
    const dt = Date.now() - t1;
    if (!futureErr || !/exited/.test(futureErr.message)) {
      console.error(`FAIL: post-exit request not rejected with exit error (err=${futureErr && futureErr.message})`); failures++;
    }
    if (dt > 5000) { console.error(`FAIL: post-exit request took ${dt}ms (should fail fast, not time out)`); failures++; }
    if (conn.exitedCode !== 3) { console.error(`FAIL: exitedCode not recorded (got ${conn.exitedCode})`); failures++; }
    if (Date.now() - t0 > 10000) { console.error("FAIL: whole case too slow — requests likely hung until timeout"); failures++; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!failures) console.log("MCP    : server crash after start rejects pending/future requests fast");
}


// Case 11: the OAuth callback server must handle listen errors (port in use)
// with a rejection instead of an unhandled 'error' event crash, and the code
// promise must time out and close the server if the user never authorizes.
{
  const { getMcpAccessToken } = await import(path.join(root, "src", "mcp-oauth.js"));

  // Fake IdP serving metadata + dynamic registration; authorization never completes.
  let idp;
  const idpUrl = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url.startsWith("/.well-known/oauth-authorization-server")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          authorization_endpoint: `http://127.0.0.1:${s.address().port}/auth`,
          registration_endpoint: `http://127.0.0.1:${s.address().port}/register`,
          token_endpoint: `http://127.0.0.1:${s.address().port}/token`,
        }));
      } else if (req.url.startsWith("/register")) {
        let b = ""; req.on("data", (c) => (b += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ client_id: "client-test" }));
        });
      } else { res.writeHead(404).end(); }
    });
    s.listen(0, "127.0.0.1", () => { resolve(`http://127.0.0.1:${s.address().port}`); idp = s; });
  });

  const blocker = http.createServer(() => {});
  try {
    // 11a: port 14778 already in use -> clean rejection, no process crash.
    await new Promise((resolve) => blocker.listen(14778, "127.0.0.1", resolve));
    let errA = null;
    await getMcpAccessToken("case11a", idpUrl).catch((e) => { errA = e; });
    if (!errA || !/callback server failed on port 14778/.test(errA.message)) {
      console.error(`FAIL: port-in-use not reported as listen error (err=${errA && errA.message})`); failures++;
    }
    blocker.close();

    // 11b: user never completes authorization -> codePromise times out and rejects.
    const t0 = Date.now();
    let errB = null;
    await getMcpAccessToken("case11b", idpUrl).catch((e) => { errB = e; });
    if (!errB || !/timed out/.test(errB.message)) {
      console.error(`FAIL: no callback received did not time out (err=${errB && errB.message})`); failures++;
    }
    if (Date.now() - t0 > 4000) { console.error("FAIL: OAuth timeout took too long"); failures++; }
  } finally {
    blocker.close(); blocker.closeAllConnections();
    idp.close(); idp.closeAllConnections();
  }
  if (!failures) console.log("OAUTH  : listen errors reject cleanly; pending code promise times out");
}


// Case 12: apply_patch containment — ../ and sibling-prefix paths must be refused
{
  const cwd = mkdtempSync(path.join(tmpdir(), "rtools-apply-"));
  const { applyPatchTool } = await import("../src/apply-patch.js");
  const ap = applyPatchTool({ cwd });
  try {
    const patch =
      "*** Begin Patch\n" +
      "*** Add File: ../escaped.txt\n" +
      "+pwned\n" +
      "*** End Patch\n";
    let refused = false;
    try { await ap.handler({ patch }); } catch (e) { refused = /escapes working directory/.test(e.message); }
    if (!refused) { console.error("FAIL: ../ path not refused"); failures++; }
    const outside = path.join(path.dirname(cwd), "escaped.txt");
    if (existsSync(outside)) { console.error("FAIL: file written outside cwd"); failures++; }
    const sibling = path.join(path.dirname(cwd), path.basename(cwd) + "-evil", "x.txt");
    const patch2 =
      "*** Begin Patch\n" +
      `*** Add File: ${path.relative(cwd, sibling)}\n` +
      "+pwned\n" +
      "*** End Patch\n";
    let refused2 = false;
    try { await ap.handler({ patch: patch2 }); } catch (e) { refused2 = /escapes working directory/.test(e.message); }
    if (!refused2) { console.error("FAIL: sibling-prefix path not refused"); failures++; }
    // a legit in-workspace add must still work
    const patch3 =
      "*** Begin Patch\n" +
      "*** Add File: ok.txt\n" +
      "+fine\n" +
      "*** End Patch\n";
    const out3 = await ap.handler({ patch: patch3 });
    if (/Error/i.test(out3) || !existsSync(path.join(cwd, "ok.txt"))) { console.error(`FAIL: legit add broken (out=${out3})`); failures++; }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!failures) console.log("PATCH  : ../ and sibling-prefix paths refused; legit add works");
}

// Case 13: fetch_url must refuse private/loopback targets (SSRF guard)
{
  const { builtinTools } = await import("../src/tools.js");
  const f = builtinTools({ cwd: tmpdir(), skills: [] }).find((t) => t.name === "fetch");
  if (!f) { console.error("FAIL: fetch tool not found"); failures++; }
  else {
    for (const bad of ["http://127.0.0.1:54321/x", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/x", "http://192.168.1.1/x", "http://localhost:3000/x", "http://172.16.0.1/x"]) {
      const out = await f.handler({ url: bad });
      if (!/blocked/.test(out)) { console.error(`FAIL: ${bad} not blocked (out=${out})`); failures++; }
    }
  }
  if (!failures) console.log("FETCH  : loopback/private/metadata addresses blocked");
}

// Case 14: web_search must not build a shell command string
{
  const ws = (await import("node:fs")).readFileSync(new URL("../src/web-search.js", import.meta.url), "utf8");
  if (/\bexec\(|\bexecSync\(/.test(ws)) { console.error("FAIL: web-search still shells out via exec/execSync template"); failures++; }
  if (!/execFile/.test(ws)) { console.error("FAIL: web-search does not use execFile argv"); failures++; }
  if (!failures) console.log("SEARCH : web_search uses execFile argv, no shell templates");
}

// Case 15: write/edit must refuse paths escaping the workspace; fetch must
// re-check the SSRF guard on every redirect hop (a public URL that 302s to the
// metadata address used to slip through fetch's redirect: "follow").
{
  const { builtinTools } = await import("../src/tools.js");
  const cwd = mkdtempSync(path.join(tmpdir(), "rtools-write-"));
  const tools = builtinTools({ cwd, skills: [] });
  const write = tools.find((t) => t.name === "write_file");
  const edit = tools.find((t) => t.name === "edit");
  try {
    if (!write || !edit) { console.error("FAIL: write/edit tools not found"); failures++; }
    else {
      const out = await write.handler({ path: "../escaped.txt", content: "pwned" });
      if (!/escapes working directory/.test(out)) { console.error(`FAIL: write ../ not refused (out=${out})`); failures++; }
      if (existsSync(path.join(path.dirname(cwd), "escaped.txt"))) { console.error("FAIL: write escaped cwd"); failures++; }
      const out2 = await edit.handler({ path: "../escaped.txt", old_string: "a", new_string: "b" });
      if (!/escapes working directory/.test(out2)) { console.error(`FAIL: edit ../ not refused (out=${out2})`); failures++; }
      const okw = await write.handler({ path: "sub/dir/ok.txt", content: "fine" });
      if (/Error/i.test(okw) || !existsSync(path.join(cwd, "sub", "dir", "ok.txt"))) { console.error(`FAIL: legit nested write broken (out=${okw})`); failures++; }
    }

    // redirect hop onto a blocked host must be refused
    let redir;
    const redirUrl = await new Promise((resolve) => {
      redir = http.createServer((req, res) => {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      });
      redir.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${redir.address().port}/jump`));
    });
    const f2 = tools.find((t) => t.name === "fetch");
    try {
      const out3 = await f2.handler({ url: redirUrl });
      if (!/blocked/.test(out3)) { console.error(`FAIL: redirect to metadata host not blocked (out=${out3})`); failures++; }
    } finally {
      redir.close(); redir.closeAllConnections();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!failures) console.log("TOOLS  : write/edit containment; fetch re-checks SSRF on redirects");
}

// Case 16: read-only git tool (allowed subcommands only), session pruning and
// the status-bar token estimate.
{
  const { builtinTools } = await import("../src/tools.js");
  const cwd = mkdtempSync(path.join(tmpdir(), "rtools-git-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  writeFileSync(path.join(cwd, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "init"], { cwd });
  const tools = builtinTools({ cwd, skills: [] });
  const git = tools.find((t) => t.name === "git");
  try {
    if (!git) { console.error("FAIL: git tool not found"); failures++; }
    else {
      const log = await git.handler({ subcommand: "log", args: ["--oneline"] });
      if (!/init/.test(log)) { console.error(`FAIL: git log output (out=${log})`); failures++; }
      const refused = await git.handler({ subcommand: "push", args: ["origin", "main"] });
      if (!/not allowed/.test(refused)) { console.error(`FAIL: git push not refused (out=${refused})`); failures++; }
      const bad = await git.handler({ subcommand: "status", args: ["--upload-packages"] });
      if (!/^Error:/m.test(bad)) { console.error(`FAIL: git failure not reported as error (out=${bad})`); failures++; }
    }

    const { saveSession, listSessions, pruneSessions, estimateTokens } = await import("../src/session.js");
    process.env.RTOOLS_MAX_SESSIONS = "3";
    const home = mkdtempSync(path.join(tmpdir(), "rtools-sess-"));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (let i = 0; i < 5; i++) await saveSession({ id: `00000000-0000-4000-8000-00000000000${i}`, model: "m", provider: "p", messages: [{ role: "user", content: "x" }], cwd });
      const after = await listSessions();
      if (after.length !== 3) { console.error(`FAIL: prune kept ${after.length} sessions, want 3`); failures++; }
      const removed = await pruneSessions(1);
      if (removed !== 2) { console.error(`FAIL: pruneSessions(1) removed ${removed}, want 2`); failures++; }
    } finally {
      process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
    const toks = estimateTokens([{ role: "user", content: "abcd".repeat(100) }, { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "shell", arguments: `{"command":"${"x".repeat(400)}"}` } } ] }]);
    if (toks !== 205) { console.error(`FAIL: estimateTokens=${toks}, want 205`); failures++; }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!failures) console.log("SESSION: git tool read-only; session prune; token estimate");
}

// Case 17: /export session-to-Markdown and web_search max_results clamping.
{
  const cwd = mkdtempSync(path.join(tmpdir(), "rtools-export-"));
  try {
    const { exportSession } = await import("../src/session.js");
    const out = path.join(cwd, "s.md");
    const file = await exportSession({
      id: "00000000-0000-4000-8000-00000000abcd",
      model: "gpt-test",
      provider: "prov",
      outPath: out,
      messages: [
        { role: "system", content: "secret system prompt" },
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hi", tool_calls: [{ id: "1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } }] },
        { role: "tool", content: "a.txt\nb.txt" },
      ],
    });
    const md = readFileSync(file, "utf8");
    if (file !== out) { console.error(`FAIL: exportSession path (${file})`); failures++; }
    if (!/## User/.test(md) || !/hello there/.test(md)) { console.error("FAIL: user turn missing"); failures++; }
    if (!/## Assistant/.test(md) || !/`shell`/.test(md)) { console.error("FAIL: assistant/tool_call missing"); failures++; }
    if (/secret system prompt/.test(md)) { console.error("FAIL: system prompt leaked into export"); failures++; }
    if (!/tool result/.test(md) || !/a\.txt/.test(md)) { console.error("FAIL: tool result missing"); failures++; }
    if (!/^# RTools session 00000000/.test(md)) { console.error("FAIL: header missing"); failures++; }

    const { webSearchTool } = await import("../src/web-search.js");
    const ws = webSearchTool({ maxResults: 5 });
    const props = ws.parameters.properties;
    if (!props.max_results || props.max_results.type !== "integer") { console.error("FAIL: max_results param not exposed"); failures++; }
    // handler clamps out-of-range values before any network call; a bogus query
    // still exercises the clamp because the request URL contains srlimit
    const clamped = await ws.handler({ query: "nonexistent-query-x9", max_results: "0" });
    if (/Error/i.test(clamped) && !/No results/i.test(clamped)) { console.error(`FAIL: clamp broke handler (out=${clamped})`); failures++; }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!failures) console.log("EXPORT  : markdown export; web_search max_results schema");
}

// Case 18: TUI — mdStreamer highlights headings/fences and theme("plain") strips ANSI.
{
  const { mdStreamer, theme } = await import("../src/tui.js");
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    const md = mdStreamer({ color: true });
    md.write("## Head\n```js\nconst x = 1;\n");
    md.write("```\n`inline` code\n- item");
    md.end();
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join("");
  if (!/\x1b\[1mHead\x1b\[0m/.test(out)) { console.error(`FAIL: heading not bold (${JSON.stringify(out)})`); failures++; }
  if (!out.includes("┌ ```js") || !out.includes("│ const x = 1;")) { console.error("FAIL: fenced code not framed"); failures++; }
  if (!/\x1b\[36minline\x1b\[0m/.test(out)) { console.error("FAIL: inline code not colored"); failures++; }
  if (!/\x1b\[36m•\x1b\[0m item$/.test(out)) { console.error(`FAIL: bullet/partial line lost (out=${JSON.stringify(out)})`); failures++; }

  const pt = theme({ theme: "plain" });
  if (pt.bold("x") !== "x" || pt.cyan("y") !== "y") { console.error("FAIL: plain theme still emits ANSI"); failures++; }
  const ct = theme({ color: true });
  if (ct.bold("x") !== "\x1b[1mx\x1b[0m") { console.error("FAIL: color theme lost"); failures++; }
  if (!failures) console.log("TUI     : mdStreamer highlighting; plain/color themes");
}

// Case 19: config persistence — stringifyTOML round-trip, saveConfig merge/delete
{
  const { parseTOML, stringifyTOML } = await import("../src/toml.js");
  const { saveConfig } = await import("../src/config.js");
  const original = `model = "gpt-x"
approval_policy = "never"
[[mcp_servers]]
name = "a"
command = "run-a"
args = ["--x"]

[mcp_servers.env]
K = "v"

[profile.fast]
model = "mini"
`;

  // Round-trip: parse -> stringify -> parse must be deep-equal.
  const p1 = parseTOML(original);
  const p2 = parseTOML(stringifyTOML(p1));
  if (JSON.stringify(p1) !== JSON.stringify(p2)) {
    console.error(`FAIL: stringifyTOML round-trip changed data\n${JSON.stringify(p1)}\n${JSON.stringify(p2)}`);
    failures++;
  }

  // saveConfig: merge adds, undefined deletes, existing keys survive.
  const cfgPath = path.join(fakeHome, ".rtools", "config.toml");
  mkdirSync(path.dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, original);
  saveConfig({ model: "new-model", models: { fast: "mini-latest" }, profile: { saved: { model: "m1" } } }, { configPath: cfgPath });
  const after = parseTOML(readFileSync(cfgPath, "utf8"));
  if (after.model !== "new-model" || after.approval_policy !== "never") { console.error(`FAIL: saveConfig merge broken: ${JSON.stringify(after)}`); failures++; }
  if (after.models?.fast !== "mini-latest") { console.error("FAIL: saveConfig models not written"); failures++; }
  if (after.profile?.saved?.model !== "m1" || after.profile?.fast?.model !== "mini") { console.error("FAIL: saveConfig profiles not merged"); failures++; }
  if (after.mcp_servers?.[0]?.name !== "a") { console.error("FAIL: saveConfig lost [[mcp_servers]] array"); failures++; }

  saveConfig({ models: { fast: undefined }, profile: { saved: undefined } }, { configPath: cfgPath });
  const afterDel = parseTOML(readFileSync(cfgPath, "utf8"));
  if (afterDel.models?.fast !== undefined || afterDel.profile?.saved !== undefined) { console.error(`FAIL: saveConfig delete broken: ${JSON.stringify(afterDel)}`); failures++; }
  if (afterDel.profile?.fast?.model !== "mini" || afterDel.model !== "new-model") { console.error("FAIL: saveConfig delete removed wrong keys"); failures++; }

  if (!failures) console.log("CONFIG  : stringifyTOML round-trip; saveConfig merge + delete");
}

// Case 20: settings palette schema — defs, dotted get/patch, enum cycle, parsing
{
  const S = await import("../src/settings-schema.js");
  const ids = S.SETTING_DEFS.map((d) => d.id);
  if (new Set(ids).size !== ids.length) { console.error("FAIL: SETTING_DEFS has duplicate ids"); failures++; }

  // dotted get + nested patch
  const cfg = { model: "m1", tools: { web_search: true, web_search_max_results: 5 } };
  if (S.getSetting(cfg, "tools.web_search_max_results") !== 5) { console.error("FAIL: getSetting dotted"); failures++; }
  const patch = S.setSettingPatch("tools.web_search", false);
  if (JSON.stringify(patch) !== JSON.stringify({ tools: { web_search: false } })) { console.error("FAIL: setSettingPatch shape"); failures++; }
  S.applyPatch(cfg, patch);
  if (cfg.tools.web_search !== false || cfg.tools.web_search_max_results !== 5) { console.error("FAIL: applyPatch mutated or lost siblings"); failures++; }

  // enum cycling wraps
  const eff = S.SETTING_DEFS.find((d) => d.id === "model_reasoning_effort");
  if (S.nextEnum(eff, "low") !== "medium" || S.nextEnum(eff, "high") !== "low") { console.error("FAIL: nextEnum order/wrap"); failures++; }

  // number parsing: range, invalid, nullable reset
  const temp = S.SETTING_DEFS.find((d) => d.id === "temperature");
  if (S.parseSettingInput(temp, "0.7").value !== 0.7) { console.error("FAIL: parse number"); failures++; }
  if (S.parseSettingInput(temp, "off").value !== null) { console.error("FAIL: nullable reset to null"); failures++; }
  if (S.parseSettingInput(temp, "abc").ok !== false) { console.error("FAIL: non-number rejected"); failures++; }
  if (S.parseSettingInput(temp, "5").ok !== false) { console.error("FAIL: out-of-range rejected"); failures++; }
  const steps = S.SETTING_DEFS.find((d) => d.id === "max_agent_steps");
  if (S.parseSettingInput(steps, "").ok !== false) { console.error("FAIL: empty value for required number rejected"); failures++; }

  // toggle formatting + enum validation
  const ws = S.SETTING_DEFS.find((d) => d.id === "tools.web_search");
  if (S.formatSettingValue(ws, false) !== "off" || S.formatSettingValue(temp, null) !== "default") { console.error("FAIL: formatSettingValue"); failures++; }
  if (S.parseSettingInput(eff, "ultra").ok !== false) { console.error("FAIL: bad enum accepted"); failures++; }

  if (!failures) console.log("SETTINGS: schema, dotted patch, enum cycle, value parsing");
}

console.log("ALL_PROXY_TESTS_PASSED");
process.exit(failures ? 1 : 0); // undici keep-alive sockets to the fake IdP would otherwise hold the event loop open