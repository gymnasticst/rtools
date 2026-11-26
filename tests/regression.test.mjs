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

try { rmSync(home, { recursive: true, force: true }); } catch {}

if (failures) {
  console.error(`REGRESSION: ${failures} FAILED`);
  process.exit(1);
}
console.log("REGRESSION_ALL_PASSED");
