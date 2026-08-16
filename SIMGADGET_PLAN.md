# SimGadget: implementation plan for the library

> **Scope: SIMGADGET.md step 2, and nothing after it.** This plan takes the
> library from an empty `packages/simgadget/src/index.ts` to a published-shaped,
> proven `simgadget` — and stops. The MCP port (step 3) is explicitly out of
> scope: the server is a port onto a *finished, validated* API, and
> co-developing the two is how the API ends up shaped by whatever the port found
> convenient that afternoon.
>
> **SIMGADGET.md is authoritative.** Where this plan and the spec disagree, the
> spec wins and this file is wrong. Every signature in the spec's API section is
> frozen: a variation needs human signoff before it is written, not a note
> afterwards. Decisions already argued out live in the spec's Decisions
> register; they are not reopened here.

Branch: `simgadget-impl`, cut from `simgadget` at 4cf1bfe.

## The one rule that governs everything else

**Code is copied, at least in spirit, rather than reinvented.** Nearly every
line being moved is the way it is because a simulator boot was spent finding
out that the obvious version is wrong — the 0.1s tap floor, the crossed
landscape orientation map, LEGACY-not-NESTED for point reads, the AXBridge
fallback, the exclusive lock on input streams, the settle before the read after
a rotate. The porting tables below name, for each function, the source lines and
the specific quirks that must survive.

Where a behaviour genuinely must change — because the spec demands data where
today there is a string, or a typed error where today there is a regex — the
change is listed explicitly in "Deliberate behaviour changes" and nowhere else.
If an implementing agent finds itself wanting to wire something differently for
any other reason: **stop and ask.**

## Exit condition

This phase is done when all of these hold:

1. `npm run typecheck` and `npm test` are green in `packages/simgadget`, and the
   root package still builds and passes its own tests.
2. Every public function and `Simulator` method in the spec exists with the
   spec's exact signature, and `src/index.ts` exports exactly the spec's public
   surface — no more.
3. Every one of them has **multiple unit tests**, per the three-layer model
   below. No function is covered only by "it accepts arguments and throws".
4. `npm run test:e2e` drives the `testapp/` fixture on a real simulator through
   the whole API and passes, unattended, from a cold start.
5. `npm run check:companion -- <udid>` passes, including the new checks that
   tether the fake to the real binary.
6. TESTING_LIBRARY.md documents what the e2e suite proves and how to run it.
7. The old MCP server at `src/index.ts` still builds and still runs under
   `scripts/imsmd.sh`, untouched.

## Testing: three layers, and the rule that keeps them honest

| layer | what it owns | cost | where |
|---|---|---|---|
| **pure unit** | the rules — every decision extracted into a dependency-free function | µs | `src/ax/*.ts`, `test/*.test.mts` |
| **fake-client unit** | the wiring — that a method calls the right things in the right order and maps failures to the right typed errors | ms | `test/*.test.mts` with `test/fakes/` |
| **e2e + contract check** | reality — that the library actually drives a simulator, and that the real companion still behaves as the fake claims | ~40s boot | `test/e2e/`, `scripts/check-companion-contract.mjs` |

### The tether rule (standing, non-negotiable)

> **The fake `IdbClient` may only implement behaviours that
> `check-companion-contract.mjs` verifies against the real binary. Anything
> added to the fake gets a corresponding contract check in the same commit.**

The fake encodes our beliefs about someone else's undocumented binary — that a
marker match is a substring, that the first hit wins, that a single element
comes back rather than a collection, that an action does not hit-test. Those
beliefs are exactly why the contract check exists. An untethered fake drifts
into fiction and the unit tests start validating a companion that does not
exist, which is worse than no test at all: it is a green suite defending a
wrong assumption.

Two corollaries:

- **The fake stays an internal constructor seam**, unresolvable through the
  `exports` map. Tests reach it by importing `../src/simulator.ts` directly,
  which is a privilege of living inside the package. No user can.
- **Fake-layer tests do not re-test pure rules through the method.** One
  assertion that the recovery ladder ran in the right order beats re-proving
  the pruning rules at a distance. If a test would be sharper as a pure test,
  it belongs one layer down.

### Contract checks to add, because the fake will encode them

