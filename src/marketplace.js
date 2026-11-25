// Plugin marketplace wired to the REAL Codex plugin marketplace:
//   github.com/openai/plugins — .agents/plugins/marketplace.json catalog,
//   each plugin a directory with .codex-plugin/plugin.json and optional
//   .mcp.json (MCP servers) and skills/ (Codex skills).
// Supports additional marketplaces via `rtools plugin marketplace add owner/repo`.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseTOML } from "./toml.js";

const DEFAULT_MARKETPLACE = { name: "openai/plugins", repo: "https://github.com/openai/plugins", ref: "main", catalog: ".agents/plugins/marketplace.json" };
const RTOOLS_HOME = () => path.join(os.homedir(), ".rtools");
const MARKETPLACES_FILE = () => path.join(RTOOLS_HOME(), "marketplaces.json");
const CACHE_DIR = () => path.join(RTOOLS_HOME(), "marketplace-cache");
const PLUGINS_TOML = () => path.join(RTOOLS_HOME(), "plugins.toml");
const SKILLS_DIR = () => path.join(RTOOLS_HOME(), "skills");
const INSTALLED_DIR = () => path.join(RTOOLS_HOME(), "installed-plugins");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function listMarketplaces() {
  let extra = [];
  if (existsSync(MARKETPLACES_FILE())) {
    try {
      extra = readJson(MARKETPLACES_FILE());
    } catch {
      extra = [];
    }
  }
  return [DEFAULT_MARKETPLACE, ...extra];
}

// `rtools plugin marketplace add owner/repo [--ref main]`
export function addMarketplace(source, { ref = "main" } = {}) {
  const repo = source.startsWith("http") || source.startsWith("git@") || source.endsWith(".git")
    ? source
    : `https://github.com/${source}`;
  const list = existsSync(MARKETPLACES_FILE()) ? readJson(MARKETPLACES_FILE()) : [];
  const entry = { name: source, repo, ref, catalog: ".agents/plugins/marketplace.json" };
  if (!list.some((m) => m.repo === repo)) list.push(entry);
  mkdirSync(RTOOLS_HOME(), { recursive: true });
  writeFileSync(MARKETPLACES_FILE(), JSON.stringify(list, null, 2));
  return entry;
}

export function removeMarketplace(name) {
  const list = existsSync(MARKETPLACES_FILE()) ? readJson(MARKETPLACES_FILE()) : [];
  const kept = list.filter((m) => m.name !== name && m.repo !== name);
  writeFileSync(MARKETPLACES_FILE(), JSON.stringify(kept, null, 2));
  return kept.length !== list.length ? `marketplace "${name}" removed` : `marketplace "${name}" not found`;
}

function cloneRepo({ repo, ref }, dest, sparsePaths) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  if (sparsePaths?.length) {
    execSync(`git clone --depth 1 --filter=blob:none --no-checkout --branch ${ref} ${repo} ${dest}`, { stdio: "pipe" });
    execSync(`git -C ${dest} sparse-checkout set ${sparsePaths.join(" ")}`, { stdio: "pipe" });
    execSync(`git -C ${dest} checkout`, { stdio: "pipe" });
  } else {
    execSync(`git clone --depth 1 --branch ${ref} ${repo} ${dest}`, { stdio: "pipe" });
  }
}

async function loadCatalog(marketplace) {
  const dest = path.join(CACHE_DIR(), marketplace.name.replace(/[^A-Za-z0-9_-]/g, "_"));
  if (!existsSync(dest)) cloneRepo(marketplace, dest);
  const catalogPath = path.join(dest, marketplace.catalog);
  if (!existsSync(catalogPath)) throw new Error(`marketplace catalog not found: ${catalogPath}`);
  const catalog = readJson(catalogPath);
  return { marketplace, root: dest, catalog };
}

