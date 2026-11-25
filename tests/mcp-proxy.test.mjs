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

if (failures) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("ALL_PROXY_TESTS_PASSED");