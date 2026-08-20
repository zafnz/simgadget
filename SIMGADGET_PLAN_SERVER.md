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

### A second gap, found at 3.2 — the device type's friendly name

**`start_simulator`'s success message cannot be reproduced from the public
API.** Today it reads:

> `Simulator started: "qa-a_iphone" (iPhone 16 Pro, ABC-123). Ready after 41s.`

The middle field is `deviceType.name` from the old server's own
`findDeviceType` (index.ts:1249). In the library, `createSimulatorWith`
resolves exactly that value at lifecycle.ts:616 and **does not hand it back**:
the returned `Simulator` carries `udid`, `name` and `lastBoot`, and nothing
about the model. `listSimulators()` is no substitute — it yields
`deviceTypeIdentifier`
(`com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro`), not the name, and
costs a `simctl list` to learn something the create call already knew.

Found while writing `render.ts`, which is why it is recorded here rather than
acted on: this is agent C's step, and the fix touches the library's frozen
surface. `renderStarted` takes `deviceTypeName` as an argument, so the renderer
and its tests are complete either way, and the decision is where that argument
comes from. Three options, cheapest first:

1. **Add `readonly deviceType?: DeviceTypeInfo` to the handle**, set by
   `createSimulatorWith` and left undefined on `attachSimulator` (which never
   resolves one). Additive, no existing signature changes, and it names a fact
   about the device that other callers will want too. The `?` is honest rather
   than awkward: an attached handle genuinely does not know.
2. **Return it from `createSimulator`** as `{simulator, deviceType}`. A
   breaking change to a published-shaped signature, for one string.
3. **Drop the field from the message.** Free, and a real loss: the keyword an
   agent passes is `"iPhone"`, and the answer is the only place it learns
   which iPhone it got.

Option 1 unless the owner says otherwise; either way it is a library commit
with its own unit test, not a reach into internals from the server.

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

## How this is split between agents

Five agents, serial. The boundary is **one agent per group of steps that can
be finished, verified green and committed without re-reading a different
region of `src/index.ts`** — not one per numbered step, which pays a full
re-orientation for `env.ts`, and not one for the whole of step 3, which runs
out of context somewhere inside seventeen tool registrations, which is the
worst possible place to hand over.

| agent | steps | why the boundary is here |
|---|---|---|
| **A** | 3.0, 3.1, 3.2 | Pure code: no library calls, no simulator, no MCP. Ends with a complete pure-unit suite and the parity baseline captured. |
| **B** | 3.3 | Sessions, plus the fake-handle infrastructure every later agent uses. The ownership rules deserve undivided attention: `owned` backwards deletes a simulator someone was using. |
| **C** | 3.4 | Seventeen registrations, four commits, **one file** — so this cannot be parallelised. Two agents in `tools.ts` is a merge conflict per tool. |
| **D** | 3.5, 3.6, 3.7 | The deletion commit wants the same hands that just wired the entry point, because it is what redirects `imsmd.sh`, CI and the daemon at it. |
| **E** | none — review | Fresh eyes over all of step 3, against this plan and SIMGADGET.md, writing findings to TODO.md and changing no code. |

**Agent E is not optional.** The equivalent pass over the library
(2026-08-18) produced TODO #74–#88, including two real bugs and a recovered
decisions document. A fresh agent reviewing four agents' work finds more than
a fifth agent writing more code.

Steps 4–7 do not split this way. Step 4 starts with a human renaming the
GitHub repo; only then can an agent do the lockfile, the in-code strings and
`verify:download`. Step 5 is the one place with real parallelism — the docs
are independent files — but one agent is still right, because the failure mode
is three documents each describing a slightly different architecture. Step 6
is a driving job: an agent can drive TESTING_TOOLS.md through the MCP, while
TESTING_SERVER.md's transport and multi-agent cases want a human. Step 7 is a
human with npm credentials.

### What every agent is told, and owes

1. **Read your region, not the file.** `src/index.ts` is 3038 lines. The table
   above says which lines your steps own; an agent that reads all of it has
   spent its context before writing a line.
