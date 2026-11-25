// Wave-3 feature checks: diff previews, checkpoints/undo, background jobs,
// hooks, usage accounting. Pure-node, no provider access.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
const check = (name, cond) => {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    failures++;
  }
};

// --- diff.js
const { unifiedDiff, approvalPreview } = await import("../src/diff.js");
const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { file: "f.txt" });
check("diff shows -b +B", d.includes("-b") && d.includes("+B") && d.includes("--- a/f.txt"));
check("diff empty when equal", unifiedDiff("x", "x") === "");
const dir = mkdtempSync(path.join(tmpdir(), "rtools-wave3-"));
const wf = path.join(dir, "w.txt");
writeFileSync(wf, "old\n");
const pv = approvalPreview(
  { name: "write_file", kind: "write" },
  { path: wf, content: "new\n" },
  dir
);
check("write preview is a diff", pv.includes("-old") && pv.includes("+new"));
const shellPv = approvalPreview({ name: "shell", kind: "shell" }, { command: "ls -la" }, dir);
check("shell preview shows command", shellPv.includes("$ ls -la"));

// --- checkpoints.js
const { snapshotFile, undoLast, listCheckpoints } = await import("../src/checkpoints.js");
const cf = path.join(dir, "c.txt");
check("no checkpoint for new file", snapshotFile(cf, dir) === null);
writeFileSync(cf, "v1\n");
const id = snapshotFile(cf, dir);
check("checkpoint id returned", typeof id === "string" && id.length > 0);
writeFileSync(cf, "v2\n");
const undo = undoLast({ cwd: dir });
check("undo restores content", undo && readFileSync(cf, "utf8") === "v1\n");
check("undo consumed", undoLast({ cwd: dir }) === null);
check("listCheckpoints empty after undo", listCheckpoints().length === 0);

// --- jobs.js
const { startJob, jobStatus, jobLogs, stopJob } = await import("../src/jobs.js");
const sj = startJob({ name: "t1", command: "echo hello-job; sleep 30", cwd: dir });
check("job started", sj.ok);
await new Promise((r) => setTimeout(r, 700));
const logs = jobLogs("t1", 10);
check("job captured output", Array.isArray(logs) && logs.some((l) => l.includes("hello-job")));
check("job status running", jobStatus("t1")?.status === "running");
const dup = startJob({ name: "t1", command: "true", cwd: dir });
check("duplicate running job rejected", !dup.ok);
const stopped = stopJob("t1");
check("stop running job", stopped.ok);
// SIGKILL is async: wait until the close event flips the status
let st = "running";
for (let i = 0; i < 20 && st === "running"; i++) {
  await new Promise((r) => setTimeout(r, 100));
  st = jobStatus("t1").status;
}
check("status after stop", st !== "running");
check("logs of unknown job", jobLogs("nope") === null);

// --- hooks.js
const { runHook } = await import("../src/hooks.js");
const hookOk = runHook({ pre_tool: "true" }, "pre_tool", { name: "shell" }, {});
check("hook passes on exit 0", hookOk.ok);
const hookBlock = runHook({ pre_tool: "exit 3" }, "pre_tool", { name: "shell" }, {});
check("hook blocks on non-zero exit", !hookBlock.ok);
check("hook skipped when unset", runHook({}, "pre_tool", { name: "shell" }, {}).ok);

// --- usage.js
const { createUsage, addUsage, formatUsage } = await import("../src/usage.js");
const u = createUsage();
addUsage(u, { input_tokens: 1000, output_tokens: 500 });
addUsage(u, { input_tokens: 500, output_tokens: 250 });
check("usage sums", u.input === 1500 && u.output === 750);
const priced = formatUsage(u, { input: 3, output: 15 });
check("cost computed from pricing", priced.includes("$0.0158"));
const unpriced = formatUsage(u, null);
check("no guessed prices", unpriced.includes("model_pricing"));

// --- team.js validation (no provider call)
const { teamTool } = await import("../src/team.js");
const team = teamTool({ ctx: { tools: [], cfg: {} } });
check("team rejects <2 roles", (await team.handler({ task: "t", roles: ["solo"] })).startsWith("Error:"));
check("team rejects >4 roles", (await team.handler({ task: "t", roles: ["a", "b", "c", "d", "e"] })).startsWith("Error:"));

// --- view_image tool contract
const { viewImageTool } = await import("../src/tools.js");
const img = path.join(dir, "pic.png");
writeFileSync(img, Buffer.from("89504e47", "hex"));
const vi = viewImageTool({ cwd: dir });
check("view_image rejects non-image", (await vi.handler({ path: "c.txt" })).startsWith("Error:"));
const loaded = await vi.handler({ path: "pic.png" });
check("view_image loads png", loaded.startsWith("image loaded:"));

// --- settings schema additions
const { SETTING_DEFS } = await import("../src/settings-schema.js");
check("trace setting present", SETTING_DEFS.some((s) => s.id === "trace"));
check("hooks settings present", SETTING_DEFS.some((s) => s.id === "hooks.pre_tool"));

if (!failures) console.log("WAVE3_ALL_PASSED");
rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
