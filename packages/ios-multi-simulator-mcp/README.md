# ios-multi-simulator-mcp

**Deprecated — renamed to [`simgadget-mcp`](https://www.npmjs.com/package/simgadget-mcp).**

This package is now a thin wrapper. Installing it installs `simgadget-mcp` and
starts it under the old name, so an MCP client configured against
`ios-multi-simulator-mcp` keeps working unchanged.

## Moving across

Change the command in your MCP client config:

```diff
-"command": "npx", "args": ["-y", "ios-multi-simulator-mcp"]
+"command": "npx", "args": ["-y", "simgadget-mcp"]
```

Three things are different once you do, and the wrapper does not hide them:

- **The server reports itself as `simgadget`**, so a client that displays the
  server name will show that.
- **Environment variables are `SIMGADGET_*`.** The old `IOS_SIMULATOR_MCP_*`
  spellings still work and print one deprecation line each; they will be
  removed two releases from now.
- **The companion cache moved** to `~/Library/Caches/simgadget/`, so the
  ~19 MB `idb_companion` downloads once more on first use.

There is also a library now — [`simgadget`](https://www.npmjs.com/package/simgadget)
— if you would rather drive simulators from JavaScript than through MCP.

See [the repository](https://github.com/zafnz/simgadget) for everything else.