2. **Finish green.** `npm test` and `npm run typecheck` pass in both packages
   at every commit, not just the last one.
3. **A deviation is a doc change, never a quiet choice.** Every deviation in
   step 2 — `internal/deps.ts`, `env.ts`, copies-not-moves — was written down
   and reviewed, which is what let the review check the code *against*
   something. If this plan is wrong, say so in the plan and then proceed; do
   not silently improve on it.
4. **The last commit updates "Where the tree stands" below**: what landed,
   what deviated and why, what you found that the next agent needs. An agent's
   closing summary evaporates when its session ends; this file does not.
5. **A newly registered MCP tool is invisible to your own session** — clients
   bind their tool list at connect time. Restart the daemon
   (`scripts/imsmd.sh restart`) and drive the new tool over HTTP to
   `127.0.0.1:8008/mcp`. Do not conclude the tool is missing. And never signal
   a server on any other port: they are other people's, and they are
   production (CLAUDE.md).

### Where the tree stands

Each agent appends one entry, as its final commit.

#### Agent A — steps 3.0, 3.1, 3.2 (2026-08-20)

**Landed.** The parity baseline
(`packages/simgadget-mcp/test/fixtures/tools-list.baseline.json`, **17** tools
verified rather than assumed, taken with every `IOS_SIMULATOR_MCP_*` and
`SIMGADGET_*` variable stripped, with a README beside it saying it must never
be regenerated). The package: dependencies, both tsconfigs and the four scripts
copied from `packages/simgadget`. `env.ts`, `paths.ts`, `render.ts`, and 221
tests over the three. Both packages green on `npm test` and `npm run
typecheck`; the root frozen-legacy check still passes and nothing under the
repo-root `src/` or `test/` was touched.

**Deviations, all recorded above rather than buried here:** three wording
changes (rows 9–11 of "Deliberate behaviour changes"), and the enforcement note
plus `RenderContext` under step 3.2.

Two smaller ones, here because they belong to nobody else's step:

- **`package.json` has no `bin` and `build` is a bare `tsc`**, where the
  library's build also chmods its entry point. Both wait for `src/index.ts` at
  3.5 — a `bin` pointing at a missing file breaks the package the moment it is
  linked, and `chmodSync` on one fails the build. `PORT.md` says so; **agent D
  adds both together.**
- **The `IDB_PATH` tombstone is a function, not a module-load throw.** The old
  server threw at import (index.ts:71). A module that throws on import cannot
  be unit tested, and what needs protecting is a server *run*. **Agent D must
  call `assertIdbPathUnset()` from `index.ts` at startup**, or the variable
  silently stops being a tombstone.

**What agent B (`sessions.ts`) needs to know.**

1. **The prose you need already exists, in `render.ts`.** `renderNoSession(id)`
   is `getManagedSim`'s refusal verbatim; `renderAlreadyStarting(id)` is the
   concurrency guard's; `renderAlreadyAttached`, `renderNotBooted`,
   `renderDestroyed(name, udid, owned)` and `renderResumed` are the lifecycle
   answers. Do not re-type any of them — they are covered by tests that assert
   the exact string, so a second copy will drift silently.
2. **`renderError` takes a `RenderContext`**, and so does `handleToolError`.
   Pass `{sessionId: id}` from every tool body: two rows (`simulator-not-found`,
   `no-active-recording`) render a materially better message with it and fall
   back to the library's when it is absent. This is how a session id reaches an
   error without being smuggled into a library payload.
3. **`SimulatorNotFoundError` is what a stale handle throws from *every*
   method**, not just from lifecycle calls — `Simulator.delete()` marks the
   handle and every method checks it first. So a session whose simulator was
   deleted underneath it surfaces as that error from `ui_tap` as readily as
   from `destroy_simulator`, and the registry should treat it as "drop this
   session" wherever it appears, not only where it is expected.