`check-companion-contract.mjs` verifies six behaviours today (substring match;
first hit wins; single element not a collection; default backend blind to
chrome while AXBridge sees it; point reads hit-test cheaply; action activates
without a touch) plus the remote-host node type under `--remote`. The fake
needs four more beliefs, so four more checks land with it:

| # | belief the fake encodes | why the library depends on it |
|---|---|---|
| 7 | an absent marker fails with **"found no element"** | `findByLabel`/`findByIdentifier` return `null` on it; `tap({label})` turns it into `ElementNotFoundError`. If the wording changes, absence becomes a thrown gRPC error and every lookup breaks. |
| 8 | a point read with nothing there fails with **"no translation object"** — the *same* text a wedged bridge produces | the whole reason `describePoint` disambiguates by asking for the screen. If these ever differ, the disambiguation is dead weight; if they converge further, it is load-bearing. |
| 9 | `describe` returns screen dimensions in **both pixels and points** | the coordinate contract sources cached portrait point dimensions from here rather than deriving them from an accessibility read. |
| 10 | a marker query at **depth 0 searches only the root** (reports absent rather than erroring) | why `MARKER_DEFAULT_DEPTH` exists. A silent change here makes every deep control "not found". |

Check 8 needs a wedged bridge to compare against, which is expensive; it runs
the empty-point half unconditionally and the wedge half only under an explicit
`--wedge` flag, in the same spirit as the existing `--remote` mode.

### The regression rule (from the spec, in force from now)

A newly discovered bug lands **three** things: the fix, a step in the testing
plan that would have caught it against the fixture, and a unit test that catches
it in milliseconds. When the broken rule is not expressible purely, that is the
signal to extract the decision into a pure function first — which is exactly how
`ax/recovery.ts` came to exist.

## Where the tree stands (done)

```
package.json                    root: unchanged as a package, + "workspaces": ["packages/*"]
src/                            UNTOUCHED — the old server, still building, still what imsmd.sh runs
packages/simgadget/
├── package.json                simgadget@0.0.1, exports map exposes "." only, deps: grpc + protobuf
├── tsconfig.json               declaration: true; otherwise the root's settings
├── tsconfig.test.json          typechecks test/ alongside src/
├── companion.lock.json         copy; URL still points at the old repo path (see step 4 of the spec)
├── src/
│   ├── index.ts                `export {}` placeholder — the public surface, and nothing else
│   ├── ax/{tree,orientation,recovery}.ts        copies, byte-identical
│   ├── idb/{client,companionBinary,companionManager,keymap}.ts   copies, byte-identical
│   ├── idb/generated/idb.ts    copy, byte-identical, never hand-edited
│   └── internal/               (empty — deps seam lands here)
└── test/
    ├── {tree,orientation,recovery}.test.mts     copies; 132 tests, all passing
    ├── e2e/                    (empty)
    └── fakes/                  (empty)
packages/simgadget-mcp/
├── package.json                private: true, no scripts — a placeholder that npm will not trip over
└── PORT.md                     why it is empty
```

Verified: `npm run typecheck -w simgadget` clean, `npm test -w simgadget` 132/132,
`npm run build` at root still emits a working `build/index.js`.

### Deviations from the spec's layout, for review

1. **`src/internal/deps.ts`** — not in the spec's file list. It holds the
   injectable seam the fake plugs into (`withClient`, `run`, `spawn`, `sleep`,
   `now`) and their real implementations. The alternative, module-global
   mutable state swapped by tests, is worse in every way.
2. **`src/env.ts`** — the `SIMGADGET_*` reader with the `IOS_SIMULATOR_MCP_*`
   fallback and its one-line stderr deprecation. Two variables today
   (`COMPANION_PATH`, `COMPANION_CACHE`), but the shim is a rule rather than
   two `??`s, and the server needs an identical copy for its eight.
3. **`ax/` and `idb/` are copies, not moves** — your call, so the old server
   keeps building. The originals are frozen; see step 1.4.
4. **No `bin` in `packages/simgadget/package.json` yet.** It appears in step 7
   with `cli.ts`; a `bin` pointing at a file that does not exist makes `npm
   install` create a broken symlink.
5. **Versions are `0.0.1`** — matching the placeholder publishes already on npm.
   The real lockstep number is a step-7 decision, not this phase's.

## Implementation order

