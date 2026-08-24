# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Two packages in one repository, published in lockstep:

| Package | What it is | Runtime deps |
|---|---|---|
| `packages/simgadget` | the **library** — drive an iOS simulator from JavaScript: companion lifecycle, gRPC, accessibility reads, taps that verify they landed, coordinates that survive rotation | `@grpc/grpc-js`, `@bufbuild/protobuf` |
| `packages/simgadget-mcp` | the **MCP server** — 17 tools, Zod schemas, sessions, transports, agent-facing prose. One consumer of the library | the above, plus `@modelcontextprotocol/sdk`, `zod` |

The repository root (`simgadget-workspace`) is private, publishes nothing, and
holds only dev tooling, the vendored idb submodule and the scripts.

Nobody maintains two repos, and nobody reasons about version skew: both
packages always carry the same version number, and `simgadget-mcp` depends on
`simgadget@^<that same version>`.

The real product underneath both is the companion. Facebook's last `idb`
release was 2022; `packages/simgadget/companion.lock.json` pins a build from
current idb source against Xcode 26.6 / Swift 6.3.3, sha256-verified and
downloaded on demand. Everything the library can do that `xcrun simctl` cannot
rests on that.

## Build and Development Commands

```bash
# Install dependencies (a workspace root: both packages at once)
npm install

# Build both packages, in dependency order (each compiles to packages/*/build/)
npm run build

# Development with automatic rebuild on changes, one package at a time
npm run watch --workspace=simgadget-mcp

# Unit tests in both packages (no simulator, no companion, seconds)
npm test

# Type-check both packages' sources and tests
npm run typecheck

# The library's end-to-end suite: two throwaway simulators, ~110s unattended
npm run test:e2e

# Pack both tarballs and prove the server installs and answers from them
npm run smoke

# Run the MCP inspector against the server
npm run dev

# Start the compiled server
node packages/simgadget-mcp/build/index.js
```

