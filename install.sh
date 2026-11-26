#!/bin/sh
# RTools installer — one-line install like Codex/OpenCode:
#   curl -fsSL https://raw.githubusercontent.com/gymnasticst/rtools/main/install.sh | sh
# or: curl -fsSL .../install.sh -o install.sh && sh install.sh [--version vX]
# Installs the primary command `rt` plus `rtools` as an alias.
set -eu

REPO="${RTOOLS_REPO:-gymnasticst/rtools}"
REPO_RAW="https://raw.githubusercontent.com/${REPO}/main"
# Default version is rewritten on every push by .github/workflows/auto-release.yml.
# "latest" falls back to resolving the newest release from the GitHub API below.
DEFAULT_VERSION="v0.1.20"
PREFIX="${RTOOLS_PREFIX:-$HOME/.local/bin}"
VERSION_FLAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION_FLAG="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n  %s\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "error: Node.js >= 22 is required (https://nodejs.org)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "error: Node.js >= 22 required, found $(node --version)"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Resolve version: flag → env → latest release tag from GitHub
if [ -n "$VERSION_FLAG" ]; then
  VERSION="$VERSION_FLAG"
elif [ -n "${RTOOLS_VERSION:-}" ]; then
  VERSION="$RTOOLS_VERSION"
elif [ -n "${DEFAULT_VERSION:-}" ] && [ "$DEFAULT_VERSION" != "latest" ]; then
  VERSION="$DEFAULT_VERSION"
else
  say "Fetching the latest RTools release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
  [ -n "$VERSION" ] || { echo "error: could not determine the latest release (offline? set RTOOLS_VERSION)"; exit 1; }
fi
say "Installing RTools ${VERSION} -> ${PREFIX}"

# Prefer a release tarball; fall back to the npm tarball; then to source.
TGZ="https://github.com/${REPO}/releases/download/${VERSION}/rtools-${VERSION}.tgz"
if ! curl -fsSL "$TGZ" -o "$TMP/rtools.tgz" 2>/dev/null; then
  say "Release tarball not found, falling back to npm registry..."
  TGZ="https://registry.npmjs.org/rtools/-/rtools-${VERSION#v}.tgz"
  if ! curl -fsSL "$TGZ" -o "$TMP/rtools.tgz" 2>/dev/null; then
    say "Falling back to the source repository..."
    git clone --depth 1 --branch "${VERSION}" "https://github.com/${REPO}" "$TMP/src" 2>/dev/null \
      || git clone --depth 1 "https://github.com/${REPO}" "$TMP/src"
    SRC="$TMP/src"
  fi
fi

if [ -z "${SRC:-}" ]; then
  mkdir -p "$TMP/unpack"
  tar -xzf "$TMP/rtools.tgz" -C "$TMP/unpack"
  SRC="$(find "$TMP/unpack" -maxdepth 2 -name package.json | head -1 | xargs dirname)"
fi

mkdir -p "$PREFIX"
# rtools is dependency-free Node — copy bin/ + src/ + package.json and add launchers.
cp -r "$SRC/bin" "$SRC/src" "$TMP/pkg" 2>/dev/null || { mkdir -p "$TMP/pkg"; cp -r "$SRC/bin" "$SRC/src" "$TMP/pkg/"; }
cp "$SRC/package.json" "$TMP/pkg/"
cp -r "$TMP/pkg" "$PREFIX/lib-rtools" 2>/dev/null || { rm -rf "$PREFIX/lib-rtools"; cp -r "$TMP/pkg" "$PREFIX/lib-rtools"; }
cat > "$PREFIX/rt" <<LAUNCHER
#!/bin/sh
exec node "$PREFIX/lib-rtools/bin/rtools.js" "\$@"
LAUNCHER
chmod +x "$PREFIX/rt"
cat > "$PREFIX/rtools" <<LAUNCHER
#!/bin/sh
exec node "$PREFIX/lib-rtools/bin/rtools.js" "\$@"
LAUNCHER
chmod +x "$PREFIX/rtools"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    say "NOTE: $PREFIX is not in PATH. Add it:"
    printf '  echo %s >> ~/.bashrc  (or your shell profile)\n' "\"export PATH=\$PATH:$PREFIX\""
    ;;
esac

say "Done. Verify: $(command -v "$PREFIX/rt" >/dev/null && true)$(rt --version 2>/dev/null || "$PREFIX/rt" --version)"
