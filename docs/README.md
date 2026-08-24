# Documentation

The repository root holds only what someone arrives looking for: the
[README](../README.md), [CONTRIBUTING](../CONTRIBUTING.md),
[TROUBLESHOOTING](../TROUBLESHOOTING.md),
[AGENT_INSTRUCTIONS](../AGENT_INSTRUCTIONS.md),
[SECURITY](../SECURITY.md), [CONTEXT](../CONTEXT.md), the
[CHANGELOG](../CHANGELOG.md) and the LICENSE. Everything else lives here, split
by who reads it.

If you are **using** either package, the root README and TROUBLESHOOTING are the
whole story; nothing below is required reading.

## [devs/](devs/) — internals

How it is built, and why. None of it is needed to use the packages.

- [SIMGADGET.md](devs/SIMGADGET.md) — the design spec: the split rule, the full library API with signatures, the error taxonomy, the coordinate contract, the decisions register
- [BOOT_BUG.md](devs/BOOT_BUG.md) — the accessibility-never-starts wedge: what was ruled out, what was not, and the recovery in place
- [TODO.md](devs/TODO.md) — open findings, in review batches
- [CAMERA.md](devs/CAMERA.md) — **a proposal, not a feature.** Feeding a static image to the simulator's camera
- [WEB_PITCH.md](devs/WEB_PITCH.md) — source copy for the marketing site, with every claim traced to something measured in this repository

## [testing/](testing/) — the test plans

Layers `npm test` cannot cover, because they need a real simulator.

- [TESTING_TOOLS.md](testing/TESTING_TOOLS.md) — step-by-step manual plan covering every MCP tool, against the `testapp/` fixture
- [TESTING_SERVER.md](testing/TESTING_SERVER.md) — release checks for transports, multiple sessions on one server, and process lifecycle
- [TESTING_LIBRARY.md](testing/TESTING_LIBRARY.md) — the library's end-to-end suite: what it covers, and what it deliberately does not

## [archive/](archive/) — historical records

Finished plans, kept rather than deleted: source comments across both packages
cite them by name for the reason behind a decision, and a reason outlives the
plan that carried it. **None of them describes the code as it is today** — some
still use the pre-rename `ios-multi-simulator-mcp` name and paths.

- [PLAN.md](archive/PLAN.md) — shipping our own `idb_companion`, before the rename
- [DECISIONS.md](archive/DECISIONS.md) — the numbered register the library's comments cite (`DECISIONS.md #12`, and so on)
- [SIMGADGET_PLAN.md](archive/SIMGADGET_PLAN.md) — the library implementation plan
- [SIMGADGET_PLAN_SERVER.md](archive/SIMGADGET_PLAN_SERVER.md) — the server port, the rename and the publish, including the "Deliberate behaviour changes" rows the `tools/list` baseline test cites
