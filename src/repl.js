import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, appendFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import { runAgentLoop, systemPrompt, needsApproval } from "./agent.js";
import { saveConfig, BUILTIN_PROVIDERS } from "./config.js";
import { SETTING_DEFS, getSetting, setSettingPatch, applyPatch, nextEnum, parseSettingInput, formatSettingValue } from "./settings-schema.js";
import { pick, typeText, confirm, PALETTE_CANCEL } from "./palette.js";
import { saveSession, listSessions, loadSession, compactMessages, estimateTokens } from "./session.js";
import { autoCompact } from "./auto-compact.js";
import { routeModel } from "./smart-routing.js";
import { formatStats, recordTurn } from "./stats.js";
import { loadKeybindings, matchKeypress, ACTIONS } from "./keybindings.js";
import { setGoal, loadGoal, clearGoal, updateGoalStatus } from "./goal.js";
import { addCronTask, listCronTasks, removeCronTask, dueCronTasks } from "./cron.js";
import { setLanguage, t } from "./i18n.js";
import { createVimState, vimKey } from "./vim.js";
import { sessionToMarkdown, summarizeTranscript, summaryToMarkdown, buildWiki } from "./share.js";
import { fileBrowser, terminalPanel, subagentsPanel, mcpPanel, pluginsPanel } from "./panels.js";
import { enterWorktree, exitWorktree, listWorktrees, inWorktree } from "./worktree.js";
import { remoteAlive, remoteExec } from "./remote.js";
import { changedFilesSince } from "./apply-patch.js";
import { SANDBOX_MODES, setShellOutputSink, setShellAbort, abortCurrentShell } from "./sandbox.js";
import { approvalPreview } from "./diff.js";
import { undoLast, listCheckpoints } from "./checkpoints.js";
import { jobStatus, jobLogs, startJob, stopJob } from "./jobs.js";
import { createTracer } from "./trace.js";
import { builtinTools } from "./tools.js";
import { createUsage, addUsage, formatUsage } from "./usage.js";
import { gitStatus, copyToClipboard, statusBar } from "./tui.js";
import { banner, Spinner, toolNotice, turnStart, mdStreamer } from "./tui.js";

const HELP = `Commands:
  /help            show this help
  /init            create an AGENTS.md file with instructions for RTools
  /review [target] review changes (uncommitted | <commit> | <base-branch>) and find issues
  /permissions     show/choose what RTools is allowed to do (approval + sandbox)
  /plan            toggle plan mode (read-only: effectful tools require approval)
  /model <name>    switch model (alias from /model add also works)
  /model list      list models from the provider API + saved aliases
  /model add|rm    save/remove a model alias: /model add <alias> <model-id>
  /provider <id>   switch model provider (built-in or from config.toml)
  /provider list|add|rm   list providers; add/rm custom ones
  /agent list|use|add|rm   agent profiles from [profile.*] in config.toml
  /policy <mode>   approval policy: untrusted | never | always
  /sandbox <mode>  sandbox mode: read-only | workspace | danger
  /tools           list available tools (built-in + MCP plugins)
  /skills          list available skills
  /status          show current settings
  /diff            show changed files (git status)
  /export [file]   export this session to a Markdown file (default: rtools-session-<id>.md)
  /compact         summarize and shrink the conversation
  /resume [id|last] resume a saved session (lists sessions if no id; "last" = newest)
  /settings        show every setting (Codex-style config)
  /palette         open the command palette (Ctrl+P; Ctrl+O = settings)
  /effort <level>  reasoning effort: low | medium | high
  /verbosity <v>   answer verbosity: low | medium | high
  /usage           token usage and estimated cost for this session
  /jobs [name]     background jobs: /jobs start <n> <cmd>, status, logs, stop
  /undo            restore the file changed by the last write/edit (checkpoints)
  /checkpoints     list file checkpoints
  /trace [on|off]  JSONL step/tool logging under ~/.rtools/logs
  /copy            copy the last assistant answer to the clipboard
  /find <text>     search this session's transcript
  /paste           paste a multi-line block; finish with a line "."
  /edit            compose a long prompt in $EDITOR
  /clear           start a fresh conversation
  /quit            exit`;

const REVIEW_PROMPT = (target) =>
  `You are performing a code review${target ? ` of ${target}` : " of the uncommitted changes"}. ` +
  "Run `git diff` / `git status` to see the changes, read the touched files, and report prioritized findings " +
  "(bugs, security issues, missing tests) as a numbered list with file:line references. Do not modify any files.";

