#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { runAgentLoop, systemPrompt, buildContext, needsApproval } from "../src/agent.js";
import { startREPL } from "../src/repl.js";
import { selfUpdate, selfUninstall } from "../src/update.js";
import { marketplaceList, marketplaceInfo, pluginInstall, pluginRemove, pluginInstalledNames, listMarketplaces, addMarketplace, removeMarketplace, listSkills, skillInstall, skillRemove } from "../src/marketplace.js";
import { DEFAULT_SKILLS_DIRS } from "../src/config.js";

const USAGE = `RTools — CLI coding agent

Usage:
  rt [chat] [options]                interactive session (Codex-style)
  rt exec "<prompt>" [options]       one-shot non-interactive run
  rt plugin list|search <q>          browse the plugin marketplace (MCP + skills)
  rt plugin install <name>           enable a plugin
  rt plugin remove <name>            disable a plugin
  rt plugin info <name>              plugin details
  rtools skill list|show <name>      manage skills (installed ones load into the agent)
  rtools skill install <src>         install a skill: owner/repo, git URL or marketplace plugin
  rtools skill remove <name>         remove a skill
  rtools uninstall [--with-data]     remove RTools (data = ~/.rtools sessions/config)
  rtools --help | --version

Options:
  -m, --model <name>        model name (default from config)
  -p, --provider <id>       model provider id (built-in: openai, anthropic;
                            custom ones come from config.toml)
  -c, --config <path>       path to config.toml
      --approval <mode>     untrusted | never | always
      --sandbox <mode>      read-only | workspace | danger (default: workspace)
      --profile <name>      config profile from [profile.<name>]
      --effort <level>      reasoning effort: low | medium | high
      --verbosity <level>   answer verbosity: low | medium | high
      --add-dir <dir>       additional writable directory (repeatable)
      --update              update RTools to the latest release
  -w, --workdir <dir>       working directory for tools (default: cwd)

Config: ~/.rtools/config.toml merged with ./.rtools/config.toml

Custom provider example:

  [model_providers.myprovider]
  name = "My Provider"
  base_url = "https://my-endpoint.example.com/v1"
  env_key = "MY_API_KEY"
  wire_api = "chat"        # chat | responses | anthropic

MCP plugin example:

  [mcp_servers.filesystem]
  command = "npx"
  args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`;

import { readFileSync as readFileSyncRaw, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

function readImageFile(file) {
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  const media_type = types[file.slice(file.lastIndexOf(".")).toLowerCase()];
  if (!media_type) throw new Error(`unsupported image type: ${file} (png/jpg/gif/webp)`);
  return { path: file, media_type, data: readFileSyncRaw(file).toString("base64") };
}

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (key) => (opts[key] = argv[++i]);
    if (a === "-m" || a === "--model") take("model");
    else if (a === "-p" || a === "--provider") take("provider");
    else if (a === "-c" || a === "--config") take("configPath");
    else if (a === "--approval") take("approval");
    else if (a === "--sandbox") take("sandbox");
    else if (a === "--profile") take("profile");
    else if (a === "--effort") take("effort");
    else if (a === "--verbosity") take("verbosity");
    else if (a === "-w" || a === "--workdir") take("cwd");
    else if (a === "-i" || a === "--image") (opts.images ||= []).push(readImageFile(argv[++i]));
    else if (a === "--add-dir") (opts.addDirs ||= []).push(argv[++i]);
    else if (a === "--update") opts.update = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--with-data") opts.withData = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version") opts.version = true;
    // a mistyped flag (--sanbox) must be a usage error, not prompt text or a
    // command name; --ref is a plugin-marketplace flag consumed by pluginCommand
    else if (a.startsWith("-") && a !== "--ref") throw new Error(`unknown option: ${a} (see rtools --help)`);
    else opts._.push(a);
  }
  return opts;
}

async function skillCommand(args) {
  const [sub, ...rest] = args;
  const load = async () => {
    const { discoverSkills } = await import("../src/skills.js");
    return discoverSkills(DEFAULT_SKILLS_DIRS());
  };
  switch (sub) {
    case "list":
    case undefined: {
      const installed = await load();
      console.log(installed.map((s) => `${s.name.padEnd(28)} ${s.description}`).join("\n") || "(no skills installed)");
      console.error(`\ndirs: ${DEFAULT_SKILLS_DIRS().join(", ")}`);
      return;
    }
    case "install":
      if (!rest[0]) throw new Error("usage: rtools skill install <owner/repo | git-url | marketplace-plugin-name>");
      console.log(await skillInstall(rest[0]));
      return;
    case "remove":
      if (!rest[0]) throw new Error("usage: rtools skill remove <name>");
      console.log(skillRemove(rest[0]));
      return;
    case "show": {
      const all = await load();
      const s = all.find((x) => x.name === rest[0]);
      if (!s) throw new Error(`skill "${rest[0]}" not installed`);
      console.log(s.body);
      return;
    }
    default:
      throw new Error("usage: rtools skill list|install <src>|remove <name>|show <name>");
  }
}

