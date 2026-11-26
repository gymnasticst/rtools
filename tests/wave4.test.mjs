// Wave 4: features ported from openclaude. Every feature must work for real.
import { classifyTurn, routeModel } from "../src/smart-routing.js";
import { createTodoState, renderTodos } from "../src/todos.js";
import { parseCron, cronMatches, nextRun, addCronTask, listCronTasks, removeCronTask, dueCronTasks } from "../src/cron.js";
import { usageStats, formatStats, recordTurn } from "../src/stats.js";
import { normalizeChord, loadKeybindings, matchKeypress } from "../src/keybindings.js";
import { contextWindowFor, estimateTokens, autoCompact } from "../src/auto-compact.js";
import { setGoal, loadGoal, updateGoalStatus, clearGoal, goalPromptSection, goalTools } from "../src/goal.js";
import { sessionToMarkdown, summarizeTranscript, summaryToMarkdown, buildWiki } from "../src/share.js";
import { createVimState, vimKey } from "../src/vim.js";
import { setLanguage, t } from "../src/i18n.js";
import { addMemory, searchMemories, extractFacts, memoryTool, removeMemory, memoryPromptSection } from "../src/memory-vector.js";
import { remoteAlive, remoteExec } from "../src/remote.js";
import { listWorktrees } from "../src/worktree.js";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`FAIL: ${name}`); }
}

// --- smart routing
ok(classifyTurn("rename this variable", { firstTurn: false }) === "simple", "routing: short easy turn -> simple");
ok(classifyTurn("why does this race condition happen", { firstTurn: false }) === "strong", "routing: hard keyword -> strong");
ok(classifyTurn("big turn", { firstTurn: true }) === "strong", "routing: first turn -> strong");
ok(classifyTurn("```code```", { firstTurn: false }) === "strong", "routing: code block -> strong");
ok(routeModel({}, "rename x") === null, "routing: disabled -> null");
const routed = routeModel({ smart_routing: { enabled: true, simple: "mini-x" } }, "rename x");
ok(routed === "mini-x", `routing: enabled returns simple model (${routed})`);
ok(routeModel({ smart_routing: { enabled: true, simple: "mini-x" } }, "refactor the whole module") === null, "routing: hard turn keeps current model");

// --- todos
{
  const st = createTodoState();
  const r1 = await st.tool.handler({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] });
  ok(r1.startsWith("Todo list updated"), "todos: valid write accepted");
  const bad = await st.tool.handler({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] });
  ok(bad.startsWith("Error:") && bad.includes("at most one"), "todos: two in_progress rejected");
  ok(st.list().length === 2, "todos: state kept");
  ok(renderTodos([]) === "(no todos)", "todos: empty render");
}

// --- monitor tool: real process, exit path
{
  const { monitorTool } = await import("../src/monitor.js");
  const tool = monitorTool({ cwd: process.cwd() });
  const r = await tool.handler({ command: "echo hello-world" });
  ok(r.includes("hello-world") && r.includes("exited with code 0"), "monitor: command exit returns output");
  const r2 = await tool.handler({ command: "echo line1 && sleep 0.2 && echo READY-done", pattern: "READY" });
  ok(r2.startsWith("matched: READY-done"), "monitor: pattern triggers early return");
  const r3 = await tool.handler({ command: "sleep 5", pattern: "never", timeout_seconds: 1 });
  ok(r3.includes("timeout after 1s"), "monitor: timeout respected");
  const r4 = await tool.handler({ command: "true", pattern: "(" });
  ok(r4.startsWith("Error: invalid pattern"), "monitor: bad regex rejected");

  // Regression: bounded memory + linear scan. The old code accumulated all
  // output and re-split/rescanned it on every chunk (quadratic); a 2M-line
  // run took >20s. Each line must now be scanned once and only a bounded
  // tail kept, so this finishes in a few seconds.
  {
    const t0 = Date.now();
    const big = await tool.handler({ command: "seq 1 2000000", pattern: "MATCH-NEVER", timeout_seconds: 60 });
    const dt = Date.now() - t0;
    ok(big.includes("exited with code 0") && big.length <= 5000, `monitor: 2M-line run returns bounded output (${big.length} chars)`);
    ok(dt < 15000, `monitor: 2M-line run scanned once, not per chunk (${dt}ms)`);
  }
  // Lines split across chunks and a final line without newline must still match.
  const r5 = await tool.handler({ command: "printf 'a\\nMAT' && sleep 0.2 && printf 'CH-late' && sleep 0.2 && printf '\\n'", pattern: "MATCH-late" });
  ok(r5.startsWith("matched: MATCH-late"), "monitor: match spanning chunks and unterminated last line");
}

