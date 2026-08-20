# SimGadget: implementation plan for the server, the rename and the publish

Covers **steps 3–7 of [SIMGADGET.md](SIMGADGET.md)**, which is authoritative
for this branch. [SIMGADGET_PLAN.md](SIMGADGET_PLAN.md) covered steps 1 and 2
and is finished: the library exists, is tested against a real simulator, and
has been reviewed. This file is its sibling, written in the same shape and to
the same standard — every step names what is ported, from which lines, which
quirks must survive, and what test would catch it going wrong.

Written 2026-08-20, against `simgadget-impl` at 521 unit tests green.

## The one rule that governs everything else

> **The library is finished. The server is a renderer.**

`packages/simgadget-mcp` imports `"simgadget"` and nothing else — never a deep
path, which the `exports` map makes unresolvable anyway. If a tool cannot be
built from the public API, that is **a library API bug, fixed in `simgadget`
with its own unit test**, and the fix is a commit of its own. It is never a
reach into internals and never a second copy of logic that already exists one
package over. One such gap is already known; see "The library gap this port
needs" below.

The corollary, and the second rule:

> **Parity is measured, not asserted.**

Two artefacts do the measuring. A captured `tools/list` from today's server —
mechanical, exact, and worth taking *before* that server stops existing — and
a TESTING_TOOLS.md run, which is the only thing that can judge prose. Anything
else is somebody's recollection of what the old server said.

## Exit condition

The push is done when all of these hold. Steps 6 and 7 are where most of them
are checked; they are listed here so the target is one list rather than five.

1. `npm test` and `npm run typecheck` green in **both** packages, from the
   workspace root.
2. `packages/simgadget-mcp` imports only `"simgadget"`. Grep-checkable, and
   checked by a test (step 3.7).
3. `tools/list` from the new server matches the captured baseline, except for
   the diffs listed in "Deliberate behaviour changes" and encoded in the test.
4. `scripts/smoke-packed.sh` packs **both** tarballs, installs the server from
   them into an empty directory, and gets an MCP `initialize` — proving the
   server resolves the library from the tarball rather than the workspace
   symlink. This is the classic way a package split breaks only for users.
5. `npm run check:companion -- <udid>` passes against a booted fixture.
6. A full TESTING_TOOLS.md run against the fixture, on the new server.
7. TESTING_SERVER.md, which is not optional this time: transports, sessions
   and process lifecycle all moved files.
8. The repo is renamed, `companion.lock.json` points at the renamed repo's
   canonical release URL, and the never-recreate-the-old-name rule is in
   CLAUDE.md.
9. Docs rewritten: CLAUDE.md, README, CONTRIBUTING, TESTING_*, TROUBLESHOOTING,
   AGENT_INSTRUCTIONS.
10. `simgadget` and `simgadget-mcp` published in that order, and
    `ios-multi-simulator-mcp` published one last time as a deprecated wrapper
    whose bin re-exports the server, so existing client configs keep working.

## What is actually left of `src/index.ts`

3038 lines, and most of them are already ported. The table is here because
"port the server" sounds like porting a 3000-line file, and it is not: it is
roughly 800 lines of session policy, prose and transport, plus 17 tool
registrations whose bodies mostly become one library call each.