Each numbered step is at least one commit. **Every commit compiles and passes
`npm test` and the typecheck** — when the manual gate finds a fault, a bisectable
branch is the difference between an afternoon and a week.

### Step 1 — Foundations

**1.1 `src/env.ts`.** `readEnv(name)` reads `SIMGADGET_<name>`, falls back to
`IOS_SIMULATOR_MCP_<name>` with exactly one stderr deprecation line per
variable per process. Also the `IDB_PATH` tombstone, extended to catch
`SIMGADGET_IDB_PATH` — a deprecation shim for a variable whose only behaviour is
to throw would be meaningless. *Tests (pure): new name wins; old name works and
warns; warning is emitted once, not per read; neither set returns undefined;
either `IDB_PATH` spelling throws.*

**1.2 `src/errors.ts`.** The whole taxonomy from the spec, verbatim:
`SimGadgetError` + `ErrorCode` union + the ten payload-carrying subclasses.
Messages are **host-agnostic** — no MCP tool names, no GitHub URLs, no "call
ui_describe_all". Those strings stay with the server, which already has them.
*Tests (pure): every subclass sets its `code`; `instanceof SimGadgetError` holds
for all; payloads survive construction; the message never names an MCP tool or a
URL (assert by regex over a table of constructed errors — cheap, and it catches
the copy-paste that would otherwise leak `ui_view` into the library).*

**1.3 `src/internal/deps.ts`.** The seam:

```ts
export interface SimulatorDeps {
  withClient<T>(udid: string, fn: (c: IdbClient) => Promise<T>, o?: WithClientOptions): Promise<T>;
  run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  spawn(cmd: string, args: string[]): ChildProcess;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export const realDeps: SimulatorDeps = { ... };   // `run` is index.ts:57 verbatim
```

`sleep` and `now` are in the seam so a unit test does not wait out the 1.5s
rotation settle or the 60s recovery cooldown in real time. Not exported from
`index.ts`; the type is internal.

**1.4 Freeze the originals.** `scripts/check-frozen-legacy.mjs`: sha256 of
`src/ax/*.ts` and `src/idb/**` against a checked-in manifest, wired into the
root `npm test`. Keeping the old server building means two copies exist for the
length of this phase, and the failure mode is editing the wrong one and losing
the work silently. This makes that a red test instead. It is deleted in step 3
of the spec, along with the originals.

**1.5 `idb/companionBinary.ts` and `companionManager.ts` fixes.** Required by
the move, each one a real behaviour change:

- **`packageRoot()` is right, the vendor lookup is not.** `__dirname/../..`
  from `build/idb/` still lands on the package root, so `companion.lock.json`
  resolves. But `vendor/idb/Build/Distribution/idb_companion` is at the *repo*
  root, two levels further up, and stays there. Fix: keep `packageRoot()` for
  the lockfile; for the vendor lookup, walk up from `packageRoot()` looking for
  `vendor/idb/Build/Distribution/idb_companion`, stopping at the filesystem
  root. Absent in an installed package, which is the existing behaviour.
- **Cache dir** `~/Library/Caches/ios-multi-simulator-mcp` → `simgadget`; env
  var via the shim. Orphans an already-downloaded 19 MB companion. During
  development, point `SIMGADGET_COMPANION_PATH` at the existing binary rather
  than re-downloading.
- **Socket dir** `/tmp/imsm-<uid>` → `/tmp/simgadget-<uid>`, and **re-run the
  `sun_path` 104-byte check against the longer prefix** rather than assuming it
  fits. A side benefit for this phase: the library and the still-running old
  server use different socket directories, so they cannot collide.
- **Log prefix** `[ios-simulator-mcp]` → `[simgadget]`; **user-agent** on the
  download → `simgadget`; the env-var advice inside companion error text →
  the new names.
- **Arch gate**: `UnsupportedArchitectureError` naming the arch, thrown at
  *resolve* time. Today's failure mode is a gRPC timeout thirty seconds later.
- **The `process.on("exit")` reaper stays**, header rewritten in host-agnostic
  terms: it reaps *companions*, never simulators.

*Tests (pure/fake): the walk-up finds a vendor build at repo root and gives up
at the filesystem root; cache dir honours override, `XDG_CACHE_HOME`, then the
default; socket path for a worst-case udid+pid+generation is under 104 bytes;
the arch gate throws for `x64` and passes for `arm64`.*

