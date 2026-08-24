#!/usr/bin/env node
/**
 * The old package's entry point, kept alive so that a client configured
 * against `ios-multi-simulator-mcp` keeps working after the rename.
 *
 * It starts `simgadget-mcp` in this process rather than spawning it: the
 * server reads `process.argv` and owns the stdio transport, so a wrapper that
 * forked would have to proxy both, and every bug in that proxy would look like
 * a bug in the server. Requiring the entry point means there is exactly one
 * process, one argv and one stdin — the wrapper is a name, not a layer.
 *
 * Resolved through `require.resolve` rather than a hardcoded path so the
 * server's own `bin` is the thing that moves if its layout ever changes.
 *
 * The deprecation notice goes to stderr, never stdout: in stdio transport mode
 * stdout is the MCP channel, and a friendly line there corrupts the first
 * message a client reads.
 */
process.stderr.write(
  "[ios-multi-simulator-mcp] This package is deprecated and is now a thin wrapper.\n" +
    "[ios-multi-simulator-mcp] It has been renamed: install `simgadget-mcp` and point your\n" +
    "[ios-multi-simulator-mcp] MCP client at that instead. Nothing else changes — this is the\n" +
    "[ios-multi-simulator-mcp] same server, started under its old name.\n"
);

require("simgadget-mcp/build/index.js");
