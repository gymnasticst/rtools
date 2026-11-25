import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import { runAgentLoop, systemPrompt, needsApproval } from "./agent.js";
import { saveSession, listSessions, loadSession, compactMessages, estimateTokens } from "./session.js";
import { changedFilesSince } from "./apply-patch.js";
import { SANDBOX_MODES } from "./sandbox.js";
import { banner, statusBar, Spinner, toolNotice, turnStart } from "./tui.js";

const HELP = `Commands:
  /help            show this help
  /init            create an AGENTS.md file with instructions for RTools
  /review [target] review changes (uncommitted | <commit> | <base-branch>) and find issues
  /permissions     show/choose what RTools is allowed to do (approval + sandbox)
  /plan            toggle plan mode (read-only: effectful tools require approval)
  /model <name>    switch model
  /provider <id>   switch model provider (defined in config.toml)
  /policy <mode>   approval policy: untrusted | never | always
  /sandbox <mode>  sandbox mode: read-only | workspace | danger
  /tools           list available tools (built-in + MCP plugins)
  /skills          list available skills
  /status          show current settings
  /diff            show changed files (git status)
  /compact         summarize and shrink the conversation
  /resume [id|last] resume a saved session (lists sessions if no id; "last" = newest)
  /settings        show every setting (Codex-style config)
  /effort <level>  reasoning effort: low | medium | high
  /verbosity <v>   answer verbosity: low | medium | high
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
    "/clear", "/quit",
  ];
  const completer = (line) => {
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  // readline/promises drops lines that arrive while no question is pending
  // (e.g. all piped input at once), so keep our own queue.
  const lineQueue = [];
  const lineWaiters = [];
  rl.on("line", (l) => {
    const w = lineWaiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on("close", () => {
    while (lineWaiters.length) lineWaiters.shift()(null);
  });
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
  const settings = () => ({ effort, verbosity, temperature, top_p, max_output_tokens });

  const contextWindow = Number(ctx.cfg.context_window) || 128000;
  const statusBarLine = () => {
    const used = estimateTokens(messages);
    return statusBar({ model, effort, tokensLeft: Math.max(0, Math.round((1 - used / contextWindow) * 100)), tokensUsed: used });
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
  const togglePlan = () => {
    planMode = !planMode;
    planModeToggled = true;
    console.log(planMode ? "plan mode: ON — RTools will read and plan but not change anything (writes/shell ask approval)" : "plan mode: OFF");
  };

  const askApproval = async (tool) => {
    process.stdout.write(`Allow ${tool.kind} tool "${tool.name}"? [y/n/a] `);
    const answer = await nextLine("");
    if (answer.trim().toLowerCase() === "a") {
      approval = "never";
      return true;
    }
    return answer.trim().toLowerCase() === "y";
  };

  const newSession = () => {
    messages = [{ role: "system", content: systemPrompt(ctx) }];
  };
  newSession();

  const persist = () =>
    saveSession({ id: sessionId, model, provider: ctx.provider.id, messages, cwd: ctx.cwd }).catch(() => {});

  const runTurn = async (input) => {
    const spinner = new Spinner("working").start();
    const sawText = { any: false };
    try {
      await runAgentLoop({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model,
        messages,
        tools: ctx.tools,
        approval,
        sandbox,
        maxSteps: ctx.cfg.max_agent_steps || 40,
        settings: settings(),
        planMode,
        onText: (d) => {
          if (!sawText.any) {
            spinner.stop();
            sawText.any = true;
          }
          process.stdout.write(d);
        },
        onToolResult: (tool, result) => {
          if (sawText.any || process.env.RTOOLS_QUIET) return;
          toolNotice(tool.name, String(result).split("\n")[0]);
        },
        askApproval: async (tool, call) => {
          spinner.stop();
          const ok = await askApproval(tool);
          if (!sawText.any) spinner.start();
          return ok;
        },
      });
    } finally {
      spinner.stop();
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

  while (true) {
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
        case "/model":
          if (rest[0]) model = rest[0];
          console.log(`model: ${model}`);
          continue;
        case "/provider": {
          if (!rest[0]) {
            console.log(`current provider: ${ctx.provider.id}`);
            continue;
          }
          const { resolveProvider, getApiKey } = await import("./config.js");
          try {
            const p = resolveProvider(ctx.cfg, rest[0]);
            const key = getApiKey(p);
            ctx.provider = p;
            ctx.apiKey = key;
            console.log(`provider: ${p.id} (${p.wire_api})`);
          } catch (e) {
            console.log(e.message);
          }
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
        case "/settings":
          console.log(JSON.stringify({ ...ctx.cfg, model_providers: Object.keys(ctx.cfg.model_providers || {}), mcp_servers: Object.keys(ctx.cfg.mcp_servers || {}) }, null, 2));
          continue;
        case "/effort":
          if (["low", "medium", "high"].includes(rest[0])) {
            effort = rest[0];
            console.log(`reasoning effort: ${effort}`);
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

    turnStart(input);
    messages.push({ role: "user", content: input });
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
