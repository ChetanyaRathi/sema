#!/usr/bin/env bash

# Publish the Sema MCP server entry to the official MCP registry.
#
# Patches mcpb/server.json for a given release tag (version + the release-asset
# URL + its SHA-256), then authenticates to the registry over DNS and publishes.
# Meant to run in the release workflow right after the .mcpb is uploaded, but
# also works locally. The DNS namespace is com.sema-lang/sema; ownership is
# proven by the ed25519 key in $MCP_PRIVATE_KEY matching the apex TXT record on
# sema-lang.com (see docs/plans/archive/2026-07-17-mcpb-bundle.md).
#
# Usage: scripts/publish-mcp-registry.sh --tag vX.Y.Z [--bundle FILE]
#
#   --tag     release tag whose sema.mcpb asset the entry points at (required)
#   --bundle  the built bundle to hash (default: dist/sema.mcpb) — its SHA-256
#             must match the asset already uploaded to the release
#
# Env: MCP_PRIVATE_KEY  ed25519 private key (hex) for DNS auth (required)
# Requires: jq, shasum, mcp-publisher

set -euo pipefail

log() { printf '== %s\n' "$*"; }
die() {
  printf 'publish-mcp-registry: %s\n' "$1" >&2
  exit "${2:-1}"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="sema-lisp/sema"
DOMAIN="sema-lang.com"
SERVER_JSON="$ROOT/mcpb/server.json"

# ── Arguments ────────────────────────────────────────────────────────────────
TAG=""
BUNDLE="$ROOT/dist/sema.mcpb"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --bundle)
      BUNDLE="$2"
      shift 2
      ;;
    *) die "unknown arg: $1" 2 ;;
  esac
done

[[ -n "$TAG" ]] || die "--tag is required" 2
[[ -n "${MCP_PRIVATE_KEY:-}" ]] || die "MCP_PRIVATE_KEY (ed25519 hex) must be set"
[[ -f "$BUNDLE" ]] || die "bundle not found: $BUNDLE (build it with jake mcpb.pack first)"
command -v mcp-publisher >/dev/null || die "'mcp-publisher' not found (brew install mcp-publisher)"

VERSION="${TAG#v}"
URL="https://github.com/$REPO/releases/download/$TAG/sema.mcpb"
SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

# ── Patch server.json for this release ───────────────────────────────────────
log "patching server.json → version $VERSION, sha256 $SHA"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
jq --arg v "$VERSION" --arg url "$URL" --arg sha "$SHA" '
  .version = $v
  | .packages[0].version = $v
  | .packages[0].identifier = $url
  | .packages[0].fileSha256 = $sha
' "$SERVER_JSON" >"$tmp"
mv "$tmp" "$SERVER_JSON"

# ── Authenticate + publish ───────────────────────────────────────────────────
log "login dns ($DOMAIN) + publish"
mcp-publisher login dns --domain "$DOMAIN" --private-key "$MCP_PRIVATE_KEY"
(cd "$ROOT/mcpb" && mcp-publisher publish)
log "published $(jq -r .name "$SERVER_JSON") v$VERSION"
