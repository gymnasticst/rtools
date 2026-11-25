import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

export async function discoverSkills(dirs) {
  const skills = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(skillFile)) continue;
      try {
        const { meta, body } = parseFrontMatter(await readFile(skillFile, "utf8"));
        skills.push({
          name: meta.name || entry.name,
          description: meta.description || "",
          body,
          dir: path.join(dir, entry.name),
        });
      } catch {
        // skip unreadable skills
      }
    }
  }
  return skills;
}