**Build with `npm run build`, not `npm run build --workspaces`.** npm does not
order workspace lifecycle scripts by dependency, and `simgadget-mcp`'s `tsc`
needs the library's declarations to already exist. The root's `build` script is
where that order is written down (TODO #90).

## Architecture

### The split rule

This is the governing rule, and it replaced the old single-file one:

> **State keyed by udid belongs to the library. State keyed by session id
> belongs to the server.**

A simulator's recovery bookkeeping, its orientation, its companion connection
are facts about a *device*: library. Session ids, the `owned` flag,
delete-on-exit policy, tool filtering, transports are facts about *a server*:
`simgadget-mcp`.

Two corollaries worth stating, because both have been tested by real changes:

- **The server imports only the library's public API.** If a tool cannot be
  built from it, that is a library API bug to fix in `simgadget` — never a
  reason to reach into a deep path. `simgadget`'s `package.json` carries an
  `exports` map exposing only the package root, so `require("simgadget/build/idb/client.js")`
  does not resolve whatever the file layout looks like. A test asserts nothing
  in the server imports a deep path.
- **The library never names a tool.** Its error messages carry a `code` and a
  payload; the server renders prose from them. The GitHub issue URL and the
  troubleshooting link live in `packages/simgadget-mcp/src/render.ts` and
  nowhere else.

### `packages/simgadget` — the library

```
src/index.ts        public exports, and nothing else resolvable
src/errors.ts       the whole error taxonomy: SimGadgetError + ErrorCode
src/simulator.ts    the Simulator handle — reads, actions, rotation, capture
src/lifecycle.ts    listSimulators / createSimulator / attachSimulator (simctl)
src/capture.ts      screenshot + recording (simctl io, sips)
src/cli.ts          `simgadget prefetch`, and deliberately nothing else
src/env.ts          SIMGADGET_* with the IOS_SIMULATOR_MCP_* shim
src/ax/             pure logic, dependency-free
src/idb/            the companion: generated client, process lifecycle
src/internal/       deps seam and the udid-keyed recovery registry
```

`src/ax/` is the pure logic, split out so it can be tested without a simulator.
These are the rules that are wrong in ways a type checker cannot see, and
checking one against a device costs a simulator boot:

- `ax/tree.ts` — the accessibility tree as data: `canonicalise`,
  `isInteresting`/`pruneTree`, `normaliseForMatch`/`matchInTree`, `centreOf`,
  the remote-hosted-view translation, the probe-candidate helpers.
- `ax/orientation.ts` — `transformPointToPortrait` and the orientation
  vocabulary. This is the code that decides where a tap lands.
- `ax/recovery.ts` — `shouldRecover`: when a failed accessibility read is worth
  restarting the simulator's bridge for. The cure lives in `simulator.ts`; only
  the decision is here, because getting it wrong is expensive in both
  directions (see [BOOT_BUG.md](BOOT_BUG.md)).
- `ax/tap.ts` — the tap decisions: the hold floor, what counts as a toggle,
  what a hit-test verdict means.

These are deliberately dependency-free, including on each other and on anything
else in this repository. That is what lets `npm test` run the TypeScript
directly under `node --test` with nothing to build first, and it is the property
to preserve: anything needing a companion, a simulator or the filesystem
belongs elsewhere.

`src/idb/` is the idb client, because it is generated code plus process
lifecycle rather than library logic:

- `src/idb/generated/idb.ts` — ts-proto output from `vendor/idb/proto/idb.proto`,
  regenerated with `npm run gen:proto`. Never edit by hand.
- `src/idb/client.ts` — typed gRPC client for one companion (`describe`,
  `accessibility_info`, `hid`, `accessibility_action`). The one seam where
  `unknown` is allowed: the companion returns free-form JSON, and every value
  is narrowed through `ax/tree.ts` before it reaches anything public.
- `src/idb/companionManager.ts` — spawns, reuses, respawns and reaps
  `idb_companion` processes. A process-level singleton; see its header. Sockets
  live in `/tmp/simgadget-<uid>/`.
- `src/idb/companionBinary.ts` — decides *which* `idb_companion` to run:
  `SIMGADGET_COMPANION_PATH`, else a local build at
  `vendor/idb/Build/Distribution/`, else the sha256-pinned download from
  `companion.lock.json`, cached under `~/Library/Caches/simgadget/companion/<sha256>/`.
  Never `$PATH` — an old companion ignores request fields it does not
  understand instead of erroring, so a fallback would return
  wrong-but-plausible data rather than failing.
- `src/idb/keymap.ts` — generated by `scripts/gen-keymap.mjs`. Never edit by hand.

### `packages/simgadget-mcp` — the server

```
src/index.ts        entry: the registry, createServer, transport selection, shutdown, signals
src/tools.ts        ALL 17 registrations + Zod schemas + SERVER_INSTRUCTIONS
src/sessions.ts     id → handle registry, ownership, cleanup-on-exit
src/transport.ts    stdio + HTTP, Host allowlist, verbose logging, parseArgs/resolveConfig
src/render.ts       structured results and typed errors → agent-facing text
src/env.ts          the server's eight variables, with the same shim
src/paths.ts        ensureAbsolutePath + DEFAULT_OUTPUT_DIR
```

**The 17 tool registrations stay together in one file.** They are repetitive and
benefit from being read side by side; that half of the old single-file rule
survives intact.

Three of those files are splits with a specific reason, and none of the reasons
generalises into a licence to keep splitting:

- `render.ts` — every tool response and every error message, and the only
  genuinely pure part of the server, which makes it the only part that can be
  tested exhaustively. Prose left inline in 17 tool bodies is prose nobody can
  test.
- `env.ts` — a near-copy of the library's, deliberately. Both packages must
  read `SIMGADGET_COMPANION_PATH` by exactly the same rule, and the alternative
  was exporting `readEnv` from the library's public surface, where it would be a
  permanent API promise about a five-line fallback. If the rule changes, it
  changes in both files or it is a bug; a test on each side pins the shared
  behaviour.
- `paths.ts` — thirty lines, extracted because `~/` expansion and the
  default-output-dir fallback are exactly the kind of rule that is wrong in a
  way a type checker cannot see.

The seam that makes the server testable: `sessions.ts` takes its constructors
(`{create, attach}`, defaulting to the library's `createSimulator`/`attachSimulator`),
and `tools.ts` takes the registry as a parameter rather than importing a
module-global. That is what lets a test hand back a fake handle instead of
booting a simulator.

**The MCP SDK crosses into tests only through `test/harness/`.** The SDK ships
two builds with two sets of declarations, and its classes have private fields;
`src/` is CJS and resolves one set while an `.mts` test resolves the other, and
the two `McpServer`s are not interchangeable. The error names a private
`_serverInfo` and reads like an SDK bug. `test/harness/mcp.ts` is a `.ts` file
that resolves the SDK exactly as `src/` does, and it is where anything SDK-typed
belongs.

### The companion

`npm run build:companion` builds it locally (20–30 min, needs the exact Xcode in
`.xcode-version`). It sets `XCODEGEN_STRIP_XATTRS=false`, which is required —
the default path mangles source paths at this directory depth and fails with a
"Build input file cannot be found" naming a truncated path.

**After changing which companion is used — a submodule bump, a new
`companion.lock.json`, a local build — run `npm run check:companion -- <udid>`.**
It checks the behaviours this code assumes of that binary and none of which
upstream has promised to keep: that a marker match is a substring, that it
resolves to the first hit and returns a single element, that the default backend
cannot see toolbar contents while AXBridge can, that a point read hit-tests
cheaply, and that `accessibility_action` activates a control without a touch.
Each one is invisible while it holds and silently wrong when it stops. The 2022
brew companion fails five of the six, which is what the check is calibrated
against; see TESTING_TOOLS.md Part 5.

## Configuration

Ten variables. Two are read by the library, eight by the server:

| var | read by | default |
|---|---|---|
| `SIMGADGET_COMPANION_PATH` | **library** | — (use this binary verbatim) |
| `SIMGADGET_COMPANION_CACHE` | **library** | `~/Library/Caches/simgadget` |
| `SIMGADGET_ALLOWED_HOSTS` | server | — |
| `SIMGADGET_CLEANUP_ON_EXIT` | server | `true` |
| `SIMGADGET_DEFAULT_OUTPUT_DIR` | server | `~/Downloads` |
| `SIMGADGET_FILTERED_TOOLS` | server | — |
| `SIMGADGET_HTTP_HOST` | server | `127.0.0.1` |
| `SIMGADGET_HTTP_PORT` | server | `8008` |
| `SIMGADGET_TRANSPORT` | server | `http` |
| `SIMGADGET_VERBOSE` | server | `false` |

Each is read as `SIMGADGET_<name>` first, falling back to
`IOS_SIMULATOR_MCP_<name>` with exactly one stderr deprecation line per variable
per process. The fallback is dropped two releases after the rename.

`IOS_SIMULATOR_MCP_IDB_PATH` and `SIMGADGET_IDB_PATH` are a **tombstone**: both
throw an explanatory error, because there is no Python `idb` CLI to point at any
more. `assertIdbPathUnset()` is called at server startup and from companion
resolution, never at module load — a module that throws on import cannot be
unit tested.

## Available MCP Tools

Seventeen, filterable via `SIMGADGET_FILTERED_TOOLS`. Every one takes an `id`
naming the session, which owns one simulator:

- `start_simulator` - Create, boot and open a simulator for the session
- `destroy_simulator` - Shut down and delete it (or merely detach, if attached)
- `attach_simulator` - Adopt an already-booted simulator by UDID
- `rotate` - Rotate the device, then report the orientation the interface adopted
- `detect_rotation` - Probe the current orientation and update the coordinate mapping
- `ui_describe_all` - Get accessibility info for the entire screen
- `ui_find` - Resolve one element by label or visible text
- `ui_tap` - Tap by label, or at coordinates
- `ui_type` - Input text
- `ui_swipe` - Swipe gesture
- `ui_describe_point` - Get element at specific coordinates
- `ui_view` - Get compressed screenshot as base64 JPEG
- `screenshot` - Save screenshot to file
- `record_video` - Start video recording
- `stop_recording` - Stop video recording
- `install_app` - Install an app bundle (.app or .ipa) on the simulator
- `launch_app` - Launch an app by bundle identifier

**Tool descriptions and `SERVER_INSTRUCTIONS` are pinned by a captured
baseline** (`packages/simgadget-mcp/test/fixtures/tools-list.baseline.json`),
which two tests diff against — one over the Zod schemas, one over the built
server's `initialize` and `tools/list` responses. It must never be regenerated.
Changing a description on purpose means adding a row to
SIMGADGET_PLAN_SERVER.md's "Deliberate behaviour changes" and an entry in the
test's `ALLOWED_DIFFERENCES` citing that row.

## Testing

Three layers, and they answer different questions.

**`npm test`** — `node --test` over each package's `test/*.test.mts`. The
library's pure logic (pruning rules, label matching, coordinate transforms,
recovery decisions) and the server's rendering, sessions and tool wiring against
a fake handle. No simulator and no companion; both suites run in seconds. Run it
on every change. Node ≥ 22.6 is required to run the TypeScript directly (the
published packages still support Node 18; this is a development-only floor).

**`npm run test:e2e`** — the library's end-to-end suite, in
`packages/simgadget/test/e2e/`. Two throwaway simulators against the `testapp/`
fixture, ~110 seconds unattended, and it deletes what it creates. This is the
layer that answers whether the library actually drives a device. See
[TESTING_LIBRARY.md](TESTING_LIBRARY.md).

**Manual testing** — the only way to answer whether the *server* behaves as an
agent meets it. Requires macOS on Apple Silicon with Xcode and iOS simulators
installed, and an MCP client. Test changes by:

1. Building with `npm run build`
2. Pointing your MCP client at `packages/simgadget-mcp/build/index.js`, or
   starting the managed daemon (below) and using HTTP
3. Running through [TESTING_TOOLS.md](TESTING_TOOLS.md), which exercises every
   tool against the `testapp/` fixture (build it with `testapp/build.sh` first)
4. Running [TESTING_SERVER.md](TESTING_SERVER.md) as well when touching
   transports, sessions or process lifecycle — it covers what a single-simulator
   run cannot

Below all of it: `npm run check:companion -- <udid>` pins what we believe about
somebody else's binary. A unit test against a fake companion is only worth what
the fake's fidelity is worth, and that check is the tether.

CI (`.github/workflows/ci.yml`) runs the typecheck, both unit suites and the
packed-install smoke test on every push, on Ubuntu. None of them needs a
simulator, so none of them replaces the manual plans above.

## Running the server during development

**Use `scripts/imsmd.sh start|stop|restart|status`, and nothing else. Never
start or stop a server any other way.**

```bash
scripts/imsmd.sh restart          # after every build, or you are testing the old one
scripts/imsmd.sh status
```

**A restart destroys every simulator the server created.** That is deliberate —
daemon exit is what stops a day's work leaking simulators — but combined with
"restart after every build" it means each code change costs a 40s boot, a
reinstall, and re-navigating to whatever screen you were testing. It is a silent
cost: the simulator is simply gone next time you look.

To keep them across a restart while iterating (verified, not merely plausible):

```bash
scripts/imsmd.sh restart SIMGADGET_CLEANUP_ON_EXIT=false
```

The simulator survives still booted, with the app installed and the screen where
you left it. The session registry does *not* survive, so re-adopt it with
`attach_simulator {id, udid}` — keep the UDID, `start_simulator` printed it.

The catch, and why this is not the default: an attached session is `owned:
false`, so `destroy_simulator` only detaches. The simulator is then yours to
`xcrun simctl delete`, and orphans accumulate silently until you do. Fine for a
development loop where you know what you created. See TODO #61 for why the
proper fix — a persisted, re-adopted registry — was judged not worth its cost.

It manages exactly one server — `packages/simgadget-mcp/build/index.js`, on
port 8008 (`SIMGADGET_HTTP_PORT`) — recorded in `/tmp/simgadget-daemon.pid` and
logging to `/tmp/simgadget-daemon.log`.

This is not a convenience. **Other people's servers run on this machine, on
other ports, from this same checkout**, and they are production. So:

- **Never `pkill`, `killall`, or `kill` a PID you did not personally start.** A
  server on another port is not yours, whatever its command line looks like. A
  Claude once added a `pkill -f index.js` to this very script "to catch
  leftovers", and it killed a production server; that is why `stop` now touches
  only the pidfile PID and merely *reports* a port held by anything else.
- **Never start a server on another port to test something.** Test against the
  managed one on 8008. If a port other than 8008 answers, it belongs to someone
  else — leave it alone, including for read-only probing, because a request is
  not free either.
- **The MCP tools in a Claude Code session bind to their tool list at connect
  time**, so a tool added after that session started is invisible to it. Restart
  the daemon and drive the new tool over HTTP (`curl` to
  `http://127.0.0.1:8008/mcp`); do not conclude the tool is missing.

## Important Design Principles

- **Never recreate `zafnz/ios-multi-simulator-mcp`** — not the repository, not
  the npm package, not a fork, not a "moved to" placeholder. The repository was
  renamed to `zafnz/simgadget` on 2026-08-24, and GitHub's redirect from the old
  path is load-bearing forever: **every published version of
  `ios-multi-simulator-mcp` carries the old release URL inside its
  `companion.lock.json`**, and that is where those installs fetch a 19 MB
  `idb_companion` from. Creating anything at the old path shadows the redirect
  and breaks the companion download for every one of them, silently, at the
  moment they next need it. The npm package name is deprecated rather than
  unpublished for the same reason.
- **The split rule decides where code goes** (above). Changes that move the
  boundary want discussion first; changes within a package do not.
- **Every action answers with what happened, as data.** No success strings. A
  void return is allowed only where there is genuinely nothing to read back
  (`swipe`, `typeText` — the companion acks and that is all anyone knows). This
  is the rule TODO #62–#66 were spent buying.
- **Every failure a caller can act on is a typed error with a `code` and a
  payload.** Nobody — including `simgadget-mcp` — ever regexes a message.
- **"Absent" is an answer, not an error.** Lookups (`findByLabel`,
  `findByIdentifier`, `describePoint`) return `null` for a clean miss. Actions
  that cannot proceed without the element throw.
- **Keep it simple**: minimal dependencies, standard tooling (npm/tsc).
- **Real use cases only**: don't add hypothetical features.
- **Security first**: always use the `--` separator for user inputs,
  `execFile` with `shell: false`, validate with Zod.
- **The regression rule**: a newly discovered bug lands **three** things — the
  fix, a step added or adjusted in TESTING_TOOLS.md that would have caught it
  against the fixture, and a unit test that catches it in milliseconds. When the
  broken rule is not expressible purely, that is the signal to extract the
  decision into a pure function first — which is exactly how `ax/recovery.ts`
  came to exist.
- **Stay out of the user's idb**: we never read, write or enumerate `/tmp/idb`,
  which brew's companion and the Python client share. Our sockets live in
  `/tmp/simgadget-<uid>/` and we only ever signal a process we spawned.
- **Only ever signal a process we started.** The rule above is about the
  library's own code; it applies just as much to anything run during
  development. See "Running the server during development" — `scripts/imsmd.sh`
  is the only way to start or stop a server, and no process on another port is
  ever ours to kill.
- **Never touch a simulator you did not create.** Create your own and delete it
  when you are done, including on failure.

## Additional Documentation

- **[README.md](README.md)** - The front door: what the two packages are, installation, the library API, the MCP tools, the coordinate contract, configuration
- **[SIMGADGET.md](SIMGADGET.md)** - The design spec: the split rule, the full library API with signatures, the error taxonomy, the coordinate contract, the decisions register
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution guidelines, development setup, the vendored idb submodule, dependency management
- **[TESTING_TOOLS.md](TESTING_TOOLS.md)** - Step-by-step manual test plan covering every MCP tool, run against the `testapp/` fixture
- **[TESTING_SERVER.md](TESTING_SERVER.md)** - Release checks for transports, multiple sessions on one server, and process lifecycle
- **[TESTING_LIBRARY.md](TESTING_LIBRARY.md)** - The library's end-to-end suite: what it covers, the rules it keeps, and what it deliberately does not
- **[BOOT_BUG.md](BOOT_BUG.md)** - The accessibility-never-starts wedge: what was ruled out, what was not, and the recovery in place
- **[CAMERA.md](CAMERA.md)** - **Proposal, not implemented.** Feeding a static image to the simulator's camera
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Common issues and their solutions
- **[SECURITY.md](SECURITY.md)** - Security policy and information about fixed vulnerabilities
- **[CONTEXT.md](CONTEXT.md)** - Reference links for MCP documentation, iOS simulator commands, idb, and security best practices
- **[TODO.md](TODO.md)** - Open findings, in review batches
- **[CHANGELOG.md](CHANGELOG.md)** - Release history

Historical records, not descriptions of the code as it is:
[PLAN.md](PLAN.md), [DECISIONS.md](DECISIONS.md),
[SIMGADGET_PLAN.md](SIMGADGET_PLAN.md),
[SIMGADGET_PLAN_SERVER.md](SIMGADGET_PLAN_SERVER.md).
