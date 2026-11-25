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
// artifact's actual digest. Throws when there is no entry for the filename or
// the digest differs, so a tampered artifact never gets installed.
export function verifyShasums(shasums, filename, actualDigest) {
  const entry = shasums
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^[0-9a-f]{64}\s+\S+$/.test(l) && l.split(/\s+/).pop() === filename);
  if (!entry) throw new Error(`no checksum entry for ${filename} in SHASUMS256.txt`);
  const expected = entry.split(/\s+/)[0];
  if (expected !== actualDigest) throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actualDigest}`);
}

export function selfUpdate() {
  const repo = process.env.RTOOLS_REPO || "gymnasticst/rtools";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((seg) => seg.startsWith("."))) throw new Error(`invalid RTOOLS_REPO (expected owner/repo): ${repo}`);
  console.log(`Updating RTools from ${repo}...`);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "rtools-update-"));
  try {
    const releaseJson = execFileSync("curl", ["-fsSL", `https://api.github.com/repos/${repo}/releases/latest`], { encoding: "utf8" });
    const tag = (releaseJson.match(/"tag_name":\s*"([^"]+)"/) || [])[1];
    if (!tag) throw new Error("could not determine the latest release (offline?)");

    const name = `rtools-${tag}.tgz`;
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    const tgzPath = path.join(tmp, name);
    const sumsPath = path.join(tmp, "SHASUMS256.txt");
    execFileSync("curl", ["-fsSL", `${base}/${name}`, "-o", tgzPath]);
    execFileSync("curl", ["-fsSL", `${base}/SHASUMS256.txt`, "-o", sumsPath]);

    verifyShasums(readFileSync(sumsPath, "utf8"), name, sha256File(tgzPath));
    console.log(`Verified ${name} (sha256 ok), installing ${tag}...`);

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
    writeFileSync(path.join(prefix, "rtools"), `#!/bin/sh\nexec node "${lib}/bin/rtools.js" "$@"\n`, { mode: 0o755 });
    console.log(`Updated RTools to ${tag} (checksum verified).`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