| region | lines | destination |
|---|---|---|
| `run`, `describeAll`, `describeScreen`, `findByIdentifier`, `findByLabel`, `describePoint` | 57–350 | **library** (done) |
| `FILTERED_TOOLS`, `isToolFiltered` | 352–361 | server → `tools.ts` |
| `SimSession`, `managedSimulators`, `activeRecordings`, `startingSessions` | 364–378 | server → `sessions.ts` |
| `findDevice`, `findDeviceType`, `findLatestRuntime` | 383–472 | **library** (done) |
| `sessionIdSchema`, `getManagedSim` | 399–417 | server → `sessions.ts` / `tools.ts` |
| `cleanupAllSimulators` | 476–487 | server → `sessions.ts`, over `sim.delete()` |
| `HID_ORIENTATION`, `ROTATION_SETTLE_MS`, `detectOrientation`, screen dims | 507–623 | **library** (done) |
| `diagnoseEmptyAccessibilityTree` | 637–675 | **library** (done) |
| `SERVER_INSTRUCTIONS` | 680–689 | server → `tools.ts` |
| `toError`, `troubleshootingLink`, `errorWithTroubleshooting`, `clarify`, `handleToolError` | 691–748 | server → `render.ts` (`clarify` dies; see 3.2) |
| boot/recovery constants and machinery | 761–1190 | **library** (done) |
| the 17 `server.tool(...)` registrations | 1198–2665 | server → `tools.ts`, bodies mostly one library call |
| `describeFrame`, `toggleElement`, `MIN_TAP_HOLD_SECONDS` | 1616–1765 | **library** (done) |
| `ensureAbsolutePath` | 2293–2318 | server → `paths.ts` |
| `createServer`, `parseArgs`, `config`, `vlog`, `summarizeRpc`, `CLEANUP_ON_EXIT` | 2671–2791 | server → `index.ts` |
| `runStdio`, `readJsonBody`, `CONTAINER_HOST_NAMES`, `allowedHostHeaders`, `runHttp` | 2793–3004 | server → `transport.ts` |
| `runServer`, `shutdown`, signal handlers | 3006–3038 | server → `index.ts` |

One correction to CLAUDE.md while we are counting: its Design Principles
section says "the 16 tool registrations". There are **17**; its own tool list
above it names all seventeen.

## The library gap this port needed — closed 2026-08-20

**`start_simulator`'s resume path had no public equivalent, and the obvious
substitute cost 8 seconds.** Today's server resumes a session whose simulator
is still booted with `findDevice` then `open -a Simulator.app`
(index.ts:1219–1232) — sub-second, and it raises the window for the returning
agent, which is the point. In the library, `open -a Simulator.app` ran in
exactly one place: `Simulator.boot()`. Calling `boot()` on a live simulator is
correct — it swallows the already-booted failure — but it then runs
`waitUntilDriveable`, whose `BOOT_SETTLE_MS` sleep of 8s is **unconditional**
(lifecycle.ts:470–471). The natural mapping turned a sub-second resume into an
8-second one, on the call an agent makes most often after a disconnect.

**Resolved by adding `showWindow(): Promise<void>` to the handle** — the
smallest of the three options considered, and the one that names what the
server actually wants. `boot()` now calls it rather than repeating the line.
The two rejected alternatives are recorded in SIMGADGET.md's Decisions
register: a fast path in the boot ladder means retiming a wait that sits
underneath BOOT_BUG.md's unexplained wedge, and accepting the 8s is wrong in
the place users feel it.

So the resume mapping in step 3.4 is `sim.state()` → if `"Booted"`,
`sim.showWindow()` and render "Resumed existing simulator…"; anything else
drops the stale entry and creates.

## Testing: what the server can own, and what it cannot

The server has never had a single test. That is the gap this plan closes while
it has the file open, and it is not gold-plating: every rule that moved into
`src/ax/` did so because a bug cost simulator boots to find, and the server's
share of that class — path resolution, error rendering, session ownership —
is the part nobody has ever been able to check in milliseconds.

| layer | what it owns | cost | where |
|---|---|---|---|
| **pure unit** | rendering, path resolution, the env shim, the Host allowlist, `summarizeRpc` | µs | `test/*.test.mts` |
| **fake-handle unit** | the wiring: that a tool calls the right library method and renders its result, and that sessions own what they should | ms | `test/*.test.mts` + `test/fakes/simulator.ts` |
| **MCP smoke** | the built server answers `initialize` and lists the right tools, over stdio, no simulator | seconds | `test/mcp.test.mts` + `scripts/smoke-packed.sh` |
| **manual** | parity, transports, multi-agent sessions | boots | TESTING_TOOLS.md, TESTING_SERVER.md |

**The tether rule's analogue here is the compiler.** In the library, the fake
`idb_companion` had to be tethered to the real one by contract checks, because
nothing else could catch the fake drifting from a binary somebody else ships.
The server's dependency is *ours and typed*: the fake `Simulator` in
`test/fakes/simulator.ts` must be declared as implementing the library's
`Simulator` type, so a signature change breaks the test build instead of the
server at runtime. A fake typed as `any` throws that away and is the one thing
to reject in review.

