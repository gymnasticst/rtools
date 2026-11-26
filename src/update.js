// selfUpdate: install the latest GitHub release tarball after verifying its
// sha256 against the release's SHASUMS256.txt. Nothing is piped into a shell —
// the executed code is always the checksum-verified artifact.
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// Verify a sha256sum-style SHASUMS256.txt ("<hex>  <filename>") against the
// artifact's actual digest. Paths are compared by basename so entries written
// from a subdirectory (e.g. "release/rtools-vX.tgz" in older releases) match.
// Throws when there is no entry for the filename or the digest differs, so a
// tampered artifact never gets installed.
export function verifyShasums(shasums, filename, actualDigest) {
  const entry = shasums
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^[0-9a-f]{64}\s+\S+$/.test(l) && path.basename(l.split(/\s+/).pop()) === path.basename(filename));
  if (!entry) throw new Error(`no checksum entry for ${filename} in SHASUMS256.txt`);
  const expected = entry.split(/\s+/)[0];
  if (expected !== actualDigest) throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actualDigest}`);
}

export function selfUpdate({ quiet = false } = {}) {
  const repo = process.env.RTOOLS_REPO || "gymnasticst/rtools";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((seg) => seg.startsWith("."))) throw new Error(`invalid RTOOLS_REPO (expected owner/repo): ${repo}`);
  const say = (...m) => { if (!quiet) console.log(...m); };

  const tmp = mkdtempSync(path.join(os.tmpdir(), "rtools-update-"));
  try {
    const releaseJson = execFileSync("curl", ["-fsSL", `https://api.github.com/repos/${repo}/releases/latest`], { encoding: "utf8" });
    const tag = (releaseJson.match(/"tag_name":\s*"([^"]+)"/) || [])[1];
    if (!tag) throw new Error("could not determine the latest release (offline?)");

    // Already on this version — nothing to do.
    let current = "unknown";
    try { current = JSON.parse(readFileSync(path.join(updateLibRoot(), "package.json"), "utf8")).version; } catch {}
    if (tag === `v${current}`) {
      say(`RTools ${current} is already the latest version.`);
      return { updated: false, tag, current };
    }

    const name = `rtools-${tag}.tgz`;
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    const tgzPath = path.join(tmp, name);
    const sumsPath = path.join(tmp, "SHASUMS256.txt");
    execFileSync("curl", ["-fsSL", `${base}/${name}`, "-o", tgzPath]);
    execFileSync("curl", ["-fsSL", `${base}/SHASUMS256.txt`, "-o", sumsPath]);

    verifyShasums(readFileSync(sumsPath, "utf8"), name, sha256File(tgzPath));

    const unpack = path.join(tmp, "unpack");
    mkdirSync(unpack);
    execFileSync("tar", ["-xzf", tgzPath, "-C", unpack]);
    const pkg = path.join(unpack, "package");
    if (!existsSync(path.join(pkg, "bin", "rtools.js"))) throw new Error("verified tarball does not contain bin/rtools.js");

    const prefix = process.env.RTOOLS_PREFIX || path.join(os.homedir(), ".local", "bin");
    const lib = path.join(prefix, "lib-rtools");
    rmSync(lib, { recursive: true, force: true });
    mkdirSync(lib, { recursive: true });
    cpSync(path.join(pkg, "bin"), path.join(lib, "bin"), { recursive: true });
    cpSync(path.join(pkg, "src"), path.join(lib, "src"), { recursive: true });
    cpSync(path.join(pkg, "package.json"), path.join(lib, "package.json"));
    writeFileSync(path.join(prefix, "rt"), `#!/bin/sh\nexec node "${lib}/bin/rtools.js" "$@"\n`, { mode: 0o755 });
    writeFileSync(path.join(prefix, "rtools"), `#!/bin/sh\nexec node "${lib}/bin/rtools.js" "$@"\n`, { mode: 0o755 });

    // Short human changelog: commit subjects between the previous and new tag.
    let notes = "";
    try {
      const prev = current === "unknown" ? "" : `v${current}..`;
      const log = execFileSync("git", ["-C", pkgPathDir(), "log", "--oneline", "--no-merges", `${prev}${tag}`], { encoding: "utf8" });
      notes = log.split("\n").filter((l) => l && !l.includes("[skip ci]")).slice(0, 8).map((l) => "- " + l.replace(/^\w+\s+/, "")).join("\n");
    } catch {}
    say(`Updated RTools: ${current} → ${tag.replace(/^v/, "")}`);
    if (notes) say(`Что нового:\n${notes}`);
    return { updated: true, tag, current, notes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function pkgPathDir() {
  return path.join(updateLibRoot(), "..", "..");
}
// Root of the installed tree (…/lib-rtools) or the repo checkout.
function updateLibRoot() {
  return path.join(new URL("..", import.meta.url).pathname, "..", "..");
}

// Check the latest release tag without downloading anything. Returns the tag
// or null (offline, throttled, etc. — never blocks or crashes startup).
export function latestTag() {
  try {
    const repo = process.env.RTOOLS_REPO || "gymnasticst/rtools";
    const json = execFileSync("curl", ["-fsSL", "--max-time", "3", `https://api.github.com/repos/${repo}/releases/latest`], { encoding: "utf8" });
    return (json.match(/"tag_name":\s*"([^"]+)"/) || [])[1] || null;
  } catch {
    return null;
  }
}

// uninstall: remove the launchers, the installed library and (optionally, with
// --with-data) ~/.rtools session data. Refuses to touch a package-manager
// installation (global npm) — uninstall it with npm instead.
export function selfUninstall({ withData = false } = {}) {
  const prefix = process.env.RTOOLS_PREFIX || path.join(os.homedir(), ".local", "bin");
  const lib = path.join(prefix, "lib-rtools");
  const targets = [path.join(prefix, "rt"), path.join(prefix, "rtools"), lib];
  if (!targets.some(existsSync)) {
    console.log("RTools is not installed in the default location (or already removed).");
    console.log("If installed via npm, remove it with: npm rm -g rtools");
    return;
  }
  for (const t of targets) rmSync(t, { recursive: true, force: true });
  console.log(`Removed ${targets.join(", ")}`);
  if (withData) {
    const data = path.join(os.homedir(), ".rtools");
    rmSync(data, { recursive: true, force: true });
    console.log(`Removed session data: ${data}`);
  } else {
    console.log("Session data kept in ~/.rtools — remove it with: rt uninstall --with-data");
  }
}