### Step 2 — `lifecycle.ts`

Ports `findDevice` (index.ts:383), `findDeviceType` (:423, **first match wins —
simctl lists newest first**), `findLatestRuntime` (:452, **last entry**), and
the boot ladder `waitForBootStatus` (:1069) / `waitUntilDriveable` (:1105) with
its five measured constants (`BOOT_READY_TIMEOUT_MS` 55s, `BOOT_SETTLE_MS` 8s,
`RECOVERY_TAIL_MS` 12s, `BRIDGE_RECOVERY_MIN_POLL_MS` 8s, `BOOTSTATUS_CAP_MS`
30s) and their comments, which are the evidence.

Public: `listSimulators()`, `createSimulator(opts?)`, `attachSimulator(udid)`.
`createSimulator` does **not** throw on a boot that timed out — the simulator
exists either way and throwing discards the handle and the udid with it.

*Pure extractions + tests:* `parseDevices(json)`, `pickDeviceType(list, keyword)`
(case-insensitive substring; first match; throws `DeviceTypeNotFoundError`
carrying the available names), `pickLatestRuntime(list)` (iOS only, available
only, last; throws `no-ios-runtime` when empty), `deriveDeviceName(keyword,
name?)`, and `shouldAttemptBootRecovery({elapsed, budget, sincePollStart})` —
the end-of-budget rule, extracted precisely because "recover when the budget is
nearly gone rather than at a fixed age" is a rule that took a rewrite to get
right. *Fake tests:* `createSimulator` calls create→boot→wait in order and
returns a handle whose `lastBoot` reflects a timeout without throwing;
`attachSimulator` throws `SimulatorNotFoundError` for an unknown udid and does
not boot or probe.

### Step 3 — `simulator.ts`, reading

Ports `describeAll` (:94, internal), `describeScreen` (:144), `findByIdentifier`
(:180), `findByLabel` (:232), `describePoint` (:305), and the recovery machinery
(:877–1055) with its state.

Quirks that must survive, each already load-bearing:

- `describeAll`'s cure ladder: read → restart *our* companion → read → (only if
  this simulator has answered before) restart the *guest* bridge → read.
- an empty read is JSON `null` and must not become `[null]`.
- `describeScreen` uses `Backend.AXBRIDGE` + `DESCRIBE_KEYS`, falls back to the
  default backend on error, and prunes **after** `translateRemoteSubtrees`,
  which reads offsets from parents pruning discards.
- `findByLabel`'s ladder: marker (~13ms) → identifier → AXBridge tree walk with
  typography folding; label matches beat value matches; the tree fallback is
  best-effort and answers `null` rather than erroring.
- `canonicalise` on a marker hit also drops the subtree it arrives with — a
  match inside an app drags ten kilobytes of descendants otherwise.
- `describePoint` uses `Format.LEGACY` (NESTED returns the whole subtree),
  `POINT_KEYS`, `reconcileType(type, subrole)` because the backends disagree
  about their own vocabulary, and disambiguates "no translation object" by
  asking for the whole screen — the one place the two meanings can be told
  apart, and the reason a caller tapping an empty patch does not get their
  bridge restarted.
- recovery: `shouldRecover` gates it; one cure then `POST_RECOVERY_READ_ATTEMPTS`
  (3, 500ms apart) because a restarted bridge answers the probe slightly before
  it answers reliably; a non-wedge error during retry is returned immediately.

*Pure additions:* `isNoElementError(message)` next to `isWedgeError` in
`ax/recovery.ts` — the "found no element" vocabulary, in the one module that
already owns idb's error wording, so no regex lives in `simulator.ts`.
*Fake tests:* the ladder runs companion-restart-then-bridge-restart and stops at
the first usable tree; a degenerate tree after both cures throws
`AccessibilityUnreadableError` with the right `verdict`; a never-answered
simulator does **not** get its bridge restarted; the cooldown suppresses a
second attempt and sets `recoveryTried: false` on the thrown error; `findByLabel`
returns `null` (not throws) on "found no element" and falls through marker →
identifier → tree in that order; `describePoint` returns `null` for an empty
point while a genuine wedge still throws.

### Step 4 — `simulator.ts`, acting

