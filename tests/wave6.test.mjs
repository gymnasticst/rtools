// Wave 6: mandatory clarifying questions (ask_user) and self-generated AGENTS.md
// (survey_project + system prompt mandate).
import { builtinTools } from "../src/tools.js";
import { systemPrompt } from "../src/agent.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`FAIL: ${name}`); }
}

const byName = (name) => builtinTools({ cwd: process.cwd() }).find((t) => t.name === name);

// --- ask_user: real tool, read-only, returns injected user answers ---
{
  const tool = byName("ask_user");
  ok(!!tool, "ask_user: tool exists in builtinTools");
  ok(tool.kind === "read", "ask_user: kind is read (no approval needed)");

  let asked = null;
  const stub = async (questions) => {
    asked = questions;
    return questions.map((q) => `${q}\n  answer: yes`).join("\n");
  };
  const prev = builtinTools._askUser;
  builtinTools._askUser = stub;
  const out = await tool.handler({ questions: ["Which framework?", "Tests allowed?"] });
  ok(Array.isArray(asked) && asked.length === 2, "ask_user: forwards questions to the TUI hook");
  ok(out.startsWith("USER ANSWERS:") && out.includes("answer: yes"), "ask_user: returns real answers to the model");

  const none = await tool.handler({ questions: [] });
  builtinTools._askUser = prev;
  ok(none.startsWith("Error:"), "ask_user: empty question list is rejected without asking");
}

// --- survey_project: real facts from the real repo ---
{
  const tool = byName("survey_project");
  ok(!!tool && tool.kind === "read", "survey_project: real read tool exists");
  const out = await tool.handler({});
  ok(out.includes("package.json: name="), "survey_project: real package.json parsed");
  ok(out.includes("test:"), "survey_project: real npm scripts listed");
  ok(out.includes("git: branch="), "survey_project: real git branch reported");
  ok(/AGENTS\.md( exists|: missing)/.test(out), "survey_project: reports AGENTS.md state (exists or missing)");
  ok(out.includes("js="), "survey_project: real file counts by extension");
}

// --- survey_project on a clean project without AGENTS.md ---
{
  const dir = mkdtempSync(path.join(tmpdir(), "rtools-survey-"));
  writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname='demo'\n");
  const out = await builtinTools({ cwd: dir }).find((t) => t.name === "survey_project").handler({});
  ok(out.includes("manifest: pyproject.toml"), "survey_project: non-node manifest detected");
  ok(out.includes("AGENTS.md: missing"), "survey_project: flags missing AGENTS.md");
  rmSync(dir, { recursive: true, force: true });
}

// --- system prompt mandate ---
{
  const p = systemPrompt({ cfg: {}, cwd: process.cwd(), skills: [] });
  ok(p.includes("Mandatory clarifying questions") && p.includes("`ask_user` tool"), "prompt: mandates ask_user before tasks");
  ok(p.includes("100% sure"), "prompt: requires 100% certainty before starting");
  ok(p.includes("write a real AGENTS.md yourself"), "prompt: mandates self-written AGENTS.md when missing");

  const off = systemPrompt({ cfg: { ask_questions: false }, cwd: process.cwd(), skills: [] });
  ok(!off.includes("Mandatory clarifying questions"), "prompt: ask_questions=false opts out");
}

console.log(fail === 0 ? `\nWAVE6: ${pass} passed, ${fail} failed\nWAVE6_ALL_PASSED` : `\nWAVE6: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