async function pluginCommand(args) {
  const [sub, ...rest] = args;
  if (sub === "marketplace") {
    const [action, src, ...flags] = rest;
    if (action === "add") {
      if (!src) throw new Error("usage: rtools plugin marketplace add owner/repo [--ref main]");
      const refIdx = flags.indexOf("--ref");
      const ref = refIdx >= 0 ? flags[refIdx + 1] : "main";
      const entry = addMarketplace(src, { ref });
      console.log(`marketplace "${entry.name}" added (${entry.repo}@${entry.ref})`);
      return;
    }
    if (action === "remove") {
      if (!src) throw new Error("usage: rtools plugin marketplace remove <name>");
      console.log(removeMarketplace(src));
      return;
    }
    if (action === "list" || !action) {
      for (const m of listMarketplaces()) console.log(`${m.name}  ${m.repo}@${m.ref}`);
      return;
    }
    throw new Error("usage: rtools plugin marketplace add|remove|list");
  }
  switch (sub) {
    case "list":
    case "search": {
      const plugins = await marketplaceList(rest.join(" "));
      const installed = pluginInstalledNames();
      for (const p of plugins) {
        const mark = installed.plugins.includes(p.name) ? "[installed]" : "";
        console.log(`${p.name.padEnd(24)} ${p.marketplace.padEnd(16)} ${mark} ${p.description}`);
      }
      return;
    }
    case "install":
      if (!rest[0]) throw new Error("usage: rtools plugin install <name>");
      console.log(await pluginInstall(rest[0]));
      return;
    case "remove":
      if (!rest[0]) throw new Error("usage: rtools plugin remove <name>");
      console.log(pluginRemove(rest[0]));
      return;
    case "info": {
      const p = rest[0] && (await marketplaceInfo(rest[0]));
      if (!p) throw new Error("plugin not found");
      console.log(JSON.stringify(p, null, 2));
      return;
    }
    default:
      console.log("usage: rtools plugin list|search <q>|install <name>|remove <name>|info <name>|marketplace add|remove|list");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) {
    console.log(`rtools ${require("../package.json").version}`);
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.update) {
    selfUpdate();
    return;
  }
  if (opts.uninstall || opts._[0] === "uninstall") {
    selfUninstall({ withData: opts.withData });
    return;
  }
  if (opts._[0] === "plugin") {
    await pluginCommand(opts._.slice(1));
    return;
  }
  if (opts._[0] === "skill") {
    await skillCommand(opts._.slice(1));
    return;
  }
  const command = opts._[0] && ["chat", "exec"].includes(opts._[0]) ? opts._[0] : "chat";
  if (opts._[0] && ["chat", "exec"].includes(opts._[0])) opts._.shift();
  const prompt = opts._.join(" ");

  const ctx = await buildContext(opts);
  process.on("exit", () => ctx.mcpConnections.forEach((c) => c.stop()));

  // --add-dir: extra writable directories for the session
  if (opts.addDirs?.length) {
    process.env.RTOOLS_EXTRA_DIRS = opts.addDirs.join(path.delimiter);
  }

  if (command === "exec") {
    if (!prompt) {
      console.error('usage: rtools exec "<prompt>"');
      process.exit(2);
    }
    const messages = [
      { role: "system", content: systemPrompt(ctx) },
      { role: "user", content: prompt, ...(opts.images?.length ? { images: opts.images } : {}) },
    ];
    await runAgentLoop({
      provider: ctx.provider,
      apiKey: ctx.apiKey,
      model: ctx.cfg.model,
      messages,
      tools: ctx.tools,
      approval: ctx.cfg.approval_policy,
      askApproval: async (tool) => {
        if (!process.stdin.isTTY) return false;
        process.stdout.write(`Allow ${tool.kind} tool "${tool.name}"? [y/n] `);
        const answer = await new Promise((resolve) => {
          const onData = (buf) => {
            process.stdin.removeListener("data", onData);
            process.stdin.pause();
            resolve(buf.toString().trim().toLowerCase());
          };
          process.stdin.resume();
          process.stdin.once("data", onData);
        });
        return answer === "y" || answer === "yes";
      },
      sandbox: ctx.cfg.sandbox_mode,
      maxSteps: ctx.cfg.max_agent_steps || 40,
      settings: {
        effort: ctx.cfg.model_reasoning_effort,
        verbosity: ctx.cfg.model_verbosity,
        temperature: ctx.cfg.temperature,
        top_p: ctx.cfg.top_p,
        max_output_tokens: ctx.cfg.max_output_tokens,
      },
      onText: (d) => process.stdout.write(d),
    });
    console.log();
    return;
  }

  await startREPL(ctx);
}

// run only when invoked as the CLI (not when imported for parseArgs tests)
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