Ports the semantics currently inlined in the `ui_tap` tool body (:1798–1981),
`toggleElement` (:1649), `ui_type` (:1998), `ui_swipe` (:2040), plus
`pressButton` (new public verb over the existing `IdbClient.pressButton`).

`tap()` is the one with teeth. Order, from the existing body, unchanged:
resolve by label → refuse disabled (`ElementDisabledError`) → if toggle and
plain tap, activate through accessibility and read the state back, falling back
to a real touch when the action API cannot reach it → if toggle and hold or
multi-tap, refuse (`ToggleGestureError`) → centre, else `element-unusable-frame`
→ transform to portrait space → **hit-test the centre and refuse if the touch
would not land** (`TapObstructedError` carrying the obstruction) → touch, with
the 0.1s floor, `exclusive: true`, 50ms between repeats.

The measured facts behind that: an instantaneous touch actuates 5/12 of the
time and 12/12 with the floor; a toggle's frame spans its row so its centre is
never the control (0/6 and 0/8 measured); the fixture's stepper under the
toolbar tapped the *search field* and answered "Tapped successfully", which is
what the hit-test exists to prevent.

*Pure extractions + tests:* `decideTapVerb(element, opts)` → `"touch" |
"activation" | error code` — the whole disabled/toggle/gesture decision as one
table-driven function; `holdSeconds(requested)` (the floor); `toggleState(value)`
(`"1"|1 → "on"`, `"0"|0 → "off"`, else the raw value); `describeObstruction(atPoint)`
for the error payload. *Fake tests:* activation is attempted by identifier when
there is one and by label otherwise; a "found no element" from the action API
falls back to a real touch rather than failing; `after` is read back by
identifier where possible (the fixture's own status line outranks the switch on
a label re-read — this is a real bug that was found and fixed); `count: 2` sends
two taps within one exclusive lock; `typeText` throws `UntypeableTextError`
listing distinct offending characters **before any event goes out**; swipe
transforms both endpoints with the same orientation.

### Step 5 — Orientation

Ports `HID_ORIENTATION` (:507 — **the landscapes are crossed on purpose**; a
name-for-name map was written first and the fixture caught it immediately),
`ROTATION_SETTLE_MS` (1.5s, because the tree reports the old geometry until the
animation finishes), `detectOrientation` (:542) and the cached-dimensions
handling (`getScreenDimensions` :603, `cacheScreenDims` :618).

`rotate()` sends the request, settles, invalidates the cached dimensions,
**detects** what the interface adopted, and returns `{requested, adopted}`. It
never assumes the request took: no Face ID iPhone adopts upside-down.

