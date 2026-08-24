# `tools-list.baseline.json`

The connect-time surface of the **old** server — `src/index.ts` at the
repository root — recorded before the port replaced it. Every tool's name,
description, input schema and annotations, plus the server's own name and
`instructions`: precisely what an agent sees when it connects.

It was taken over stdio with a one-shot `initialize` + `tools/list`, from an
environment with every `IOS_SIMULATOR_MCP_*` and `SIMGADGET_*` variable
stripped. That matters: `IOS_SIMULATOR_MCP_FILTERED_TOOLS` removes a tool from
`tools/list` entirely, so a baseline captured with it set would be short two
tools and would pass forever.

**It cannot be retaken.** The server it reads stops existing at step 3.6 of
[SIMGADGET_PLAN_SERVER.md](../../../../docs/archive/SIMGADGET_PLAN_SERVER.md); this file is
the reason step 3.0 comes before everything else. Treat it as a fixture to diff
against, never as something to regenerate: a regenerated baseline agrees with
whatever the server currently says, which is the one thing it must not do.

`test/mcp.test.mts` (step 3.7) diffs the new server against it. Intended
differences are an explicit allowlist in that test, each naming the row of
"Deliberate behaviour changes" that authorises it.