// --- cron
{
  const c = parseCron("*/15 9-17 * * 1-5");
  ok(c[0].size === 4 && c[1].has(9) && c[1].has(17), "cron: parse ranges and steps");
  let threw = false;
  try { parseCron("61 * * * *"); } catch (e) { threw = /out of range/.test(e.message); }
  ok(threw, "cron: out-of-range minute rejected");
  const d = new Date("2026-11-25T10:07:30");
  ok(cronMatches(parseCron("7 10 * * *"), new Date("2026-11-25T10:07:00")), "cron: minute match");
  ok(!cronMatches(parseCron("8 10 * * *"), new Date("2026-11-25T10:07:00")), "cron: minute mismatch");
  const next = nextRun(parseCron("* * * * *"), d);
  ok(next.getTime() - d.getTime() === 30000 - d.getSeconds() * 1000 || next > d, "cron: next run is after now");
  // persistence
  const task = addCronTask({ name: "__test", cronExpr: "0 12 * * *", prompt: "say hi" });
  ok(task.next_at > new Date().toISOString() || task.next_at.startsWith(new Date().toISOString().slice(0, 10)), "cron: task saved with next run");
  ok(listCronTasks().some((x) => x.name === "__test"), "cron: task listed");
  ok(removeCronTask("__test") === true, "cron: task removed");
  ok(dueCronTasks(new Date("2030-01-01")).every((x) => x.name !== "__test"), "cron: removed task not due");
}

// --- stats
{
  recordTurn({ model: "test-model", input: 1000, output: 500, seconds: 2, pricing: { input: 1, output: 2 } });
  const s = usageStats({ days: 1 });
  ok(s.total.turns >= 1 && s.total.input >= 1000, "stats: turn recorded and aggregated");
  ok(formatStats({ days: 1 }).includes("test-model"), "stats: format lists model");
}

// --- keybindings
ok(normalizeChord("ctrl+p") === "ctrl+p", "keys: simple chord");
ok(normalizeChord("SHIFT+CTRL+P") === "ctrl+shift+p", "keys: sorted modifiers");
ok(normalizeChord("ctrl+p1q") === null, "keys: double non-modifier rejected");
ok(normalizeChord("f5") === "f5", "keys: function key");
{
  const { bindings, problems } = loadKeybindings({ keybindings: { palette: "alt+p", nonsense: "x", interrupt: "ctrl+k", multiline_editor: "bad chord" } });
  ok(bindings.palette === "alt+p", "keys: override applied");
  ok(bindings.interrupt === "ctrl+c", "keys: reserved action ignored");
  ok(bindings.multiline_editor === "ctrl+g", "keys: invalid chord keeps default");
  ok(problems.length === 3, `keys: three problems reported (${problems.length})`);
  ok(matchKeypress({ name: "p", ctrl: true }, "ctrl+p"), "keys: match ctrl+p");
  ok(!matchKeypress({ name: "p", ctrl: true }, "alt+p"), "keys: wrong modifier does not match");
  ok(!matchKeypress({ name: "p", shift: true }, "p"), "keys: shift+letter does not match unshifted binding");
  ok(matchKeypress({ name: "p", shift: true }, "shift+p"), "keys: shift+letter matches shifted binding");
  ok(!matchKeypress({ name: "p" }, "shift+p"), "keys: plain letter does not match shifted binding");
}

// --- auto compact
ok(contextWindowFor("gpt-5.1") === 400000 && contextWindowFor("weird-model") === 128000, "autocompact: context windows");
const small = [{ role: "user", content: "hi" }];
const r1 = autoCompact({ messages: small, model: "x" });
ok(r1.compacted === false && r1.warn === false, "autocompact: small conversation untouched");
{
  const big = [];
  for (let i = 0; i < 400; i++) big.push({ role: "user", content: "x".repeat(2000) }, { role: "assistant", content: "y".repeat(2000) });
  const r2 = autoCompact({ messages: big, model: "weird-model", warnAt: 0.5, compactAt: 0.6 });
  ok(r2.warn === true, "autocompact: big conversation warns");
}

// --- goal
{
  clearGoal();
  ok(goalPromptSection() === "", "goal: no goal -> empty prompt section");
  setGoal("ship wave 4");
  const g = updateGoalStatus("half done");
  ok(g.state === "active" && g.status === "half done", "goal: status updated");
  ok(goalPromptSection().includes("ship wave 4"), "goal: prompt section renders");
  const [tool] = goalTools();
  const r = await tool.handler({ status: "done", state: "done" });
  ok(r.startsWith("goal state: done"), "goal: goal_status tool works");
  clearGoal();
  ok(loadGoal() === null || loadGoal()?.state === "none", "goal: cleared");
}

// --- share / summary / wiki
{
  const md = sessionToMarkdown({ id: "s1", model: "m", provider: "p", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "shell", input: { command: "ls" } }] }] });
  ok(md.includes("# Session s1") && md.includes("## User") && md.includes("tool_use") === false && md.includes("shell"), "share: transcript rendered");
  const sum = summarizeTranscript([{ role: "user", content: "do the thing" }, { role: "assistant", content: [{ type: "tool_use", name: "shell", input: { command: "ls", file_path: "src/x.js" } }] }]);
  ok(sum.userTurns.length === 1 && sum.toolCalls.length === 1, "summary: counted turns and tools");
  ok(summaryToMarkdown(sum, { id: "s1" }).includes("do the thing"), "summary: markdown output");
  const wiki = buildWiki(process.cwd() + "/src");
  ok(wiki.pages.length >= 1 && wiki.pages[0].file === "wiki-index.md", "wiki: index generated");
}

