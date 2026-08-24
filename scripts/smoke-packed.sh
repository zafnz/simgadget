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

# The root build, not `--workspaces`: the server's `tsc` needs the library's
# declarations to exist, and npm does not order workspace scripts by
# dependency (TODO #90 -- it ran them the other way round in a clean room).
npm run build >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --pack-destination keeps the tarballs out of the repository entirely, so a
# failed run leaves nothing behind to be committed by accident.
LIB_TGZ="$(npm pack --silent --workspace=simgadget --pack-destination "$WORK" | tail -1)"
MCP_TGZ="$(npm pack --silent --workspace=simgadget-mcp --pack-destination "$WORK" | tail -1)"
WRAP_TGZ="$(npm pack --silent --workspace=ios-multi-simulator-mcp --pack-destination "$WORK" | tail -1)"
echo "packed $LIB_TGZ, $MCP_TGZ and $WRAP_TGZ"

cd "$WORK"
npm init -y >/dev/null
# `--force` bypasses one check and one only: `simgadget-mcp` declares
# `"os": ["darwin"]`, and this script has to run on the Linux CI runner, where
# npm would otherwise refuse the install before proving anything. Everything
# this check exists for is untouched by that -- the module graph resolving
# outside the repository, the library coming from its tarball rather than the
# workspace, and the `bin` starting -- and none of it needs macOS. On a Mac the
# flag is a no-op.
npm install "./$LIB_TGZ" "./$MCP_TGZ" "./$WRAP_TGZ" --force --no-audit --no-fund >/dev/null

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

# And again through the deprecated name, because that bin is the entire reason
# the wrapper exists: a client config that still says `ios-multi-simulator-mcp`
# has to keep working, and the only way to know is to run it. Its notice goes
# to stderr, so stdout must still be nothing but MCP.
WRAPPED="$(printf '%s\n' "$INIT" \
  | ./node_modules/.bin/ios-multi-simulator-mcp --stdio 2>/dev/null || true)"

if ! grep -q '"serverInfo"' <<<"$WRAPPED"; then
  echo "ERROR: the deprecated wrapper did not start the server; every existing client config" >&2
  echo "pointing at ios-multi-simulator-mcp would break on upgrade." >&2
  exit 1
fi

NOTICE="$(printf '%s\n' "$INIT" \
  | ./node_modules/.bin/ios-multi-simulator-mcp --stdio 2>&1 >/dev/null || true)"
if ! grep -q "deprecated" <<<"$NOTICE"; then
  echo "ERROR: the wrapper started the server without saying it is deprecated." >&2
  exit 1
fi

echo "OK: all three packed packages install, and both bins answer initialize."