export async function marketplaceList(query) {
  const out = [];
  for (const m of listMarketplaces()) {
    try {
      const { catalog } = await loadCatalog(m);
      for (const entry of catalog.plugins || []) {
        const p = {
          name: entry.name,
          marketplace: catalog.name,
          category: entry.category || "",
          source: entry.source || {},
        };
        // enrich from the plugin manifest when cheap to do so
        const manifestPath = entry.source?.path
          ? path.join(CACHE_DIR(), m.name.replace(/[^A-Za-z0-9_-]/g, "_"), entry.source.path, ".codex-plugin", "plugin.json")
          : null;
        if (manifestPath && existsSync(manifestPath)) {
          try {
            const manifest = readJson(manifestPath);
            p.description = (manifest.description || manifest.interface?.shortDescription || "").slice(0, 110);
            p.version = manifest.version || "";
          } catch {
            // catalog entry without manifest details
          }
        }
        p.description ||= "(Codex plugin)";
        if (!query || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(query.toLowerCase())) out.push(p);
      }
    } catch (e) {
      console.error(`warning: marketplace "${m.name}" unavailable: ${e.message}`);
    }
  }
  return out;
}

export async function marketplaceInfo(name) {
  return (await marketplaceList()).find((p) => p.name === name) || null;
}

export function readInstalled() {
  const file = PLUGINS_TOML();
  if (!existsSync(file)) return {};
  return parseTOML(readFileSync(file, "utf8")).mcp_servers || {};
}

export async function pluginInstall(name) {
  const plugin = await marketplaceInfo(name);
  if (!plugin) throw new Error(`plugin "${name}" not found in the connected marketplaces (try: rtools plugin search)`);
  const m = listMarketplaces().find((x) => x.name === plugin.marketplace) || DEFAULT_MARKETPLACE;
  const cacheRoot = path.join(CACHE_DIR(), m.name.replace(/[^A-Za-z0-9_-]/g, "_"));
  const src = plugin.source?.path
    ? path.join(cacheRoot, plugin.source.path.replace(/^\.\//, ""))
    : null;
  if (!src || !existsSync(src)) throw new Error(`plugin directory missing in marketplace cache: ${src}`);

  const safeName = plugin.name.replace(/[^A-Za-z0-9_-]/g, "_");
  const dest = path.join(INSTALLED_DIR(), safeName);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });

  const installed = readInstalled();
  // MCP servers from .mcp.json (real Codex plugin surface)
  const mcpFile = path.join(dest, ".mcp.json");
  let note = "";
  if (existsSync(mcpFile)) {
    const { mcpServers } = readJson(mcpFile);
    for (const [serverName, spec] of Object.entries(mcpServers || {})) {
      if (spec.type === "http" && spec.url) {
        const proxy = fileURLToPath(new URL("../bin/rtools-mcp-proxy.js", import.meta.url));
        installed[`${safeName}_${serverName}`] = { command: "node", args: [proxy, "http", spec.url] };
        note += `\nMCP server "${serverName}" (http: ${spec.url}) bridged to stdio`;
      } else if (spec.command) {
        installed[`${safeName}_${serverName}`] = { command: spec.command, args: spec.args || [], env: spec.env || {} };
        note += `\nMCP server "${serverName}" (${spec.command}) registered`;
      }
    }
  }
  writeInstalled(installed);
  const skillsSrc = path.join(dest, "skills");
  if (existsSync(skillsSrc)) {
    const overwrite = ["1", "true", "yes"].includes(String(process.env.RTOOLS_OVERWRITE_SKILLS || "").toLowerCase());
    for (const skill of readdirSync(skillsSrc, { withFileTypes: true })) {
      if (skill.isDirectory()) {
        const target = path.join(SKILLS_DIR(), skill.name);
        if (existsSync(target)) {
          if (!overwrite) {
            note += `\nskill "${skill.name}" already installed, skipped (set RTOOLS_OVERWRITE_SKILLS=1 to overwrite)`;
            continue;
          }
          rmSync(target, { recursive: true, force: true });
        }
        cpSync(path.join(skillsSrc, skill.name), target, { recursive: true });
        note += `\nskill "${skill.name}" installed`;
      }
    }
  }
  return `plugin "${safeName}" v${plugin.version || "?"} installed to ${dest}${note || "\n(no MCP servers or skills in this plugin)"}`;
}

function tomlString(value) {
  return `"${String(value).replace(/[\\"\n\r\t]/g, (ch) => `\\${{ "\\": "\\", '"': '"', "\n": "n", "\r": "r", "\t": "t" }[ch]}`)}"`;
}

function writeInstalled(servers) {
  const lines = [];
  for (const [name, spec] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(spec.command)}`);
    if (spec.args?.length) lines.push(`args = [${spec.args.map((a) => tomlString(a)).join(", ")}]`);
    if (spec.env && Object.keys(spec.env).length) {
      lines.push(`env = { ${Object.entries(spec.env).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`).join(", ")} }`);
    }
    lines.push("");
  }
  mkdirSync(RTOOLS_HOME(), { recursive: true });
  writeFileSync(PLUGINS_TOML(), lines.join("\n"));
}