export async function startREPL(ctx) {
  const SLASH_COMMANDS = [
    "/init", "/review", "/permissions", "/plan", "/prompts", "/tools", "/skills",
    "/status", "/diff", "/compact", "/resume", "/settings", "/effort", "/verbosity",
    "/model", "/provider", "/agent", "/clear", "/quit", "/palette",
    "/usage", "/jobs", "/undo", "/checkpoints", "/trace", "/copy", "/find", "/paste", "/edit",
  ];
  const completer = (line) => {
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  };
  // OpenCode-style palettes need raw-mode stdin, so they run without the
  // readline interface: the old one is closed (pending waiters get a tick so
  // the loop re-parks), the palette owns the terminal, then a fresh interface
  // takes over. The sentinel wakes the loop without being treated as input.
  const PALETTE_TICK = "\x00palette-tick";
  let rl = null;
  let suppressClose = false;
  const lineQueue = [];
  const lineWaiters = [];
  const makeRL = () => {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
    rl.on("line", (l) => {
      const w = lineWaiters.shift();
      if (w) w(l);
      else lineQueue.push(l);
    });
    rl.on("close", () => {
      while (lineWaiters.length) lineWaiters.shift()(suppressClose ? PALETTE_TICK : null);
      suppressClose = false;
    });
  };
  makeRL();
  // readline/promises drops lines that arrive while no question is pending
  // (e.g. all piped input at once), so keep our own queue.
  const nextLine = (prompt) => {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    return new Promise((resolve) => lineWaiters.push(resolve)).then((l) => {
      rl.prompt?.();
      if (prompt) process.stdout.write(prompt);
      return l;
    });
  };
  const sessionId = randomUUID();
  // Load the persisted command history into readline so ↑/↓ works from a fresh start.
  if (process.stdin.isTTY && ctx.cfg.history?.persistence !== "none") {
    try {
      const histFile = path.join(homedir(), ".rtools", "history.txt");
      const lines = readFileSync(histFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t").slice(1).join("\t"))
        .slice(-100);
      rl.history = [...new Set(lines.reverse())];
    } catch {
      // no history file yet — fine
    }
  }
  let messages = [];
  let {
    approval_policy: approval,
    sandbox_mode: sandbox,
    model,
    model_reasoning_effort: effort,
    model_verbosity: verbosity,
    temperature,
    top_p,
    max_output_tokens,
  } = ctx.cfg;
  const settings = () => ({ effort, verbosity, temperature, top_p, max_output_tokens, hooks: ctx.cfg.hooks });
  const usageTracker = createUsage();
  const trace = createTracer({ enabled: !!ctx.cfg.trace, sessionId });

  const contextWindow = Number(ctx.cfg.context_window) || 128000;
  const statusBarLine = () => {
    const used = estimateTokens(messages);
    return statusBar({ model, effort, tokensLeft: Math.max(0, Math.round((1 - used / contextWindow) * 100)), tokensUsed: used, git: gitStatus(), jobs: jobStatus().filter((j) => j.status === "running").length });
  };
  const notifyEvent = (event) => {
    if (!ctx.cfg.notify) return;
    const [prog, ...args] = Array.isArray(ctx.cfg.notify) ? ctx.cfg.notify : [ctx.cfg.notify];
    try {
      spawnProcess(prog, [...args, JSON.stringify(event)], { stdio: "ignore" }).unref();
    } catch {
      // notification is best-effort
    }
  };

  const appendHistory = (input) => {
    if (ctx.cfg.history?.persistence === "none") return;
    try {
      const dir = path.join(homedir(), ".rtools");
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, "history.txt"), `${Date.now()}\t${input}\n`);
    } catch (e) {
      // history is best-effort
      process.stderr.write(`history: ${e.message}\n`);
    }
  };

  banner({ version: "0.1.0", model, effort, provider: ctx.provider.id, cwd: ctx.cwd });
  console.log(statusBarLine());

  let planMode = false;
  let planModeToggled = false;
  const taskAllow = new Set(); // tools approved with "a" — until the turn ends
  const togglePlan = () => {
    planMode = !planMode;
    planModeToggled = true;
    console.log(planMode ? "plan mode: ON — RTools will read and plan but not change anything (writes/shell ask approval)" : "plan mode: OFF");
  };

  const askApproval = async (tool, call) => {
    // show what the call would actually do (diff for writes, command for shell)
    let preview = "";
    let args = {};
    try {
      args = JSON.parse(call?.arguments || "{}") || {};
    } catch {
      args = {};
    }
    try {
      preview = approvalPreview(tool, args, ctx.cwd);
    } catch {
      preview = "";
    }
    if (preview) {
      console.log(C.gray(`\n${preview}\n`));
    }
    process.stdout.write(`Allow ${tool.kind} tool "${tool.name}"? [y/n/a/A] (a = this task, A = this session) `);
    const answer = await nextLine("");
    const k = answer.trim().toLowerCase();
    if (k === "a") {
      taskAllow.add(tool.name); // allow this tool until the task (turn) ends
      return true;
    }
    if (k === "A" || answer.trim() === "A") {
      approval = "never";
      return true;
    }
    return k === "y";
  };

  const newSession = () => {
    messages = [{ role: "system", content: systemPrompt(ctx) }];
  };
  newSession();

  // Shrink the conversation automatically when it approaches the context window.
  const autoCompact = () => {
    const used = estimateTokens(messages);
    const limit = Math.floor(contextWindow * 0.85);
    if (used <= limit) return null;
    const next = compactMessages(messages);
    if (!next) return null;
    messages = next;
    return used;
  };

  const persist = () =>
    saveSession({ id: sessionId, model, provider: ctx.provider.id, messages, cwd: ctx.cwd }).catch(() => {});

  // ask_user tool hook: pause the spinner, ask through the TUI, resume
  let currentSpinner = null;
  builtinTools._askUser = async (questions) => {
    currentSpinner?.stop();
    const out = [];
    for (const q of questions) {
      process.stdout.write(C.cyan(`\n? ${q}\n`));
      const a = (await nextLine("> ")) || "";
      out.push(`${q}\n  answer: ${a.trim() || "(no answer)"}`);
    }
    currentSpinner?.start();
    return out.join("\n");
  };

  const runTurn = async (input) => {
    taskAllow.clear(); // "a" approvals last one task/turn
    const spinner = new Spinner("working").start();
    currentSpinner = spinner;
    const sawText = { any: false };
    const abort = new AbortController();
    currentAbort = abort;
    setShellAbort(abort);
    setShellOutputSink((d) => {
      const line = String(d).split("\n").filter(Boolean).pop();
      if (line) spinner.setLabel(line.slice(0, 60));
    });
    try {
      const routed = routeModel(ctx.cfg, input, { firstTurn: usageTracker.turns === 0 });
      const r = await runAgentLoop({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model,
        messages: autoCompact({ messages, model, warnAt: 0.8, compactAt: 0.92 }).messages,
        tools: ctx.tools,
        approval,
        sandbox,
        signal: abort.signal,
        usageTracker,
        trace,
        cwd: ctx.cwd,
        maxSteps: ctx.cfg.max_agent_steps || 40,
        settings: { ...settings(), turnModel: routed },
        planMode,
        onText: (d) => {
          if (!sawText.any) {
            spinner.stop();
            sawText.md = sawText.md || mdStreamer({ theme: ctx.cfg.theme, color: ctx.cfg.color });
            sawText.any = true;
          }
          sawText.md.write(d);
        },
        onToolResult: (tool, result) => {
          if (sawText.any || process.env.RTOOLS_QUIET) return;
          toolNotice(tool.name, String(result).split("\n")[0]);
        },
        askApproval: async (tool, call) => {
          if (taskAllow.has(tool.name)) return true;
          spinner.stop();
          const ok = await askApproval(tool, call);
          if (!sawText.any) spinner.start();
          return ok;
        },
      });
      if (r?.stepLimitReached) {
        console.log(`\nreached the ${ctx.cfg.max_agent_steps || 40}-step limit — say "continue" to keep going`);
      }
      usageTracker.turns++;
      recordTurn({
        model,
        input: usageTracker.input,
        output: usageTracker.output,
        seconds: 0,
        pricing: ctx.cfg.model_pricing,
      });
    } finally {
      spinner.stop();
      currentSpinner = null;
      currentAbort = null;
      if (sawText.md) sawText.md.end();
    }
  };

  const cmdInit = () => {
    const file = path.join(ctx.cwd, "AGENTS.md");
    if (existsSync(file)) {
      console.log(`AGENTS.md already exists (${file}) — leaving it untouched.`);
      return;
    }
    const pkg = existsSync(path.join(ctx.cwd, "package.json"))
      ? JSON.parse(readFileSync(path.join(ctx.cwd, "package.json"), "utf8"))
      : null;
    let summary = "";
    try {
      summary = execFileSync("git", ["ls-files"], { cwd: ctx.cwd, encoding: "utf8" });
    } catch {
      summary = "";
    }
    const body = [
      "# AGENTS.md",
      "",
      "## Project",
      pkg?.name ? `Name: ${pkg.name}` : "Describe the project here.",
      pkg?.description ? pkg.description : "",
      "",
      "## Build & test",
      pkg?.scripts ? Object.entries(pkg.scripts).map(([k, v]) => `- npm run ${k} — ${v}`).join("\n") : "- describe how to build and test",
      "",
      "## Conventions",
      "- Be concise; follow existing code style.",
      "",
      "## Files",
      summary ? "Tracked files (top-level): " + summary.split("\n").slice(0, 10).join(", ") : "",
    ].join("\n");
    writeFileSync(file, body);
    console.log(`Created ${file} — edit it to guide RTools in this project.`);
  };

  const cmdReview = async (target) => {
    turnStart(`review ${target || "uncommitted changes"}`);
    messages.push({ role: "user", content: REVIEW_PROMPT(target) });
    try {
      await runTurn(REVIEW_PROMPT(target));
      await persist();
    } catch (e) {
      console.error(`\nerror: ${e.message}`);
    }
  };

  const cmdPermissions = async () => {
    console.log(`approval policy: ${approval} (untrusted | never | always)`);
    console.log(`sandbox mode:    ${sandbox} (read-only | workspace | danger)`);
    const answer = await nextLine("new approval policy (Enter to keep): ");
    if (answer.trim() && ["untrusted", "never", "always"].includes(answer.trim())) approval = answer.trim();
    const answer2 = await nextLine("new sandbox mode (Enter to keep): ");
    if (answer2.trim() && SANDBOX_MODES.includes(answer2.trim())) sandbox = answer2.trim();
    console.log(`approval: ${approval}, sandbox: ${sandbox}`);
  };

  // --- OpenCode-style Ctrl+P command palette / Ctrl+O settings -------------
  const PALETTE_COMMANDS = [
    ["/help", "show all commands"],
    ["/init", "create AGENTS.md"],
    ["/review", "review changes"],
    ["/permissions", "approval + sandbox"],
    ["/plan", "toggle plan mode"],
    ["/model", "switch model"],
    ["/model list", "list models"],
    ["/provider", "switch provider"],
    ["/provider list", "list providers"],
    ["/agent list", "agent profiles"],
    ["/policy", "approval policy"],
    ["/sandbox", "sandbox mode"],
    ["/tools", "list tools"],
    ["/skills", "list skills"],
    ["/status", "current settings"],
    ["/diff", "changed files"],
    ["/export", "export session to Markdown"],
    ["/compact", "shrink the conversation"],
    ["/resume", "resume a saved session"],
    ["/effort", "reasoning effort"],
    ["/verbosity", "answer verbosity"],
    ["/usage", "token usage and cost"],
    ["/jobs", "background jobs"],
    ["/undo", "restore last changed file"],
    ["/checkpoints", "list file checkpoints"],
    ["/trace", "toggle JSONL trace log"],
    ["/copy", "copy last answer"],
    ["/find", "search transcript"],
    ["/paste", "paste multi-line input"],
    ["/edit", "compose in $EDITOR"],
    ["/files", "browse files & directories"],
    ["/terminal", "run shell commands in a panel"],
    ["/agents", "live sub-agent activity"],
    ["/mcp", "MCP server status"],
    ["/plugin list", "installed plugins"],
    ["/clear", "new conversation"],
    ["/quit", "exit"],
  ];
  // unified launcher: commands + files, filter is shared
  const launchPalette = async () => {
    const fileItems = [];
    try {
      const out = execFileSync("git", ["ls-files"], { cwd: ctx.cwd, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).toString();
      for (const f of out.split("\n").filter(Boolean).slice(0, 2000)) fileItems.push([`@${f}`, "file", () => ({ text: `@${f}` })]);
    } catch {
      // not a git repo or git missing — commands only
    }
    const all = [
      ...PALETTE_COMMANDS.map(([cmd, hint]) => [cmd, hint, () => ({ line: cmd })]),
      ...fileItems,
    ];
    const picked = await pick({ title: "commands & files", items: all.map(([label, hint]) => ({ label, hint })) });
    if (!picked) return null;
    const entry = all.find(([label]) => label === picked.label);
    return entry ? entry[2]() : null;
  };
  const providerIds = () => [...new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(ctx.cfg.model_providers || {})])];
  const LIVE_APPLY = {
    model: (v) => { model = v; },
    approval_policy: (v) => { approval = v; },
    sandbox_mode: (v) => { sandbox = v; },
    model_reasoning_effort: (v) => { effort = v; },
    model_verbosity: (v) => { verbosity = v; },
    temperature: (v) => { temperature = v; },
    top_p: (v) => { top_p = v; },
    max_output_tokens: (v) => { max_output_tokens = v; },
    max_agent_steps: () => {},
  };
  const applySetting = async (def, value) => {
    applyPatch(ctx.cfg, setSettingPatch(def.id, value));
    LIVE_APPLY[def.id]?.(value);
    const shown = formatSettingValue(def, value);
    console.log(`${def.label}: ${shown}${def.note ? ` (${def.note})` : def.live ? "" : " (restart to apply)"}`);
    if (await confirm({ prompt: `Save ${def.label} to ~/.rtools/config.toml? [y/N]` })) {
      // null is a reset to the provider default: drop the key instead of
      // writing `null`, which stringifyTOML would save as "" and validation
      // would reject on the next launch.
      try {
        saveConfig(setSettingPatch(def.id, value === null ? undefined : value));
        console.log("saved");
      } catch (e) {
        console.log(`not saved: ${e.message}`);
      }
    }
  };
  const settingsUI = async () => {
    while (true) {
      const items = SETTING_DEFS.map((d) => ({
        label: `${d.label}: ${formatSettingValue(d, getSetting(ctx.cfg, d.id))}`,
        hint: d.desc,
        value: d.id,
      }));
      const id = await pick({ title: "Settings — type to filter, Enter to change, Esc to close", items });
      if (!id) return;
      const def = SETTING_DEFS.find((d) => d.id === id);
      const cur = getSetting(ctx.cfg, id);
      let value;
      if (def.kind === "enum") {
        const opts = def.values || providerIds();
        value = await pick({
          title: `${def.label} — Enter to pick, Esc to keep`,
          items: opts.map((v) => ({ label: v, hint: v === cur ? "current" : "", value: v })),
        });
        if (value == null || value === cur) continue;
      } else if (def.kind === "toggle") {
        value = !cur;
      } else {
        const text = await typeText({
          title: `${def.label} — ${def.desc}`,
          prompt: def.kind === "number" ? "value" : "model id",
          initial: cur == null ? "" : String(cur),
        });
        if (text == null) continue;
        const parsed = parseSettingInput(def, text);
        if (!parsed.ok) {
          console.log(`invalid ${def.label}: ${parsed.error}`);
          continue;
        }
        value = parsed.value;
      }
      await applySetting(def, value);
    }
  };
  const commandsUI = async () => {
    const sel = await pick({
      title: "Commands — Ctrl+P · type to filter · Enter to run",
      items: [
        { label: "Open settings", hint: "Ctrl+O", value: "__settings" },
        ...PALETTE_COMMANDS.map(([cmd, desc]) => ({ label: cmd, hint: desc, value: cmd })),
      ],
    });
    if (sel === "__settings") {
      await settingsUI();
      return null;
    }
    return sel;
  };
  let paletteBusy = false;
  const openPalette = async (kind) => {
    if (paletteBusy) return;
    if (!process.stdin.isTTY) {
      console.log("(the palette needs an interactive terminal)");
      return;
    }
    paletteBusy = true;
    suppressClose = true;
    rl.close();
    let feed = null;
    try {
      feed = kind === "settings" ? (await settingsUI(), null) : await commandsUI();
    } finally {
      makeRL();
      paletteBusy = false;
    }
    if (feed) lineQueue.push(feed);
  };
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (str, key) => {
      if (key?.ctrl && key.name === "c") {
        // interrupt the running agent/shell step, not the whole session
        if (currentAbort && !currentAbort.signal.aborted) {
          abortCurrentShell();
          console.log("\n(interrupting current step…)");
          return;
        }
        process.stdout.write("\n(press Ctrl+D or /quit to exit)\n\u203a ");
        return;
      }
      if (key?.ctrl && key.name === "l") {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(statusBarLine());
        return;
      }
      if (paletteBusy || !key) return;
      if (key.ctrl && key.name === "p") void openPalette("commands");
      else if (key.ctrl && key.name === "o") void openPalette("settings");
      else if (key.ctrl && key.name === "g") void (async () => {
        // compose a long prompt in $EDITOR, feed it as the next input
        const ed = process.env.EDITOR || process.env.VISUAL || "vi";
        const tmp = path.join(homedir(), ".rtools", `prompt-${Date.now()}.md`);
        mkdirSync(path.dirname(tmp), { recursive: true });
        writeFileSync(tmp, "");
        try {
          execFileSync("bash", ["-lc", `${ed} "${tmp}"`], { stdio: "inherit" });
          const text = readFileSync(tmp, "utf8").trim();
          if (text) lineQueue.push(text);
        } catch {
          // editor failed — ignore
        } finally {
          try { unlinkSync(tmp); } catch {}
        }
      })();
    });
  }
  // --- end palettes --------------------------------------------------------

  let lastCronTick = 0;
  while (true) {
    const nowMs = Date.now();
    if (nowMs - lastCronTick > 60000) {
      lastCronTick = nowMs;
      for (const task of dueCronTasks()) {
        console.log(`\n[cron] ${task.name}: running scheduled prompt`);
        try {
          await runTurn(task.prompt);
          await persist();
        } catch (e) {
          console.log(`[cron] ${task.name} failed: ${e.message}`);
        }
      }
    }
    let line;
    try {
      process.stdout.write("\n\u203a ");
      line = await nextLine();
    } catch {
      await persist();
      break;
    }
    if (line === null) {
      // Ctrl+D — persist and exit cleanly
      await persist();
      process.stdout.write("\n");
      break;
    }
    if (line === PALETTE_TICK) continue;
    const input = line.trim();
    if (!input) continue;
    if (input === "?" || input === "/") {
      console.log(HELP);
      continue;
    }

    // MCP prompt invocation: /server:prompt [args...] — before slash dispatch
    const mcpPromptMatch = input.match(/^\/([\w-]+):([\w-]+)(?:\s+(.*))?$/);
    if (mcpPromptMatch) {
      const [, serverName, promptName, argsStr] = mcpPromptMatch;
      const conn = ctx.mcpConnections.find((c) => c.name === serverName);
      if (!conn) {
        console.log(`no connected MCP server "${serverName}" (use /prompts to list available prompts)`);
        continue;
      }
      try {
        const args = {};
        for (const kv of (argsStr || "").match(/(\w+)="[^"]*"|\S+/g) || []) {
          const eq = kv.indexOf("=");
          if (eq > 0) args[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/^"|"$/g, "");
        }
        const { messages: promptMsgs } = await conn.request("prompts/get", { name: promptName, arguments: args });
        const text = (promptMsgs || []).map((m) => m.content?.text || "").join("\n");
        if (!text) {
          console.log(`prompt "${serverName}:${promptName}" returned nothing`);
          continue;
        }
        turnStart(`${serverName}:${promptName}`);
        messages.push({ role: "user", content: text });
        await runTurn(text);
        process.stdout.write("\n");
        console.log(statusBarLine());
        await persist();
      } catch (e) {
        console.log(`error: ${e.message}`);
      }
      continue;
    }

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.split(/\s+/);
      switch (cmd) {
        case "/help":
          console.log(HELP);
          continue;
        case "/quit":
        case "/exit":
          await persist();
          return;
        case "/init":
          cmdInit();
          continue;
        case "/review":
          await cmdReview(rest[0]);
          continue;
        case "/permissions":
          await cmdPermissions();
          continue;
        case "/plan":
          togglePlan();
          continue;
        case "/prompts":
        case "/prompts-list": {
          for (const conn of ctx.mcpConnections) {
            try {
              const { prompts } = await conn.request("prompts/list", {});
              for (const p of prompts || []) console.log(`/${conn.name}:${p.name} — ${p.description || "(MCP prompt)"}`);
            } catch {
              console.log(`(${conn.name}: server does not expose prompts)`);
            }
          }
          if (!ctx.mcpConnections.length) console.log("(no MCP servers connected)");
          continue;
        }
        case "/model": {
          const sub = rest[0];
          if (!sub) {
            console.log(`model: ${model} (provider: ${ctx.provider.id})`);
            console.log("(tip: /model list shows provider models; /model <name|alias> switches)");
            continue;
          }
          if (sub === "list") {
            const saved = Object.entries(ctx.cfg.models || {});
            if (saved.length) console.log(`saved aliases:\n  ${saved.map(([a, id]) => `${a} = ${id}`).join("\n  ")}`);
            try {
              const { listModels } = await import("./providers.js");
              const ids = await listModels({ provider: ctx.provider, apiKey: ctx.apiKey });
              console.log(ids.length ? `models from ${ctx.provider.id}:\n  ${ids.join("\n  ")}` : `(${ctx.provider.id} returned no models)`);
            } catch (e) {
              console.log(`could not list models from ${ctx.provider.id}: ${e.message}`);
            }
            continue;
          }
          if (sub === "add") {
            const [alias, id] = rest.slice(1);
            if (!alias || !id) {
              console.log("usage: /model add <alias> <model-id>");
              continue;
            }
            ctx.cfg.models = { ...(ctx.cfg.models || {}), [alias]: id };
            try {
              saveConfig({ models: { [alias]: id } });
              console.log(`saved ${alias} = ${id} to config.toml`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          if (sub === "rm") {
            const alias = rest[1];
            if (!alias || !(ctx.cfg.models || {})[alias]) {
              console.log(`no such alias "${alias || ""}" (use /model list)`);
              continue;
            }
            delete ctx.cfg.models[alias];
            try {
              saveConfig({ models: { [alias]: undefined } });
              console.log(`removed alias ${alias}`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          model = (ctx.cfg.models || {})[sub] || sub;
          try {
            saveConfig({ model });
            console.log(`model: ${model} (saved)`);
          } catch {
            console.log(`model: ${model}`);
          }
          continue;
        }
        case "/provider": {
          const sub = rest[0];
          if (!sub || sub === "list") {
            const custom = Object.keys(ctx.cfg.model_providers || {});
            console.log(`current provider: ${ctx.provider.id}`);
            console.log(`available: ${[...Object.keys(BUILTIN_PROVIDERS), ...custom].join(", ")}`);
            console.log("(tip: /provider add <id> <base_url> [env_key] [wire_api] adds a custom provider)");
            continue;
          }
          if (sub === "add") {
            const [id, baseUrl, envKey, wireApi] = rest.slice(1);
            if (!id || !baseUrl) {
              console.log("usage: /provider add <id> <base_url> [env_key] [wire_api=chat|responses|anthropic]");
              continue;
            }
            if (BUILTIN_PROVIDERS[id]) {
              console.log(`"${id}" is a built-in provider and cannot be replaced`);
              continue;
            }
            const wire = wireApi || "chat";
            if (!["chat", "responses", "anthropic"].includes(wire)) {
              console.log(`wire_api must be chat | responses | anthropic (got "${wire}")`);
              continue;
            }
            const entry = { name: id, base_url: baseUrl, env_key: envKey || null, wire_api: wire };
            ctx.cfg.model_providers = { ...(ctx.cfg.model_providers || {}), [id]: entry };
            try {
              saveConfig({ model_providers: { [id]: entry } });
              console.log(`provider ${id} saved to config.toml (base_url=${baseUrl}, wire_api=${wire})`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          if (sub === "rm") {
            const id = rest[1];
            if (!id) {
              console.log("usage: /provider rm <id>");
              continue;
            }
            if (BUILTIN_PROVIDERS[id]) {
              console.log(`"${id}" is built-in and cannot be removed`);
              continue;
            }
            if (!(ctx.cfg.model_providers || {})[id]) {
              console.log(`no such custom provider "${id}" (use /provider list)`);
              continue;
            }
            delete ctx.cfg.model_providers[id];
            try {
              saveConfig({ model_providers: { [id]: undefined } });
              console.log(`provider ${id} removed`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          try {
            const { resolveProvider, getApiKey } = await import("./config.js");
            const p = resolveProvider(ctx.cfg, sub);
            const key = getApiKey(p);
            ctx.provider = p;
            ctx.apiKey = key;
            try {
              saveConfig({ model_provider: p.id });
              console.log(`provider: ${p.id} (${p.wire_api}) (saved)`);
            } catch {
              console.log(`provider: ${p.id} (${p.wire_api})`);
            }
          } catch (e) {
            console.log(e.message);
          }
          continue;
        }
        case "/agent": {
          const profiles = () => ctx.cfg.profile || ctx.cfg.profiles || {};
          const sub = rest[0] || "list";
          if (sub === "list") {
            const entries = Object.entries(profiles());
            if (!entries.length) {
              console.log("(no agent profiles — /agent add <name> saves the current model/provider/effort/verbosity as one)");
              continue;
            }
            for (const [name, p] of entries) {
              console.log(`${name}: model=${p.model || "(keep)"} provider=${p.model_provider || "(keep)"} effort=${p.model_reasoning_effort || "(keep)"} verbosity=${p.model_verbosity || "(keep)"}`);
            }
            console.log("(tip: /agent use <name> applies a profile)");
            continue;
          }
          if (sub === "use") {
            const p = profiles()[rest[1]];
            if (!p) {
              console.log(`no such agent "${rest[1] || ""}" (use /agent list)`);
              continue;
            }
            if (p.model) model = p.model;
            if (p.model_reasoning_effort) effort = p.model_reasoning_effort;
            if (p.model_verbosity) verbosity = p.model_verbosity;
            if (p.model_provider && p.model_provider !== ctx.provider.id) {
              try {
                const { resolveProvider, getApiKey } = await import("./config.js");
                const prov = resolveProvider(ctx.cfg, p.model_provider);
                ctx.apiKey = getApiKey(prov);
                ctx.provider = prov;
              } catch (e) {
                console.log(`provider: ${e.message}`);
              }
            }
            console.log(`agent "${rest[1]}": model=${model} provider=${ctx.provider.id} effort=${effort} verbosity=${verbosity}`);
            continue;
          }
          if (sub === "add") {
            const name = rest[1];
            if (!name) {
              console.log("usage: /agent add <name>");
              continue;
            }
            const entry = { model, model_provider: ctx.provider.id, model_reasoning_effort: effort, model_verbosity: verbosity };
            ctx.cfg.profile = { ...(ctx.cfg.profile || {}), [name]: entry };
            try {
              saveConfig({ profile: { [name]: entry } });
              console.log(`agent "${name}" saved to config.toml (model=${entry.model}, provider=${entry.model_provider})`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          if (sub === "rm") {
            const name = rest[1];
            if (!name || !profiles()[name]) {
              console.log(`no such agent "${name || ""}" (use /agent list)`);
              continue;
            }
            delete (ctx.cfg.profile || (ctx.cfg.profile = {}))[name];
            try {
              saveConfig({ profile: { [name]: undefined } });
              console.log(`agent "${name}" removed`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
            continue;
          }
          console.log("usage: /agent list | use <name> | add <name> | rm <name>");
          continue;
        }
        case "/policy":
          if (["untrusted", "never", "always"].includes(rest[0])) {
            approval = rest[0];
            console.log(`approval policy: ${approval}`);
          } else console.log("usage: /policy untrusted|never|always");
          continue;
        case "/sandbox":
          if (SANDBOX_MODES.includes(rest[0])) {
            sandbox = rest[0];
            console.log(`sandbox mode: ${sandbox}`);
          } else console.log(`usage: /sandbox ${SANDBOX_MODES.join("|")}`);
          continue;
        case "/tools":
          for (const t of ctx.tools) console.log(`- ${t.name} [${t.kind}] ${t.description.slice(0, 90)}`);
          continue;
        case "/skills":
          console.log(ctx.skills.map((s) => `- ${s.name}`).join("\n") || "(no skills found)");
          continue;
        case "/status":
          console.log(`model: ${model}\nprovider: ${ctx.provider.id} (${ctx.provider.wire_api})`);
          console.log(`approval: ${approval}\nsandbox: ${sandbox}\neffort: ${effort}\nverbosity: ${verbosity}`);
          console.log(`messages: ${messages.length}\nskills: ${ctx.skills.length}, mcp servers: ${ctx.mcpConnections.length}, web_search: ${!!ctx.cfg.tools?.web_search}`);
          continue;
        case "/diff": {
          const changed = await changedFilesSince({ cwd: ctx.cwd });
          console.log(changed.join("\n") || "(no changes)");
          continue;
        }
        case "/usage":
          console.log(formatUsage(usageTracker, ctx.cfg.model_pricing));
          continue;
        case "/stats": {
          const days = Number(rest[0]);
          console.log(formatStats({ days: Number.isInteger(days) && days >= 0 ? days : 7 }));
          continue;
        }
        case "/smartroute": {
          if (rest[0] === "on" || rest[0] === "off") {
            ctx.cfg.smart_routing = { ...ctx.cfg.smart_routing, enabled: rest[0] === "on" };
            console.log(`smart routing ${rest[0]} (simple: ${ctx.cfg.smart_routing.simple || "(not set — use /smartroute simple <model>)"})`);
          } else if (rest[0] === "simple" && rest[1]) {
            ctx.cfg.smart_routing = { ...ctx.cfg.smart_routing, simple: rest.slice(1).join(" ") };
            console.log(`simple-tier model: ${ctx.cfg.smart_routing.simple}`);
          } else if (rest[0] === "strong" && rest[1]) {
            ctx.cfg.smart_routing = { ...ctx.cfg.smart_routing, strong: rest.slice(1).join(" ") };
            console.log(`strong-tier model: ${ctx.cfg.smart_routing.strong}`);
          } else {
            const r = ctx.cfg.smart_routing || {};
            console.log(`smart routing: ${r.enabled ? "on" : "off"}; simple: ${r.simple || "(unset)"}; strong: ${r.strong || "(unset; current model)"}`);
            console.log('usage: /smartroute on|off | simple <model> | strong <model>');
          }
          continue;
        }
        case "/todos": {
          const todos = tools._todos?.list?.() || [];
          console.log(todos.length ? todos.map((td) => `[${td.status === "in_progress" ? ">" : td.status === "completed" ? "x" : " "}] ${td.content}`).join("\n") : "(the agent has not written a todo list this session)");
          continue;
        }
        case "/goal": {
          if (!rest.length) {
            const g = loadGoal();
            console.log(g && g.state !== "none" ? `goal (${g.state}): ${g.text}\nstatus: ${g.status}` : "no active goal — set one: /goal <text>");
          } else if (rest[0] === "clear") {
            clearGoal();
            console.log("goal cleared");
          } else if (rest[0] === "done") {
            console.log(updateGoalStatus("done", "done") ? "goal marked done" : "no active goal");
          } else {
            const g = setGoal(rest.join(" "));
            console.log(`goal set (${g.state}): ${g.text}`);
          }
          continue;
        }
        case "/cron": {
          const [sub, name, ...cronRest] = rest;
          if (sub === "add" && name && cronRest.length >= 2) {
            try {
              const task = addCronTask({ name, cronExpr: cronRest[0], prompt: cronRest.slice(1).join(" ") });
              console.log(`cron task "${task.name}" added, next run ${task.next_at}`);
            } catch (e) {
              console.log(`error: ${e.message}`);
            }
          } else if (sub === "rm" && name) {
            console.log(removeCronTask(name) ? `removed "${name}"` : `no cron task "${name}"`);
          } else if (!sub || sub === "list") {
            const tasks = listCronTasks();
            console.log(tasks.map((task) => `${task.name}: ${task.cron} — next ${task.next_at} — ${task.prompt.slice(0, 60)}`).join("\n") || "(no cron tasks)");
          } else {
            console.log("usage: /cron add <name> <cron expr> <prompt> | rm <name> | list");
          }
          continue;
        }
        case "/share": {
          const file = path.join(ctx.cwd, rest[0] || `session-${Date.now()}.md`);
          writeFileSync(file, sessionToMarkdown({ id: session?.id, model, provider: ctx.provider?.name, messages }));
          console.log(`session written to ${file}`);
          continue;
        }
        case "/summary": {
          const file = path.join(ctx.cwd, rest[0] || `summary-${Date.now()}.md`);
          writeFileSync(file, summaryToMarkdown(summarizeTranscript(messages), { id: session?.id }));
          console.log(`summary written to ${file}`);
          continue;
        }
        case "/wiki": {
          const outDir = path.join(ctx.cwd, rest[0] || "wiki");
          mkdirSync(outDir, { recursive: true });
          for (const p of buildWiki(ctx.cwd).pages) writeFileSync(path.join(outDir, p.file), p.markdown);
          console.log(`wiki written to ${outDir}/ (${buildWiki(ctx.cwd).pages.length} pages)`);
          continue;
        }
        case "/worktree": {
          const [sub, name] = rest;
          try {
            if (sub === "enter" && name) {
              const r = enterWorktree(ctx.cwd, name);
              ctx.cwd = r.dir;
              console.log(`${r.created ? "created" : "reused"} worktree ${r.dir}`);
            } else if (sub === "exit" && name) {
              console.log(exitWorktree(ctx.cwd, name) ? `worktree ${name} removed` : `no worktree ${name}`);
            } else if (sub === "list" || !sub) {
              console.log(listWorktrees(ctx.cwd).join("\n") || "(only the main worktree)");
            } else {
              console.log("usage: /worktree enter <name> | exit <name> | list");
            }
          } catch (e) {
            console.log(`error: ${e.message}`);
          }
          continue;
        }
        case "/remote": {
          const [sub, target] = rest;
          if (sub === "use" && target) {
            if (remoteAlive(target)) {
              ctx.remoteTarget = target;
              const { builtinTools } = await import("./tools.js");
              builtinTools._remoteTarget = target;
              console.log(`remote session active: ${target} (shell tools now run over ssh)`);
            } else {
              console.log(`error: cannot reach ${target} (needs key-based ssh access)`);
            }
          } else if (sub === "exit") {
            ctx.remoteTarget = null;
            const { builtinTools } = await import("./tools.js");
            builtinTools._remoteTarget = null;
            console.log("back to local execution");
          } else {
            console.log(`remote: ${ctx.remoteTarget || "(local)"} — usage: /remote use <user@host> | exit`);
          }
          continue;
        }
        case "/language": {
          try {
            setLanguage(rest[0] || "en");
            console.log(`language: ${rest[0] || "en"}`);
          } catch (e) {
            console.log(`error: ${e.message}`);
          }
          continue;
        }
        case "/vim": {
          ctx.cfg.vim_mode = !ctx.cfg.vim_mode;
          console.log(`vim mode ${ctx.cfg.vim_mode ? "on (esc=normal, i=insert)" : "off"}`);
          continue;
        }
        case "/files": {
          const r = await fileBrowser({ startDir: ctx.cwd });
          if (r?.action === "preview") {
            console.log(`\n${r.path}\n${"-".repeat(60)}\n${r.text}`);
          } else if (r?.action === "insert") {
            input = `${input ? input + " " : ""}@${r.path}`;
            console.log(`attached: @${r.path} — press Enter to send`);
            continue;
          } else if (r?.action === "error") {
            console.log(`error: ${r.error}`);
          }
          continue;
        }
        case "/terminal": {
          const r = await terminalPanel({ cwd: ctx.cwd });
          if (r) {
            console.log(`$ ${r.command}`);
            console.log(r.output);
          }
          continue;
        }
        case "/agents": {
          const ev = await subagentsPanel();
          if (ev) {
            console.log(`\n${ev.name} (${ev.state}) — task: ${ev.task}`);
            console.log(`steps: ${ev.steps} · tools: ${ev.toolsUsed.join(", ") || "none"}`);
            if (ev.text) console.log(`last output: ${ev.text.slice(-600)}`);
            if (ev.error) console.log(`error: ${ev.error}`);
          }
          continue;
        }
        case "/mcp": {
          await mcpPanel({ cfgMcp: ctx.cfg.mcp_servers || {}, connections: ctx.mcpConnections || [] });
          continue;
        }
        case "/plugin": {
          if (rest[0] === "list") {
            await pluginsPanel({ skillsDirs: ctx.cfg.skills_dirs || [] });
            continue;
          }
          console.log("usage: /plugin list — install/remove with: rt plugin install|remove <name>");
          continue;
        }
        case "/jobs": {
          const [sub, name, ...cmdRest] = rest;
          if (sub === "start" && name && cmdRest.length) {
            const r = startJob({ name, command: cmdRest.join(" "), cwd: ctx.cwd });
            console.log(r.ok ? `job "${r.job.name}" started (${r.job.status})` : `error: ${r.error}`);
          } else if (sub === "logs" && name) {
            const out = jobLogs(name, Number(cmdRest[0]) || 40);
            console.log(out === null ? `no such job "${name}"` : out.join("\n") || "(no output yet)");
          } else if (sub === "stop" && name) {
            const r = stopJob(name);
            console.log(r.ok ? `stopped "${name}"` : `error: ${r.error}`);
          } else if (!sub || sub === "status") {
            const list = jobStatus();
            console.log(list.map((j) => `${j.name}: ${j.status}${j.code != null ? ` (code ${j.code})` : ""} — ${j.command}`).join("\n") || "(no jobs)");
          } else {
            console.log("usage: /jobs start <name> <cmd> | status [name] | logs <name> [lines] | stop <name>");
          }
          continue;
        }
        case "/undo": {
          const r = undoLast({ cwd: ctx.cwd });
          console.log(r ? `restored ${r.file} (checkpoint ${r.id})` : "nothing to undo");
          continue;
        }
        case "/checkpoints": {
          const list = listCheckpoints().filter((c) => c.cwd === path.resolve(ctx.cwd));
          console.log(list.map((c) => `${c.id}  ${c.at}  ${c.abs}`).join("\n") || "(no checkpoints in this project)");
          continue;
        }
        case "/trace": {
          const arg = (rest[0] || "").toLowerCase();
          if (arg === "on" || arg === "off") trace.enabled = arg === "on";
          console.log(`trace ${trace.enabled ? "on" : "off"} — ${trace.file}`);
          continue;
        }
        case "/copy": {
          const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
          if (!last) {
            console.log("no assistant answer yet");
          } else {
            const err = copyToClipboard(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
            console.log(err ? `copy failed: ${err}` : "copied to clipboard");
          }
          continue;
        }
        case "/find": {
          const q = rest.join(" ").toLowerCase();
          if (!q) {
            console.log("usage: /find <text>");
          } else {
            const hits = [];
            messages.forEach((m, i) => {
              const t = typeof m.content === "string" ? m.content : "";
              if (t.toLowerCase().includes(q)) hits.push(`[${i}] ${m.role}: ${t.split("\n").find((l) => l.toLowerCase().includes(q)).slice(0, 160)}`);
            });
            console.log(hits.slice(-20).join("\n") || "no matches");
          }
          continue;
        }
        case "/paste": {
          console.log("paste lines, finish with a single \".\"");
          const buf = [];
          for (;;) {
            const l = await nextLine("");
            if (l === null || l.trim() === ".") break;
            buf.push(l);
          }
          if (buf.length) {
            turnStart("paste");
            messages.push({ role: "user", content: buf.join("\n") });
            await runTurn(buf.join("\n"));
            process.stdout.write("\n");
            console.log(statusBarLine());
            await persist();
          }
          continue;
        }
        case "/edit": {
          const ed = process.env.EDITOR || process.env.VISUAL || "vi";
          const tmp = path.join(homedir(), ".rtools", `prompt-${Date.now()}.md`);
          mkdirSync(path.dirname(tmp), { recursive: true });
          writeFileSync(tmp, "");
          try {
            execFileSync("bash", ["-lc", `${ed} "${tmp}"`], { stdio: "inherit" });
            const text = readFileSync(tmp, "utf8").trim();
            if (text) {
              turnStart("editor");
              messages.push({ role: "user", content: text });
              await runTurn(text);
              process.stdout.write("\n");
              console.log(statusBarLine());
              await persist();
            } else console.log("(empty — cancelled)");
          } finally {
            try { unlinkSync(tmp); } catch {}
          }
          continue;
        }
        case "/compact": {
          const next = compactMessages(messages);
          if (!next) console.log("conversation is already small");
          else {
            messages = next;
            console.log(`compacted: ${messages.length} messages now`);
          }
          continue;
        }
        case "/resume": {
          try {
            const all = await listSessions();
            if (!rest[0]) {
              console.log(all.map((s) => `${s.id.slice(0, 8)}  ${s.saved_at}  ${s.preview}`).join("\n") || "(no saved sessions)");
              console.log("(tip: /resume last opens the most recent session)");
              continue;
            }
            const match = rest[0] === "last" ? all[0] : all.find((s) => s.id.startsWith(rest[0]));
            if (!match) {
              console.log("no such session");
              continue;
            }
            const s = await loadSession(match.id);
            messages = s.messages;
            model = s.model;
            console.log(`resumed session ${match.id.slice(0, 8)} (${messages.length} messages)`);
          } catch (e) {
            console.log(`error: ${e.message}`);
          }
          continue;
        }
        case "/export": {
          try {
            const { exportSession } = await import("./session.js");
            const file = await exportSession({ id: sessionId, messages, model, provider: ctx.provider.id, outPath: rest[0] });
            console.log(`exported to ${file}`);
          } catch (e) {
            console.log(`error: ${e.message}`);
          }
          continue;
        }
        case "/settings":
          console.log(JSON.stringify({ ...ctx.cfg, model_providers: Object.keys(ctx.cfg.model_providers || {}), mcp_servers: Object.keys(ctx.cfg.mcp_servers || {}) }, null, 2));
          continue;
        case "/palette":
          await openPalette("commands");
          continue;
        case "/effort":
          if (["low", "medium", "high"].includes(rest[0])) {
            effort = rest[0];
            try {
              saveConfig({ model_reasoning_effort: effort });
              console.log(`reasoning effort: ${effort} (saved)`);
            } catch {
              console.log(`reasoning effort: ${effort}`);
            }
          } else console.log("usage: /effort low|medium|high");
          continue;
        case "/verbosity":
          if (["low", "medium", "high"].includes(rest[0])) {
            verbosity = rest[0];
            console.log(`verbosity: ${verbosity}`);
          } else console.log("usage: /verbosity low|medium|high");
          continue;
        case "/clear":
          newSession();
          console.log("new conversation started");
          continue;
        default:
          console.log(`unknown command ${cmd}`);
          continue;
      }
    }

    // @path references: inline the file contents into the prompt (max 3 files)
    let prompt = input;
    const atRefs = [...input.matchAll(/@([\w./\\-]+)/g)].map((m) => m[1]).slice(0, 3);
    for (const ref of atRefs) {
      try {
        const abs = path.resolve(ctx.cwd, ref);
        if (existsSync(abs) && statSync(abs).isFile()) {
          const body = readFileSync(abs, "utf8").slice(0, 20000);
          prompt = prompt.split(`@${ref}`).join(`\n--- file: ${ref} ---\n${body}\n--- end of ${ref} ---\n`);
        }
      } catch {
        // unreadable ref — leave the token as is
      }
    }
    turnStart(input);
    const compacted = autoCompact();
    if (compacted !== null) {
      console.log(`auto-compacted context: ~${compacted} tokens was near the ${contextWindow}-token window`);
      console.log(statusBarLine());
    }
    messages.push({ role: "user", content: prompt });
    appendHistory(input);
    notifyEvent({ type: "agent-turn-start", input });
    try {
      await runTurn(input);
      process.stdout.write("\n");
      console.log(statusBarLine());
      notifyEvent({ type: "agent-turn-end", "last-assistant-message": "complete" });
      await persist();
    } catch (e) {
      console.error(`\nerror: ${e.message}`);
    }
  }
}