The coordinate contract from the spec is implemented as three distinct
lifetimes: portrait point dimensions cached forever (a property of the model,
sourced from the companion's `describe`); orientation aspect re-derived free on
every describe; chirality riding on the hint, refreshed only by `rotate()` and
`detectOrientation()`. `Orientation`'s internal `"auto"` must not escape —
`getEffectiveOrientation` resolves it at every boundary.

*Pure tests:* the existing `orientation.test.mts` already covers
`transformPointToPortrait` and `getEffectiveOrientation`; add the crossed
device→HID map as a table, and a round-trip property (logical → portrait →
back) for all four orientations at both aspect ratios. *Fake tests:* `rotate`
settles before reading; a declined orientation reports `adopted ≠ requested`
rather than throwing; the cached dimensions are invalidated by `rotate` and
`detectOrientation` and not by an ordinary read.

### Step 6 — `capture.ts`

Ports the `ui_view` pipeline (:2171–2288) and the `screenshot` / `record_video`
/ `stop_recording` bodies (:2352, :2430, :2539).

- capture with `simctl io ... screenshot` (always physical portrait pixels),
  resize with `sips -z <pointHeight> <pointWidth>`, then **rotate to match the
  interface**: `landscape_right → 90`, `landscape_left → 270`,
  `upside_down → 180`. `sips --rotate` is clockwise; an earlier comment claiming
  otherwise was wrong about sips, not about the code.
- `simctl io screenshot` reports success on **stderr** with stdout blank.
- recording: `spawn`, resolve on `"Recording started"` on stderr, reject on
  early exit, resolve anyway after 3s if the process is alive but silent;
  `SIGINT` to stop (not SIGKILL — it is what lets the file finalize) and a 1s
  wait. One recording per handle; `stopRecording()` returns the path, so the
  handle stores it at start.

*Pure extractions + tests:* `rotationForOrientation(o)`; `pointDimensions(frame)`
(portrait-normalised min/max); `sipsArgs(opts)` and `screenshotArgs(opts)` as
argument builders — table-driven, and they are where a `--` separator or a
mis-ordered `-z` would otherwise only show up on a real device.
*Fake tests:* a second `startRecording` throws `recording-already-active`;
`stopRecording` with none throws `no-active-recording`; `stopRecording` signals
SIGINT and returns the path it was started with; `screenshot({resizeTo:
"points"})` computes the resize from the point dimensions and rotates for a
landscape hint.

### Step 7 — `cli.ts` and `prefetchCompanion`

`prefetchCompanion(onProgress?)` wraps `resolveCompanion` (which already
deduplicates concurrent callers). `cli.ts` is `simgadget prefetch` and nothing
else; `bin` is added to package.json in this commit, not before. *Tests:*
progress callback receives the same lines the log would; concurrent calls share
one download (fake the fetch); a checksum mismatch throws
`CompanionDownloadError` and leaves no partial file behind.

### Step 8 — `index.ts` and the exports boundary

Export exactly the spec's surface: `listSimulators`, `createSimulator`,
`attachSimulator`, `prefetchCompanion`, `Simulator`, every error class, and the
types (`Frame`, `AXElement`, `Orientation`, `SimulatorState`, `SimInfo`,
`ReadyResult`, `ScreenRead`, `TapTarget`, `TapOptions`, `TapResult`,
`RotateResult`, `ScreenshotOptions`, `Screenshot`, `RecordingOptions`,
`CreateOptions`).

Two things this step must actually enforce, not merely intend:

- **`AXElement` is closed.** `ax/tree.ts`'s internal type carries
  `[key: string]: unknown`; the exported one does not. The conversion point is
  `canonicalise`, and a test asserts the public type's key set.
- **No `unknown` escapes.** `IdbClient.accessibilityInfo()` stays
  `Promise<unknown>` internally — that is honest about a free-form JSON seam —
  and `IdbClient` is not exported. A test asserts `require("simgadget")` (from
  the built package) exposes the expected names and *not* `IdbClient`,
  `CompanionManager` or anything from `ax/`.

### Step 9 — e2e suite and TESTING_LIBRARY.md

`npm run test:e2e`, `node --test test/e2e/*.e2e.mts`. Two files, because
`node --test` gives each file its own process and a shared simulator cannot
cross that boundary:

- **`lifecycle.e2e.mts`** — creates its own throwaway simulator: `createSimulator`
  → `lastBoot.ready` → `state()` → `listSimulators()` contains it →
  `attachSimulator` on the same udid gives a working second handle →
  `delete()` → every method now throws `SimulatorNotFoundError` → simctl
  confirms it is gone.
- **`library.e2e.mts`** — one boot, then the ordered journey against the
  fixture, the library-level analogue of TESTING_TOOLS.md: install → launch →
  `describeScreen` (assert the toolbar's contents are present, which is the
  AXBridge fallback working) → `findByLabel` on the marker path (`Plain Button`)
  → on the tree-walk path (`Toolbar Switch`, invisible to the default backend)
  → by identifier (`PlainStepper`) → by value where there is no label
  (`Search Bar`) → a miss returns `null` → `tap({label: "Plain Button"})`
  returns `acted: "touch"` with the element → `tap({label: "Plain Switch"})`
  returns `acted: "activation"` with `before ≠ after` → `tap({label: "Toolbar
  Switch"})` exercises the action-API-cannot-reach fallback → `tap({label:
  "Disabled Button"})` throws `ElementDisabledError` → `tap` on the stepper
  under the toolbar throws `TapObstructedError` naming the obstruction →
  `tap({label: "Plain Switch"}, {count: 2})` throws `ToggleGestureError` →
  `typeText` into the focused field and read it back → `typeText("é")` throws
  `UntypeableTextError` → `swipe` scrolls and the tree changes →
  `pressButton("home")` leaves the app → `rotate("landscape_left")` returns
  `adopted` and a tap computed from the *landscape* tree lands →
  `rotate("upside_down")` on an iPhone reports `adopted: "portrait"` →
  `screenshot({resizeTo: "points"})` dimensions match the logical screen and the
  orientation field follows → `startRecording`/`stopRecording` leaves a
  non-empty file.

Rules for the suite, all enforceable:

- It **creates its own simulators and deletes them in `after()`**, including on
  failure. It never touches a simulator it did not create, and it never goes
  near the daemon on :8008 — different simulators, different socket directory.
- It skips with a clear message off macOS or without Xcode, and builds the
  fixture (`testapp/build.sh`) if `MCPTestApp.app` is missing.
- Assertions are on **data**, never on prose. That is the point of the whole
  library: a test that accepts arguments and checks for an error is exactly what
  this suite exists not to be.

TESTING_LIBRARY.md records what each case proves and how to run it — the
document the regression rule adds steps to.

### Step 10 — Contract checks 7–10, and the gate

Add the four checks above to `scripts/check-companion-contract.mjs`, run the
whole thing against a booted fixture, then run the exit condition end to end.

## Deliberate behaviour changes

Everything here is mandated by the spec. Nothing else changes.

| # | change | why |
|---|---|---|
| 1 | actions return data, not strings (`TapResult`, `RotateResult`, `ReadyResult`, `Screenshot`) | design rule 1 — "Tapped successfully" is the bug class TODO #62–#66 killed |
| 2 | typed errors replace message-regexing | design rule 2 — `/found no element/i` and `no translation object` stay at the idb boundary and never escape |
| 3 | `describePoint` returns `null` for an empty point instead of throwing | design rule 3 — absent is an answer. The wedge disambiguation is unchanged; only the reporting is |
| 4 | error messages carry no MCP tool names, no GitHub URLs | design rule 5 — hosts render their own guidance from `code` + payload |
| 5 | the raw unpruned tree is not public; `screenSize()` serves the rectangle | Decisions register |
| 6 | vendor-build lookup walks up from the package root | forced by the monorepo; the installed-package behaviour is unchanged |
| 7 | cache dir, socket dir, log prefix, user-agent renamed | rename scope |
| 8 | arch gate throws at resolve time | standing rule; today it is a gRPC timeout |

## Open items needing your signoff

1. **Where the recovery state lives.** The spec says `hasAnsweredAccessibility`,
   `lastRecoveryAt` and `recoveryInFlight` move into the `Simulator` handle —
   "their one honest home". But the spec also says handles are deliberately
   **not** deduplicated per udid, and all three are facts about a *simulator*,
   not about a handle. Per-handle state means two handles on one udid can each
   order a bridge restart, losing the dedup that exists precisely because "a
   wedge looks like several things failing at once". **Recommendation: keep the
   three in a udid-keyed registry internal to the library, reached through the
   handle** — the handle is the API, the udid is the key. This preserves the
   existing behaviour exactly, which is the porting rule. Confirm before step 3.
2. **`ScreenRead.screen` for a handle that has never described.** The spec has
   `screenSize()` refreshing the aspect hint as a side effect. Sourcing the
   *cached portrait point dimensions* from the companion's `describe` (per the
   coordinate contract) is new code, not a port — today they come from the
   accessibility root frame. Confirm that `describe` is the intended source; it
   is cheaper and more direct, but it is the one place in this phase where the
   spec asks for something the old code does not do.
3. **Two boots per e2e run** (~80s) rather than one, because `node --test`
   isolates files by process. The alternative is a runner script that boots
   once, exports the udid, and runs both files against it. Recommendation: start
   with two boots; add the runner only if the suite grows enough to notice.

## Risks

- **The 19 MB companion re-download** on the first library run, from the cache
  rename. Use `SIMGADGET_COMPANION_PATH` during development.
- **`companion.lock.json`'s URL still points at the old repo path.** Correct for
  now: the rename is step 4 of the spec and the redirect must never be broken by
  recreating the old name. Do not "fix" it in this phase.
- **Two copies of `ax/` and `idb/`** for the length of the phase. The freeze
  manifest (1.4) is the guard; if it ever goes red, the fix is to move the edit
  into `packages/simgadget`, never to update the manifest.
- **e2e flakiness is a real signal.** A tap that lands 11 times in 12 is the
  0.1s-floor bug wearing a different hat. Re-running until green is how that
  gets shipped; investigate instead.