## Layout, and the deviations from the spec's four files

The spec names `index.ts`, `tools.ts`, `sessions.ts`, `transport.ts`. Three
more files, each for a reason that does not generalise:

```
packages/simgadget-mcp/
├── package.json          bin: { "simgadget-mcp": "build/index.js" }, deps: simgadget, @mcp/sdk, zod
├── src/
│   ├── index.ts          entry: parseArgs, config, transport selection, shutdown, signals
│   ├── tools.ts          ALL 17 registrations + Zod schemas + SERVER_INSTRUCTIONS
│   ├── sessions.ts       id → handle registry, ownership, cleanup-on-exit
│   ├── transport.ts      stdio + HTTP, Host allowlist, verbose logging
│   ├── render.ts         (deviation 1) structured results and typed errors → agent-facing text
│   ├── env.ts            (deviation 2) SIMGADGET_* with the IOS_SIMULATOR_MCP_* shim, the server's eight
│   └── paths.ts          (deviation 3) ensureAbsolutePath + DEFAULT_OUTPUT_DIR
└── test/
    ├── *.test.mts
    ├── fakes/simulator.ts
    └── fixtures/tools-list.baseline.json
```

1. **`render.ts`** — every tool response and every error message. It is the
   only genuinely pure part of the server, which makes it the only part that
   can be tested exhaustively; leaving the prose inline in 17 tool bodies is
   what makes today's messages untestable. It also keeps design rule 5 honest
   from one place: the GitHub issue URL and the troubleshooting link live here,
   in the server, and never in the library.
