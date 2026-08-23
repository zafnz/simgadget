#!/usr/bin/env bash
#
# Pack both packages, install the server from the tarballs into an empty
# directory, and ask it for an MCP initialize.
#
# This exists because the repository is not a realistic environment. Its
# devDependencies are present, so a runtime import that is only reachable
# through one resolves here and fails for everyone else. 2.0.0 shipped exactly
# that -- the generated gRPC client imports `@bufbuild/protobuf/wire`, which was
# reachable only through ts-proto -- and every other check passed: it compiled,
# `npm pack` listed the right files, and the server ran from the working tree.
# Checking what is in the package is not the same as installing it.
#
# The split made it a two-package check, and the second package is the point.
# In this repository `simgadget-mcp` resolves `simgadget` through a workspace
# symlink into `packages/simgadget`, which is not what a user gets: they get
# whatever the published tarball contains, resolved through the `exports` map.
# A file left out of `files`, or an entry point the map does not expose, is
# invisible here and fatal there -- which is the classic way a package split
# breaks only for users. So both tarballs are installed, and the check below
# refuses to proceed if `simgadget` came back as a symlink.
#
# Runs on Linux happily: this proves the module graph resolves and the server
# answers, neither of which needs a simulator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build --workspaces >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --pack-destination keeps the tarballs out of the repository entirely, so a
# failed run leaves nothing behind to be committed by accident.
LIB_TGZ="$(npm pack --silent --workspace=simgadget --pack-destination "$WORK" | tail -1)"
MCP_TGZ="$(npm pack --silent --workspace=simgadget-mcp --pack-destination "$WORK" | tail -1)"
echo "packed $LIB_TGZ and $MCP_TGZ"

cd "$WORK"
npm init -y >/dev/null
npm install "./$LIB_TGZ" "./$MCP_TGZ" --no-audit --no-fund >/dev/null

# A symlink here means the install reached back into the workspace and the rest
# of this script would prove nothing about what users receive.
if [ -L node_modules/simgadget ]; then
  echo "ERROR: node_modules/simgadget is a symlink -- the library was resolved from the" >&2
  echo "workspace, not from its tarball, so this check proves nothing." >&2
  exit 1
fi

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'

# Through the installed `bin`, not the file path: that is what a client config
# and `npx` invoke, and a bin that is missing or not executable fails nowhere
# else.
RESPONSE="$(printf '%s\n' "$INIT" \
  | ./node_modules/.bin/simgadget-mcp --stdio 2>&1 || true)"

echo "${RESPONSE:0:400}"

if ! grep -q '"serverInfo"' <<<"$RESPONSE"; then
  echo "ERROR: the packed packages did not answer an MCP initialize; they are not installable." >&2
  exit 1
fi

echo "OK: both packed packages install and the server answers initialize."