// --- vim
{
  const st = createVimState("hello");
  ok(st.mode === "normal", "vim: starts in normal mode");
  ok(vimKey(st, { sequence: "0" }) === true && st.cursor === 0, "vim: 0 to start");
  ok(vimKey(st, { sequence: "w" }) === true && st.cursor === 4, `vim: w to next word (cursor=${st.cursor})`);
  ok(vimKey(st, { sequence: "i" }) === true && st.mode === "insert", "vim: i enters insert");
  ok(vimKey(st, { sequence: "X" }) === true && st.line === "hellXo" && st.cursor === 5, `vim: typing inserts at cursor (${st.line})`);
  ok(vimKey(st, { name: "escape" }) === true && st.mode === "normal", "vim: esc to normal");
  ok(vimKey(st, { name: "left" }) === true, "vim: arrow consumed in normal");
}

// --- i18n
setLanguage("ru");
ok(t("working") === "работаю", "i18n: ru translation");
ok(t("missing key") === "missing key", "i18n: fallback to en");
setLanguage("en");
ok(t("working") === "working", "i18n: back to en");
let threwI18n = false;
try { setLanguage("de"); } catch { threwI18n = true; }
ok(threwI18n, "i18n: unsupported language rejected");

// --- memory vector
{
  const f = addMemory("run tests with npm test in rtools", { tags: ["test"] });
  ok(Number.isInteger(f.id), "memory: fact saved");
  const hits = searchMemories("how to run tests");
  ok(hits.length >= 1 && hits[0].fact.text.includes("npm test"), "memory: lexical search finds it");
  const facts = extractFacts("use `npm test` please", "Assumed: nothing");
  ok(facts.some((x) => x.text.includes("npm test")), "memory: auto-extract command");
  ok(removeMemory(f.id), "memory: forget works");
  ok(memoryPromptSection() === "" || memoryPromptSection().startsWith("\n"), "memory: prompt section safe when empty");
  const tool = memoryTool();
  const saved = await tool.handler({ action: "save", text: "temp fact for test" });
  ok(saved.startsWith("saved fact #"), "memory: tool save");
  const listed = await tool.handler({ action: "list" });
  ok(listed.includes("temp fact for test"), "memory: tool list");
  const id = Number(saved.match(/#(\d+)/)[1]);
  ok((await tool.handler({ action: "forget", id })).includes("forgotten"), "memory: tool forget");
}

// --- memory: atomic saves (regression: crash mid-write must not corrupt memory.json)
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const { saveMemories, loadMemories } = await import("../src/memory-vector.js");
  const realHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(pathMod.join(os.tmpdir(), "mem-atomic-"));
  try {
    const file = pathMod.join(process.env.HOME, ".rtools", "memory.json");
    saveMemories([{ id: 1, text: "first", tags: [], created_at: "t" }]);
    const inode1 = fs.statSync(file).ino;
    const list2 = [{ id: 1, text: "first", tags: [], created_at: "t" }, { id: 2, text: "second", tags: [], created_at: "t" }];
    saveMemories(list2);
    const inode2 = fs.statSync(file).ino;
    // Old code wrote in place (writeFileSync): the inode never changed and a
    // crash mid-write left a truncated file. Temp+rename replaces the file,
    // so the second save must get a fresh inode and full content on disk.
    ok(inode1 !== inode2, "memory: save replaces the file atomically (new inode, no in-place rewrite)");
    ok(JSON.stringify(loadMemories()) === JSON.stringify(list2), "memory: atomic save round-trips full list");
    fs.writeFileSync(`${file}.999.tmp`, "junk from a crashed writer");
    saveMemories(list2);
    ok(JSON.stringify(loadMemories()) === JSON.stringify(list2), "memory: stale temp file does not break saves");
    fs.unlinkSync(`${file}.999.tmp`);
    saveMemories(list2);
    const leftovers = fs.readdirSync(pathMod.dirname(file)).filter((f) => f.startsWith("memory.json") && f.endsWith(".tmp"));
    ok(leftovers.length === 0, "memory: no temp files left after saving");
  } finally {
    process.env.HOME = realHome;
  }
}

// --- remote (no ssh daemon in the test env: assert honest failure handling)
{
  const r = remoteExec("localhost", "echo hi", { timeoutMs: 10000 });
  ok(r.code !== 0 || r.stdout.trim() === "hi", "remote: exec returns a result or honest failure");
  ok(typeof remoteAlive("localhost") === "boolean", "remote: alive check returns boolean");
  let threwRemote = false;
  try { remoteExec("bad host; rm -rf /", "echo hi"); } catch { threwRemote = true; }
  ok(threwRemote, "remote: bad target rejected");
}

// --- worktree helpers (read-only use on this repo)
ok(Array.isArray(listWorktrees(process.cwd())), "worktree: list works in a git repo");

console.log(`WAVE4: ${pass} passed, ${fail} failed`);
if (fail) { console.error("WAVE4_FAILED"); process.exit(1); }
console.log("WAVE4_ALL_PASSED");