2. **`env.ts`** — the spec calls for it ("the server needs an identical copy
   for its eight"). A near-copy of the library's, which is deliberate: the two
   packages must read `SIMGADGET_COMPANION_PATH` identically, and a shared
   module would mean exporting it from the library's public surface.
3. **`paths.ts`** — thirty lines, extracted for one reason: `~/` expansion and
   the default-output-dir fallback are exactly the kind of rule that is wrong
   in a way a type checker cannot see.

**The seam.** `sessions.ts` takes its constructors — `{create, attach}`,
defaulting to the library's `createSimulator`/`attachSimulator` — the same way
`internal/deps.ts` works in the library, and for the same reason: it is what
lets a test hand back a fake handle instead of booting a simulator. `tools.ts`
takes the registry as a parameter rather than importing a module-global.

## Implementation order

Every commit compiles and passes `npm test` in both packages. When the manual
gate at step 6 finds a fault, a bisectable branch is the difference between an
afternoon and a week — that held for the library and holds harder here, where
the fault will be found by a human reading prose on a screen.

### Step 3.0 — capture the parity baseline, before anything is deleted

Record `tools/list` from **today's** server into
`test/fixtures/tools-list.baseline.json`: every tool's name, description,
input schema and annotations, which is precisely what an agent sees at
connect time.

- Take it over stdio with a one-shot `initialize` + `tools/list`, from a clean
  environment with `IOS_SIMULATOR_MCP_FILTERED_TOOLS` unset — a filtered tool
  is absent from the list, and a baseline missing two tools would pass forever.
- Do it **now**, in its own commit, because at step 3.6 the old server stops
  existing and this becomes a thing that can only be reconstructed from memory.

### Step 3.1 — `env.ts` and `paths.ts`

The eight server variables (`ALLOWED_HOSTS`, `CLEANUP_ON_EXIT`,
`DEFAULT_OUTPUT_DIR`, `FILTERED_TOOLS`, `HTTP_HOST`, `HTTP_PORT`, `TRANSPORT`,
`VERBOSE`), each read as `SIMGADGET_*` first, falling back to
`IOS_SIMULATOR_MCP_*` with one stderr deprecation line per variable per
process. `IOS_SIMULATOR_MCP_IDB_PATH` stays a tombstone that only throws, and
gains `SIMGADGET_IDB_PATH` alongside it — a deprecation shim for a variable
whose only behaviour is an error would be meaningless.

*Tests:* new spelling wins over old; old spelling warns exactly once; neither
set means the documented default; `~/` expands in `DEFAULT_OUTPUT_DIR` and in
the caller's own relative path; an absolute path is returned untouched; a bare
filename lands in `~/Downloads` when nothing is set.

### Step 3.2 — `render.ts`

Ports `troubleshootingLink` (:705), `errorWithTroubleshooting` (:709),
`handleToolError` (:736) and every response string now inlined in tool bodies.

**`clarify()` (:722) does not survive, and its death is the point of the whole
migration.** It exists to recognise a wedged bridge by matching idb's own
wording; the library now raises `SimulatorNotAnsweringError` and
`AccessibilityUnreadableError{verdict}`, so the same prose is produced by a
typed catch. The vocabulary never escapes the idb client again.

The mapping, which is the substance of this step:

| typed error | today's prose | from |
|---|---|---|
| `SimulatorNotAnsweringError` | "not answering accessibility requests… usually still booting" | `clarify`, :723–733 |
| `AccessibilityUnreadableError{"booting"}` | the still-booting guidance | `diagnoseEmptyAccessibilityTree` |
| `AccessibilityUnreadableError{"unrecoverable"}` | the file-a-bug message, **with the issue URL** | index.ts:1305–1311 |
| `TapObstructedError` | "covered, off screen, or scrolled out of view", naming the obstruction | ui_tap body |
| `ElementDisabledError` / `ElementNotFoundError` / `ToggleGestureError` | their existing refusals | ui_tap body |
| `UntypeableTextError` | the character list | ui_type body |
| `DeviceTypeNotFoundError` | "No device type found matching…" + the available list | :439–443 |
| `SimulatorNotFoundError` | "No simulator with udid…" / the stale-session answer | attach/destroy bodies |
| `CompanionDownloadError` / `CompanionStartError` / `UnsupportedArchitectureError` | the companion-acquisition messages | companionBinary prose |
| anything else | `toError().message`, plus the troubleshooting link | `handleToolError` |

*Tests:* **every `ErrorCode` has a rendering** — a table-driven test over the
exported union, which fails when a new code is added and not rendered; an
unknown error still renders with the link; no rendered message contains a
`simgadget` GitHub URL when it came from the library (design rule 5 runs the
other way too — the URLs are the *server's* to add).

### Step 3.3 — `sessions.ts`

Ports `SimSession` (:364), `managedSimulators` (:367), `startingSessions`
(:377), `getManagedSim` (:409) and `cleanupAllSimulators` (:476). The record
becomes `{sim: Simulator, owned: boolean}` — `orientation` and `screenDims`
are gone from it, because they now live in the handle, which is the whole
point of the split rule.

Quirks that must survive:

- **`startingSessions` is reserved synchronously, before any `await`**
  (:1241–1246). Two concurrent `start_simulator` calls for one new id must not both
  create a simulator; the second gets "already being created". This is the
  only place in the server where the ordering of an `await` is load-bearing.
- **`activeRecordings` (:370) disappears as a map.** The recording is per
  handle now, so shutdown stops recordings by walking the sessions and calling
  `sim.stopRecording()`, tolerating "none active".
- **`owned` decides everything about teardown**: `owned: true` →
  `sim.delete()`; attached → `sim.releaseCompanion()` and drop from the
  registry, never a delete. Getting this backwards deletes a simulator the user
  was using, which is why it gets its own test rather than an assertion in a
  larger one.
- **Cleanup-on-exit is `Promise.allSettled`** (:477): one failing teardown must
  not strand the others.
- `companions.reopen(udid)` on create and attach is now inside the library
  (`delete()`/create paths), so the server must **not** try to do it and has no
  way to.

*Fake tests:* the concurrency guard refuses the second creation and the first
still wins; an attached session's `destroy` releases and does not delete; an
owned session's does delete; cleanup-on-exit deletes only owned sessions and
survives one that throws; `CLEANUP_ON_EXIT=false` deletes nothing; a session id
that was never started produces the "call start_simulator first" answer rather
than a crash.

### Step 3.4 — `tools.ts`, in four commits

All 17 registrations in one file, side by side, per the spec's surviving half
of the old single-file rule. Four commits so each is reviewable, in dependency
order:

1. **Lifecycle** — `start_simulator` (:1201), `destroy_simulator` (:1329),
   `attach_simulator` (:1370). The resume path uses `state()` + `showWindow()`,
   per the section above.
2. **Reads** — `ui_describe_all` (:1538), `ui_find` (:1579),
   `ui_describe_point` (:2098), `rotate` (:1445), `detect_rotation` (:1506).
   `ui_find` renders `null` as "No element found whose label contains…" — the
   library's "absent is an answer" rule reaching the agent unchanged.
3. **Actions** — `ui_tap` (:1767), `ui_type` (:1987), `ui_swipe` (:2019). The
   old `ui_tap` body is 215 lines; almost all of it is now `sim.tap()` plus
   rendering a `TapResult`, and the four refusals are typed catches.
4. **Capture and apps** — `ui_view` (:2165), `screenshot` (:2322),
   `record_video` (:2393), `stop_recording` (:2533), `install_app` (:2571),
   `launch_app` (:2614).

Quirks that must survive, each already load-bearing:

- **Tool descriptions and `sessionIdSchema` are copied verbatim.** They are the
  baseline from 3.0 and they are what agents read; a "tidied" description is a
  behaviour change wearing a typo fix's clothes.
- **`ui_view` stays a base64 JPEG image content block** at quality 80, resized
  to points — an MCP wire format with no JS use, which is exactly why it is
  server-side.
- **`screenshot` and `record_video` resolve paths through `paths.ts` before
  calling the library**, which takes absolute paths only.
- **The filtering pattern stays**: `if (!isToolFiltered(name))` around each
  registration, so a filtered tool is genuinely absent from `tools/list`.

*Fake tests:* one per tool at minimum — that it calls the library method the
mapping table names, with the arguments the schema produced, and renders the
result; plus the refusal renderings for `ui_tap`. A tool whose only test is
"it accepts arguments" is the thing this suite exists not to be.

### Step 3.5 — `transport.ts` and `index.ts`

Ports `runStdio` (:2793), `readJsonBody` (:2806), `CONTAINER_HOST_NAMES`
(:2850), `allowedHostHeaders` (:2856), `runHttp` (:2878), and the entry:
`parseArgs` (:2691), `config` (:2749), `vlog` (:2766), `summarizeRpc` (:2775),
`runServer` (:3006), `shutdown` (:3017) and the signal handlers.

Quirks that must survive:

- **Stateless HTTP: a fresh `McpServer` and transport per request** (:2932–
  2945). Durable state lives in the session registry, which is what makes
  disconnect/reconnect work at all.
- **DNS-rebinding protection stays, and the 403 keeps its long explanation**
  (:2909–2930) — it names the rejected Host, lists the accepted ones, and
  tells an operator which variable to set. The variable named in it becomes
  `SIMGADGET_ALLOWED_HOSTS`.
- **No `allowedOrigins`** (:2945–2948): setting it makes the SDK reject
  requests with no Origin header, which is every non-browser MCP client.
- **The EADDRINUSE listener** (:2981–2996) stays and stops naming the old
  package.
- **stdio shuts down when stdin closes** (:2797–2799).
- The MCP server's self-reported name becomes `simgadget`; clients display it.

*Tests:* `allowedHostHeaders` includes loopback, the bound address and the
container names, and excludes an attacker's; `summarizeRpc` renders a
`tools/call` as `session "x" ui_tap`, a batch as a list, and a malformed body
without throwing; `readJsonBody` returns `undefined` for an empty body;
`parseArgs`/`config` precedence is CLI > env > default for all four.

### Step 3.6 — the deletion commit

One commit, so the diff reads as the single event it is:

- delete the repo-root `src/` and `test/`
- delete `scripts/check-frozen-legacy.mjs` and `scripts/frozen-legacy.sha256`
  (its own header says this is the one moment for that, and that the manifest
  is never regenerated instead)
- root `package.json` becomes **private, workspaces root, dev tooling only**:
  no `bin`, no `files`, no `prepare`, no `build`; `test`/`typecheck` fan out
  across workspaces
- `scripts/imsmd.sh` runs `packages/simgadget-mcp/build/index.js`; its pidfile
  and log become `/tmp/simgadget-daemon.{pid,log}`
- `.mcp.json`, `.cursor/commands`, `AGENT_INSTRUCTIONS.md` follow
- `.github/workflows/ci.yml` goes workspace-aware

**Stop the running daemon before this commit and start it after**, or the
pidfile rename orphans a server that then holds port 8008 against its
replacement. `scripts/imsmd.sh stop` first, with the old script; `start` after,
with the new one.

### Step 3.7 — the MCP smoke, and the import boundary

- `test/mcp.test.mts`: spawn the built server with `--stdio`, send
  `initialize` + `tools/list`, and diff against the 3.0 baseline. Intended
  differences are an explicit allowlist **in the test**, each with a comment
  naming the row of "Deliberate behaviour changes" that authorises it. This is
  the parity gate that costs seconds instead of an afternoon.
- A test asserting `packages/simgadget-mcp/src/**` imports `"simgadget"` and no
  deep path. Cheap, and it is the rule the whole split rests on.
- `scripts/smoke-packed.sh` packs **both** tarballs and installs the server
  from them.

## Step 4 — the rename and the lockfile

Dependency-ordered, because the lockfile's canonical URL needs the new path to
exist first.

1. Rename the GitHub repo to `simgadget`. Clones survive on the redirect.
   **Never recreate the old name** — a repository at the old path would shadow
   the redirect that every existing lockfile depends on. This rule goes in
   CLAUDE.md, in the same commit.
2. Release assets move with the repo, so there is nothing to re-cut: point
   `companion.lock.json` (both copies — root's is deleted at 3.6, so this is
   `packages/simgadget/companion.lock.json`) at the new canonical URL. The
   sha256 is unchanged, which is the check that the move was a move.
3. `npm run verify:download` from a clean cache, because a lockfile URL is
   exactly the kind of thing that is fine until somebody needs it.
4. The in-code strings from the spec's rename scope that are not already done:
   the companion download `user-agent`, the `[ios-simulator-mcp]` stderr log
   prefix, the tmpdir prefix, the socket dir `/tmp/imsm-<uid>` →
   `/tmp/simgadget-<uid>` (**re-run the 104-byte `sun_path` check against the
   longer prefix rather than assuming**; the library's test already covers the
   new prefix, so this is confirming, not discovering), and the cache dir
   `~/Library/Caches/ios-multi-simulator-mcp` → `simgadget`, which orphans an
   already-downloaded 19 MB companion and earns a changelog line.
5. `build-companion.yml`'s release tag naming and upload target follow the
   renamed repo.

## Step 5 — docs

Not "after publishing" — docs are part of the branch, and CLAUDE.md in
particular is read by every session that touches this repo.

- **CLAUDE.md**, rewritten rather than amended: the two-package architecture,
  the split rule as the governing rule, the env vars, the testing layers, and
  the never-recreate-the-old-name rule. The pointer at the top of the current
  Architecture section — which exists only because CLAUDE.md forbade this very
  restructure — comes out.
- **README.md**: companion and system dependencies on the first screen, the
  coordinate contract, `prefetchCompanion`, and both packages' install lines.
  Title of the form "SimGadget — iOS simulator automation for JS/TS and MCP",
  because "ios simulator mcp" is what users type and the old name *was* the
  query.
- **CONTRIBUTING.md**: the split rule replaces the single-file rule; the
  regression rule stated where a contributor meets it.
- **TESTING_TOOLS.md**: expected strings updated wherever a deliberate change
  moved them — derived from the table below **before** the step 6 run, not
  during it, or the run becomes a negotiation with itself.
- **TESTING_SERVER.md**: paths, the daemon script, the env vars.
- **TESTING_LIBRARY.md**: already current; check the test counts.
- **TROUBLESHOOTING.md**, **AGENT_INSTRUCTIONS.md**, **CONTEXT.md**: names,
  paths, URLs.
- **CHANGELOG.md**: one entry for the split, naming the breaking bits — the
  client-config server key, the env var names, and the cache re-download.

## Step 6 — verify

The gate, in cost order so a cheap failure is found first:

1. `npm test` + `npm run typecheck`, both packages.
2. `scripts/smoke-packed.sh`, both tarballs.
3. `npm run check:companion -- <udid>` against a booted fixture.
4. `npm run test:e2e` in `packages/simgadget` — unchanged by this phase, which
   is exactly why a red one here means the port broke something underneath it.
5. Full TESTING_TOOLS.md against the fixture, on the new server, through the
   managed daemon on 8008.
6. TESTING_SERVER.md end to end.

Anything found in 5 or 6 lands three things, per the regression rule: the fix,
a TESTING_TOOLS.md step that would have caught it, and a unit test in
whichever package owns the rule.

## Step 7 — publish

1. `simgadget`, then `simgadget-mcp` — dependency order, same version number,
   `simgadget-mcp` depending on `simgadget@^<that version>`. Remove
   `"private": true` from `simgadget-mcp/package.json` (its own PORT.md says
   this is the moment).
2. `publish.yml` packs, installs and `initialize`-tests **both** packages
   before either is published. Today it does one; the lesson that bought that
   check (#51) applies twice as hard to a split.
3. `ios-multi-simulator-mcp` one last time as a wrapper: a third package,
   `packages/ios-multi-simulator-mcp/`, whose `package.json` depends on
   `simgadget-mcp` and whose bin re-exports the server's entry, so existing
   client configs keep working unchanged. Then `npm deprecate` it with a
   message naming the new package. **The wrapper is the one place the old env
   var names must keep working indefinitely**, which the shim already covers.
4. A `simgadget` tag triggers the release; the `v*` filter in `publish.yml`
   already keeps `companion-*` releases from publishing anything.

## Deliberate behaviour changes

Everything users notice. Nothing else changes; TESTING_TOOLS.md's expected
strings are updated from this table and nowhere else.

| # | change | why |
|---|---|---|
| 1 | the MCP server's self-reported name becomes `simgadget` | rename scope; clients display it |
| 2 | the client-config server key changes | breaking, loud, unavoidable — hence the deprecated wrapper |
| 3 | `IOS_SIMULATOR_MCP_*` → `SIMGADGET_*`, old names warn for two releases | rename scope |
| 4 | error prose is triggered by typed catches, not message matching | design rule 2; the wording is preserved |
| 5 | `ui_describe_point` on empty space answers rather than erroring | library design rule 3, already shipped in the library |
| 6 | `ui_tap` results carry what happened (`acted`, state read back) | library design rule 1 |
| 7 | the companion cache directory is renamed, orphaning a 19 MB download | rename scope; harmless, re-downloads |
| 8 | the socket directory becomes `/tmp/simgadget-<uid>/` | rename scope |

## Open items — need your call

1. **The `ErrorCode` addition left over from TODO #82** — a code for
   "`SIMGADGET_COMPANION_PATH` points at nothing", which today is an untyped
   `IdbError`. It touches the frozen surface, and the server's renderer has to
   know either way, so it wants deciding before step 3.2 rather than after.

Decided while planning, and easy to reverse if you disagree — flagged rather
than buried:

3. **The wrapper is a third package** (`packages/ios-multi-simulator-mcp/`),
   not the repo root, because the spec's layout makes the root private and
   dev-only. Alternative: keep the root publishable as the wrapper, which
   costs the clean workspace root.
4. **`pressButton` stays unexposed.** The library has it and the e2e uses it,
   but no tool does today, and parity is the rule for this phase. Logged as a
   TODO instead.
5. **The old server is deleted at 3.6, not after step 6.** Git has it, the
   baseline capture at 3.0 is the part that cannot be reconstructed, and
   keeping both means keeping the freeze manifest and an `imsmd.sh` that runs
   whichever one somebody last pointed it at.

## Risks

- **Prose parity is judged by a human reading a screen.** The `tools/list`
  baseline makes the connect-time surface mechanical, but response text is not
  covered by anything cheaper than TESTING_TOOLS.md. Budget the run, and do
  not start it on the same day the port lands.
- **The daemon on 8008 is shared with other people's work.** Step 3.6 renames
  its pidfile; stop before, start after, and never signal a PID this script did
  not write.
- **Two packages, one version number.** The first publish is the moment skew
  becomes possible; the lockstep rule and `publish.yml` testing both tarballs
  are what prevent it.
- **The rename breaks every existing client config.** That is the deprecated
  wrapper's whole job, and the wrapper is the thing most likely to be rushed
  at the end of a long branch. It gets its own smoke test, from a tarball,
  like everything else.