4. `activeRecordings` is gone as a map, per your step — but note that the
   library throws `no-active-recording` as a bare `SimGadgetError` with a
   handle-flavoured message ("for this simulator handle"). The session-flavoured
   wording comes from the `RenderContext`, so shutdown's "tolerate none active"
   is a `catch` on the code, not on the message.
5. **A second library gap is open**, and it is agent C's to close, not yours:
   the device-type name is not on the handle. See "A second gap, found at 3.2"
   above; nothing in `sessions.ts` depends on it.

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

### Step 3.1 — the package itself, then `env.ts` and `paths.ts`

`packages/simgadget-mcp/package.json` today is a placeholder: `private: true`,
no dependencies, no scripts. Before any source file it needs the shape its
sibling already has — dependencies (`simgadget` at the workspace version,
`@modelcontextprotocol/sdk`, `zod`), `build`/`watch`/`typecheck`/`test`
scripts copied from `packages/simgadget/package.json` so both packages are
driven identically, `tsconfig.json` and `tsconfig.test.json`, and the `bin`
entry. `private: true` **stays** until step 7; PORT.md says why, and a `bin`
pointing at a file that does not exist yet is the other half of that (add the
`bin` when `src/index.ts` exists, at 3.5, for the same reason the library's
was held back to step 7 of its own plan).

Then the two files:

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

**The one untyped error that stays untyped** is a
`SIMGADGET_COMPANION_PATH` pointing at a file that does not exist (TODO #82,
and open item 1 below). It renders through the fallback row, which is
adequate — the message names the variable and the path, which is the whole
remedy. **Do not invent a code for it**: adding to `ErrorCode` is a change to
the library's frozen public surface and is the owner's call, not a
renderer's. If a code is added later, it is one row in this table and one case
in its test.

*Tests:* **every `ErrorCode` has a rendering** — a table-driven test over the
exported union, which fails when a new code is added and not rendered; an
unknown error still renders with the link; no rendered message contains a
`simgadget` GitHub URL when it came from the library (design rule 5 runs the
other way too — the URLs are the *server's* to add).

**How the exhaustiveness is actually enforced, as built.** `ERROR_RENDERERS`
is a `Record<ErrorCode, Renderer>` and the test's `SAMPLES` is a
`Record<ErrorCode, SimGadgetError>`, so a new code fails `npm run typecheck` in
*both* files before any test runs — verified by adding a code and watching it
fail, not assumed. The runtime table then walks the same object, which catches
the other half: a row that exists but renders nothing an agent could act on.

**Three places the wording deviates from today's, deliberately.** Each is a row
in "Deliberate behaviour changes" below; recorded here because a
TESTING_TOOLS.md run will otherwise read them as regressions.

- The wedge message's second half branches on `recoveryTried`. `clarify()`
  asserted "restarting it was already attempted and did not help" in *both*
  cases, including the one where the cooldown refused to attempt anything — a
  sentence that sent a reader looking for a restart that never happened. The
  first half is verbatim.
- `simulator-not-found` gains one sentence naming the session and the way back
  (`destroy_simulator`, then `start_simulator`), when a session id is in
  context. The library cannot name a tool; this is precisely the remediation
  design rule 5 puts in the host.
- `device-type-not-found` with an *empty* available list falls through to the
  library's sentence rather than rendering today's `Available types: ` followed
  by nothing.

The renderer takes a small `RenderContext` (`sessionId`, `label`) for the rows
whose old wording named something the library has no concept of. It is
deliberately two fields; anything more and the errors are under-typed.

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
| 9 | `screenshot` answers `Wrote screenshot to: <path>` composed by the server, rather than echoing simctl's stderr | the library returns a `Screenshot`, not simctl's output; the path said back is the absolute one we resolved, which is strictly more useful |
| 10 | the wedge message says whether a bridge restart was *actually* attempted | `clarify()` claimed one had been in both cases; the typed `recoveryTried` knows |
| 11 | a simulator that is gone adds a sentence naming the session and the way back | design rule 5: the library cannot name a tool, so the host does |

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