export function pluginRemove(name) {
  const installed = readInstalled();
  let removed = false;
  for (const key of Object.keys(installed)) {
    if (key === name || key.startsWith(`${name}_`)) {
      delete installed[key];
      removed = true;
    }
  }
  if (removed) writeInstalled(installed);
  const dest = path.join(INSTALLED_DIR(), name);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    removed = true;
  }
  if (!removed) throw new Error(`plugin "${name}" is not installed`);
  return `plugin "${name}" removed`;
}

export function pluginInstalledNames() {
  return {
    mcp: Object.keys(readInstalled()),
    plugins: existsSync(INSTALLED_DIR()) ? readdirSync(INSTALLED_DIR()) : [],
  };
}

// ---------- Skills management: rtools skill list|install|remove ----------

export function listSkills(skillsDirs) {
  const out = [];
  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      try {
        const { meta } = parseSkillFile(readFileSync(file, "utf8"));
        out.push({ name: meta.name || entry.name, description: (meta.description || "").slice(0, 100), dir: path.join(dir, entry.name) });
      } catch {
        // skip unreadable skills
      }
    }
  }
  return out;
}

function parseSkillFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

// `rtools skill install <name|owner/repo|marketplace-plugin>` — installs a
// skill repo or a plugin from a connected marketplace by cloning it.
export async function skillInstall(source) {
  const target = path.join(SKILLS_DIR(), source.split("/").pop().replace(/\.git$/, ""));
  if (existsSync(target)) throw new Error(`skill "${source}" already installed at ${target} (remove first)`);
  let repo;
  if (source.startsWith("http") || source.startsWith("git@")) repo = source;
  else if (/^[\w.-]+\/[\w.-]+$/.test(source)) repo = `https://github.com/${source}`;
  else {
    // try the connected Codex marketplaces
    const plugin = await marketplaceInfo(source);
    if (!plugin) throw new Error(`skill source "${source}" not found (use owner/repo or a marketplace plugin name)`);
    const m = listMarketplaces().find((x) => x.name === plugin.marketplace) || DEFAULT_MARKETPLACE;
    const cacheRoot = path.join(CACHE_DIR(), m.name.replace(/[^A-Za-z0-9_-]/g, "_"));
    const src = plugin.source?.path ? path.join(cacheRoot, plugin.source.path.replace(/^\.\//, "")) : null;
    if (!src || !existsSync(src)) throw new Error(`plugin directory missing: ${src}`);
    const skillsSrc = path.join(src, "skills");
    if (!existsSync(skillsSrc)) throw new Error(`plugin "${source}" has no skills/ directory`);
    mkdirSync(SKILLS_DIR(), { recursive: true });
    const overwrite = ["1", "true", "yes"].includes(String(process.env.RTOOLS_OVERWRITE_SKILLS || "").toLowerCase());
    let installed = 0;
    let note = "";
    for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(SKILLS_DIR(), entry.name);
      if (existsSync(dest)) {
        if (!overwrite) {
          note += `\nskill "${entry.name}" already installed, skipped (set RTOOLS_OVERWRITE_SKILLS=1 to overwrite)`;
          continue;
        }
        rmSync(dest, { recursive: true, force: true });
      }
      cpSync(path.join(skillsSrc, entry.name), dest, { recursive: true });
      installed++;
    }
    return `${installed} skill(s) from plugin "${source}" installed into ${SKILLS_DIR()}${note}`;
  }
  mkdirSync(SKILLS_DIR(), { recursive: true });
  execSync(`git clone --depth 1 ${repo} ${target}`, { stdio: "inherit" });
  return `skill "${source}" installed into ${target}`;
}

export function skillRemove(name) {
  if (name.includes("..") || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
    throw new Error(`invalid skill name: ${name}`);
  }
  for (const dir of [SKILLS_DIR(), path.join(process.cwd(), ".rtools", "skills")]) {
    const target = path.join(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new Error(`invalid skill name: ${name}`);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      return `skill "${name}" removed from ${dir}`;
    }
  }
  throw new Error(`skill "${name}" not installed`);
}
