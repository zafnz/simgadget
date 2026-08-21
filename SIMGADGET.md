# SimGadget: the library, the server, and the rename

> **Status: agreed design, not yet implemented.** This is the spec for the
> migration. The names are reserved on npm, the domain is registered, and the
> API below is written to be implemented as-is — full signatures, result
> shapes and error taxonomy, so an implementing agent does not have to invent
> any of it. Where a judgement call was already argued out, the decision and
> its reason are in the Decisions register at the end; do not relitigate them
> mid-implementation.

First sketched 2026-08-15; reviewed against the full codebase 2026-08-16 and
rewritten as a spec the same day. The largest change from the sketch: the API
now specifies what every call **returns** and **throws**. The old sketch froze
names and argued coordinates but left `tap()` implicitly void — which would
have re-shipped "Tapped successfully", the exact silent-success bug class this
codebase spent TODO #62–#66 killing. The library is an *improvement* on the
existing code, not a transliteration: every action answers with what actually
happened, as data.

## What we are building

Publish the simulator-driving code as a library in its own right —
`simgadget` — and make the MCP server one consumer of it, `simgadget-mcp`.
Both live in this repository. Nobody maintains two repos.

The motivation: the MCP protocol layer earns nothing for a caller who already
has a shell and a Node runtime. During development we routinely drive
simulators from throwaway `.cjs` scripts that `require()` the compiled
`build/idb/` directly and never speak MCP at all. Those scripts are three
lines because this repository has already solved companion resolution, process
lifecycle, orientation, tree pruning and wedge recovery. That work is useful
to people who will never run an MCP server.

| Package | Contains | Runtime deps |
|---|---|---|
| `simgadget` | the library — companion lifecycle, gRPC, accessibility, coordinates, the `Simulator` handle | `@grpc/grpc-js`, `@bufbuild/protobuf` |
| `simgadget-mcp` | the MCP server — tools, Zod, sessions, transports | the above, plus `@modelcontextprotocol/sdk`, `zod` |

Base name is the library, `-mcp` is the integration: nobody types an MCP
config by hand, so `npx simgadget-mcp` costs its users nothing, and the plain
name is worth more attached to the thing people `npm install`. One package
with two entry points was rejected on measured dependency weight: the MCP SDK
(9.1 MB, dragging express/cors/ajv) and zod (5.0 MB) in front of every library
user, for a library that taps a simulator. Both names reserved on npm with
placeholder publishes, 2026-08-16.

The library has **zero npm runtime deps beyond gRPC/protobuf, but real system
deps**: `xcrun simctl`, `sips`, `tar`, macOS. Say so on the first screen of
the README, next to the companion.

## The real product is the companion

Facebook's last `idb` release was 2022. Anyone writing an iOS-simulator
library in JS today either shells out to a four-year-old
`brew install idb-companion`, or to `xcrun simctl`, which cannot read
accessibility at all. `companion.lock.json` pins a build from current idb
source against Xcode 26.6 / Swift 6.3.3, sha256-verified, downloaded on
demand. That is the differentiator, and it belongs on the first screen of the
README rather than in a troubleshooting appendix.

Two standing rules fall out of it:

- **The download URL moves to the renamed repo's canonical path** during the
  push (GitHub redirects the old path, but nothing of ours should depend on
  the redirect). The redirect itself must live forever: every published
  version of `ios-multi-simulator-mcp` carries the old URL baked into its
  lockfile. **Never recreate `ios-multi-simulator-mcp` — repo or npm package —
  under this account**: creating anything at the old path kills the redirect
  for every existing install. This rule goes into CLAUDE.md during the push.
- **arm64 only, failing loudly at resolve time** with an explicit
  unsupported-architecture error naming the arch — never a gRPC timeout
  thirty seconds later. See the Decisions register for why Intel is not
  worth a dollar of effort.

## Repository layout

```
simgadget/                        ← repo, renamed from ios-simulator-mcp
├── package.json                  private, workspaces root, dev tooling
├── packages/
│   ├── simgadget/
│   │   ├── package.json          bin: { simgadget: build/cli.js } — `prefetch`
│   │   ├── companion.lock.json
│   │   ├── src/
│   │   │   ├── index.ts          public exports, and nothing else resolvable
│   │   │   ├── errors.ts         the whole taxonomy below
│   │   │   ├── simulator.ts      the Simulator handle
│   │   │   ├── lifecycle.ts      listSimulators / createSimulator / attachSimulator (simctl)
│   │   │   ├── capture.ts        screenshot + recording (simctl io, sips)
│   │   │   ├── cli.ts            `simgadget prefetch`
│   │   │   ├── ax/               tree.ts, orientation.ts, recovery.ts — moved intact
│   │   │   └── idb/              client, companionManager, companionBinary, keymap, generated/
│   │   └── test/                 node --test on .mts, moved intact, extended
│   └── simgadget-mcp/
│       ├── package.json          bin: { simgadget-mcp: build/index.js }
│       └── src/
│           ├── index.ts          entry: config, transport selection, shutdown
│           ├── tools.ts          ALL tool registrations, one file, side by side
│           ├── sessions.ts       SimSession registry, ownership, cleanup-on-exit
│           └── transport.ts      stdio + HTTP, host allowlist
├── vendor/idb/                   dev-only submodule, stays at root
└── scripts/                      imsmd.sh (renamed), check-companion-contract, smoke-packed, gen-*
```

Versions move in lockstep — both packages always carry the same number, one
script bumps and publishes both, and the server depends on
`simgadget@^<same version>`. This publishes some meaningless server bumps and
in exchange nobody ever reasons about version skew.

`simgadget`'s `package.json` carries an `"exports"` map exposing only the
package root. That is what makes internals *unresolvable* — the only kind of
private that survives contact with users. `src/idb/generated/` and
`src/idb/keymap.ts` remain generated code, never edited by hand.

### The split rule

The old single-file rule is re-cut, not defended. The rule that replaces it:

> **State keyed by udid belongs to the library. State keyed by session id
> belongs to the server.**

Concretely, out of today's `src/index.ts`:

- To **`simgadget`**: `describeAll`/`describeScreen`/`findByLabel`/
  `findByIdentifier`/`describePoint`, the whole wedge-recovery machinery
  (`withAccessibilityRecovery`, `recoverWedgedAccessibility`,
  `waitUntilDriveable`, `restartSimulatorBridge`,
  `diagnoseEmptyAccessibilityTree`) **and the udid-keyed state that binds
  them** (`hasAnsweredAccessibility`, `lastRecoveryAt`, `recoveryInFlight` —
  these move into a udid-keyed registry internal to the library, reached
  through the handle; see the Decisions register for why not per-handle),
  `detectOrientation`, the coordinate transforms' call sites, the tap/swipe/
  type/toggle semantics currently inlined in tool bodies, and the simctl
  lifecycle helpers (`findDevice`, `findDeviceType`, `findLatestRuntime`).
- To **`simgadget-mcp`**: `SimSession`, `managedSimulators`,
  `activeRecordings` (per *session*), `startingSessions`, ownership and
  cleanup-on-exit policy, tool registrations, Zod schemas, transports,
  `SERVER_INSTRUCTIONS`, and every piece of agent-facing prose.

The tool registrations stay together in one file, side by side — they are
repetitive and read better in one place. That half of the old rule survives.

## The library API

### Design rules

1. **Every action answers with what happened, as data.** No success strings.
   A void return is allowed only where there is genuinely nothing to read
   back (`swipe`, `typeText` — the companion acks and that is all anyone
   knows).
2. **Every failure a caller can act on is a typed error with a `code` and a
   payload.** No caller — including `simgadget-mcp` — ever regexes a message.
   The MCP's current `/found no element/i` and `no translation object`
   matching dies here; the library owns that vocabulary at the idb boundary
   and never lets it out.
3. **"Absent" is an answer, not an error.** Lookups (`findByLabel`,
   `findByIdentifier`, `describePoint`) return `null` for a clean miss.
   Actions that cannot proceed without the element (`tap({label})`) throw.
4. **No `unknown` escapes the package.** See "Where `Promise<unknown>`
   survives" below.
5. **Messages are host-agnostic.** Library error messages never name MCP
   tools, GitHub issue URLs, or remediation that assumes a particular host.
   Hosts render their own guidance from `code` + payload.
6. **Nothing in the library ever destroys a simulator except an explicit
   call the user wrote.** Ownership, sessions, delete-on-exit are server
   policy.

### Shared types

```ts
/** A rectangle in logical (screen) coordinate space. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An accessibility element, canonicalised: exactly these keys, absent when
 * empty. Deliberately keeps Apple's key names (AXLabel, not label): it is the
 * vocabulary of the source data, and it keeps `simgadget-mcp`'s tool output
 * byte-compatible with today's without a translation layer.
 *
 * This is a CLOSED type — the `[key: string]: unknown` index signature on
 * today's AXElement does not survive into the public API.
 */
export interface AXElement {
  AXLabel?: string;
  AXValue?: string | number;
  AXUniqueId?: string;
  /** Normalised role vocabulary: "Button", "Switch", "SearchField", ... */
  type?: string;
  enabled?: boolean;
  frame?: Frame;
  children?: AXElement[];
}

/**
 * Device-vocabulary orientation, as the Simulator's own menus use. Note the
 * public type has no "auto": that is the handle's internal unset-hint state
 * and never crosses the API boundary.
 */
export type Orientation =
  | "portrait"
  | "upside_down"
  | "landscape_left"
  | "landscape_right"
  | string; // maybe face down and face up supported later.

export type SimulatorState =
  | "Booted"
  | "Shutdown"
  | "Booting"
  | "Shutting Down"
  | "Creating"
  | string; // simctl reserves the right to grow new states

export interface SimInfo {
  udid: string;
  name: string;
  state: SimulatorState;
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
}
```

### Errors

One base class; subclasses only where there is a payload to carry. The `code`
is the discriminant callers branch on.

```ts
export class SimGadgetError extends Error {
  readonly code: ErrorCode;
}

export type ErrorCode =
  // environment / companion
  | "unsupported-architecture"   // not Apple Silicon; message names the arch
  | "companion-download-failed"  // HTTP failure, checksum mismatch, or no readable pin to fetch
  | "companion-start-failed"     // spawned but never bound / never ready
  // simulator lifecycle
  | "simulator-not-found"        // bad udid on attach, or a stale handle after delete()
  | "device-type-not-found"
  | "no-ios-runtime"
  // accessibility
  | "not-answering"              // the wedge, after recovery was tried (or refused by cooldown)
  | "accessibility-unreadable"   // degenerate tree that survived the full cure ladder
  // element actions
  | "element-not-found"          // tap({label}) on a label nothing matches
  | "element-disabled"
  | "element-unusable-frame"     // resolved, but no frame to aim at
  | "tap-obstructed"             // hit-test says the touch would not reach it
  | "toggle-needs-plain-tap"     // hold/multi-tap aimed at a toggle by name
  // input
  | "untypeable-text"
  // capture
  | "recording-already-active"
  | "no-active-recording"
  // apps
  | "app-bundle-not-found";

export class UnsupportedArchitectureError extends SimGadgetError {} // "unsupported-architecture"
export class CompanionDownloadError extends SimGadgetError {}       // "companion-download-failed"
export class CompanionStartError extends SimGadgetError {
  readonly stderrTail: string[];                                    // "companion-start-failed"
}
export class SimulatorNotFoundError extends SimGadgetError {
  readonly udid: string;                                            // "simulator-not-found"
}
export class DeviceTypeNotFoundError extends SimGadgetError {
  readonly keyword: string;
  readonly available: string[];                                     // "device-type-not-found"
}
export class SimulatorNotAnsweringError extends SimGadgetError {
  /** True when a bridge restart was actually performed this time; false when
   * the cooldown suppressed it (an attempt in the last 60s already failed). */
  readonly recoveryTried: boolean;                                  // "not-answering"
}
export class AccessibilityUnreadableError extends SimGadgetError {
  /** "booting": point reads don't answer either — the device is still coming
   * up; wait and retry. "unrecoverable": point reads answer but the tree is
   * empty and both cures (companion restart, bridge restart) failed — this
   * has never been observed and the host should say so loudly. */
  readonly verdict: "booting" | "unrecoverable";                    // "accessibility-unreadable"
}
export class ElementNotFoundError extends SimGadgetError {
  readonly query: string;                                           // "element-not-found"
}
export class ElementDisabledError extends SimGadgetError {
  readonly element: AXElement;                                      // "element-disabled"
}
export class TapObstructedError extends SimGadgetError {
  readonly element: AXElement;      // what was resolved by name
  readonly obstruction: AXElement | null; // what the hit-test found instead; null = nothing there
  readonly point: { x: number; y: number }; // logical coords of the centre that was probed
}                                                                   // "tap-obstructed"
export class ToggleGestureError extends SimGadgetError {
  readonly element: AXElement;
  readonly gesture: "hold" | "multi-tap";                           // "toggle-needs-plain-tap"
}
export class UntypeableTextError extends SimGadgetError {
  readonly characters: string[];    // the distinct offending characters      "untypeable-text"
}
```

Errors without a payload (`no-ios-runtime`, `element-unusable-frame`,
`recording-already-active`, `no-active-recording`, `app-bundle-not-found`)
are thrown as plain `SimGadgetError` with the code set.

### Top-level functions

```ts
export function listSimulators(): Promise<SimInfo[]>;

export interface CreateOptions {
  /** Device-type keyword, e.g. "iPhone", "iPad", "iPhone 16 Pro". Substring
   * match against simctl devicetypes; first (newest) match wins. Default
   * "iPhone". Throws DeviceTypeNotFoundError with the available list. */
  deviceType?: string;
  /** simctl device name. Default: derived from the keyword. */
  name?: string;
  /** Boot after creating. Default true. */
  boot?: boolean;
  /** Budget for boot-and-become-driveable. Default 55_000. Only meaningful
   * with boot: true. */
  budgetMs?: number;
}

/**
 * Creates a simulator on the latest available iOS runtime and (by default)
 * boots it, waiting until it is actually driveable — `simctl boot` returns a
 * minute or more before the accessibility bridge answers, and this call
 * absorbs everything BOOT_BUG.md taught: bootstatus gating, the settle, the
 * end-of-budget bridge restart. Inspect `sim.lastBoot` for how that went;
 * this function does NOT throw on a boot that timed out, because the
 * simulator exists either way and throwing would discard the handle.
 */
export function createSimulator(opts?: CreateOptions): Promise<Simulator>;

/**
 * Adopts an existing simulator by udid. Verifies it exists (throws
 * SimulatorNotFoundError otherwise); does not probe, does not boot, claims no
 * knowledge of orientation. Callers who need it driveable call
 * `sim.waitReady()` next.
 */
export function attachSimulator(udid: string): Promise<Simulator>;

/**
 * Resolves (downloading if necessary) the pinned idb_companion and returns
 * its absolute path. Exists so CI images and provisioning scripts can
 * front-run the 19 MB first-call download. Also exposed as
 * `npx simgadget prefetch`.
 */
export function prefetchCompanion(
  onProgress?: (message: string) => void
): Promise<string>;
```

### The `Simulator` handle

One handle per simulator. Not a bag of udid-taking functions (a repeated
first argument on twenty functions is an object spelled worse) and not a
god-object facade; the handle is also the honest home for per-*handle* state:
the orientation hint, the cached portrait point dimensions, the recording in
progress. The recovery bookkeeping (`hasAnsweredAccessibility`, cooldown
timestamps, in-flight recovery dedup) is deliberately **not** per-handle: it
describes the *simulator*, and two handles on one udid must share one
recovery attempt — "a wedge looks like several things failing at once" is
the reason the dedup exists. It lives in a udid-keyed registry internal to
the library, reached through the handle, cleared by `delete()`.

Handles are deliberately **not deduplicated per udid**: recording state and
the orientation hint are per-handle, and the MCP's sessions depend on that
(two sessions attached to one udid each own their recording). The hazard —
two handles' orientation hints diverging — is stated in the coordinate
contract below.

After `delete()`, or when something external deletes the simulator, every
method throws `SimulatorNotFoundError` — a clear "this simulator no longer
exists", never a gRPC timeout.

```ts
export interface ReadyResult {
  /** Did the simulator serve a usable accessibility read within budget? */
  ready: boolean;
  waitedMs: number;
  /** Was the end-of-budget bridge restart attempted? */
  recoveryTried: boolean;
  /** Did it recover after that restart? (false when it was never needed) */
  recovered: boolean;
}

export interface ScreenRead {
  /** Pruned tree; elements[0] is the screen root carrying the full frame. */
  elements: AXElement[];
  /** Logical dimensions from the root frame — the space every coordinate in
   * `elements` (and every coordinate you pass back in) lives in. */
  screen: { width: number; height: number };
}

export type TapTarget = { x: number; y: number } | { label: string };

export interface TapOptions {
  /** Press duration in seconds. A floor of 0.1s is always applied — an
   * instantaneous touch actuates a control about half the time (measured
   * 5/12; with the floor 12/12) — so passing less changes nothing about the
   * touch itself. Above ~0.5s UIKit reads it as a long press. Setting it at
   * all makes a `{label}` tap at a toggle a hold, which is refused with
   * `ToggleGestureError` even below the floor: asking for a duration is what
   * marks the caller as wanting a real press. */
  durationSeconds?: number;
  /** Number of taps; 2 = double-tap. Default 1. */
  count?: number;
}

export type TapResult =
  | {
      /** A real synthesized touch was delivered. */
      acted: "touch";
      /** Logical coordinates the touch landed at (the element's centre when
       * aimed by label; the caller's own coordinates otherwise). */
      x: number;
      y: number;
      count: number;
      durationSeconds: number;
      /** Present when aimed by label: the element that was resolved and
       * hit-test-verified. Absent for a coordinate tap — coordinates are the
       * caller saying where, and are taken at their word. */
      element?: AXElement;
    }
  | {
      /** A toggle was operated through accessibility (AXPress — the
       * activation VoiceOver performs), because a toggle's frame is
       * routinely not its actuating region and no coordinate can hit it. */
      acted: "activation";
      element: AXElement;
      before?: string | number;
      /** Undefined when the state could not be read back — the host should
       * say so rather than claim success. When defined and equal to
       * `before`, the activation did not take (most often: the control is
       * scrolled out of view). */
      after?: string | number;
    };

export interface RotateResult {
  requested: Orientation;
  /** Detected by probing, not assumed — apps decline orientations (no
   * Face ID iPhone ever adopts upside_down). Coordinates now follow this. */
  adopted: Orientation;
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "tiff" | "bmp" | "gif"; // default "png"
  /** JPEG quality 1–100, default 80. Ignored for other formats. */
  quality?: number;
  /** Resize before returning. "points" = the screen's logical point
   * dimensions (what an agent's coordinates live in). Default: no resize,
   * native pixels. */
  resizeTo?: "points" | { width: number; height: number };
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
  /** Also write the final image here (absolute path). */
  path?: string;
}

export interface Screenshot {
  data: Buffer;
  format: string;
  width: number;   // pixels of the returned image
  height: number;
  /** The capture is always rotated to match the interface orientation —
   * simctl captures in physical portrait regardless, and shipping sideways
   * screenshots would re-ship a bug this repository already fixed. */
  orientation: Orientation;
}

export interface RecordingOptions {
  codec?: "h264" | "hevc";
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
  force?: boolean;
}

export class Simulator {
  readonly udid: string;
  readonly name: string;
  /** The model this was created as — `{identifier, name}`, where `name` is
   * what a person says ("iPhone 16 Pro"). Undefined on an attached handle,
   * which never resolves one; `listSimulators()` has the identifier at the
   * cost of a `simctl list`, and the name at no price at all. */
  readonly deviceType?: DeviceTypeInfo;
  /** How the last boot/waitReady went; set by createSimulator, boot() and
   * waitReady(). Undefined on a fresh attach. */
  readonly lastBoot?: ReadyResult;

  // ---- lifecycle -------------------------------------------------------

  /** Current simctl state. Cheap; hits `simctl list`. */
  state(): Promise<SimulatorState>;

  /** Boots and waits until driveable. Does not throw on timeout — inspect
   * the result; the simulator exists either way. No-op boot (already
   * booted) still performs the wait. */
  boot(opts?: { budgetMs?: number }): Promise<ReadyResult>;

  /** Waits (without booting) until an accessibility read answers with a
   * real frame. Costs nothing when the simulator is already up. This is
   * what the MCP's attach_simulator does after adopting. */
  waitReady(opts?: { budgetMs?: number }): Promise<ReadyResult>;

  /** Brings Simulator.app to the front. No boot, no wait — this is what a
   * session resuming an already-running simulator needs, and `boot()` is
   * the only other thing that opens the app. Raises whatever window is
   * showing rather than choosing a device: with several booted, the
   * frontmost one is not necessarily this handle's. */
  showWindow(): Promise<void>;

  shutdown(): Promise<void>;

  /** Shuts down and deletes the simulator. Internally: stops the companion
   * first and blocks respawn for this udid, so a concurrent call cannot
   * spawn a replacement against a simulator that is about to stop existing.
   * The handle is stale afterwards. */
  delete(): Promise<void>;

  // ---- apps ------------------------------------------------------------

  /** .app directory or .ipa. Throws "app-bundle-not-found" before calling
   * simctl if the path does not exist. */
  installApp(appPath: string): Promise<void>;

  launchApp(
    bundleId: string,
    opts?: { terminateRunning?: boolean }
  ): Promise<{ pid: number | null }>;

  // ---- reading ---------------------------------------------------------

  /**
   * The screen as a caller should see it: the complete tree (AXBridge
   * backend, so tab bars, nav bars and toolbars have their contents),
   * remote-hosted subtrees rebased into screen coordinates, pruned to
   * elements a caller can act on. ~350ms. Runs the full recovery ladder
   * internally (companion restart, then bridge restart) and throws
   * AccessibilityUnreadableError only when both cures failed.
   */
  describeScreen(): Promise<ScreenRead>;

  /** Logical screen dimensions from the cheap (~13ms) read. Refreshes the
   * orientation aspect hint as a side effect. This replaces public access
   * to the raw unpruned tree, which no caller of the old code ever consumed
   * for anything but this rectangle. */
  screenSize(): Promise<{ width: number; height: number }>;

  /**
   * Resolves one element by the text a caller knows it by. Fast marker
   * query first (~13ms), then identifier, then the AXBridge tree walk with
   * typography folding (curly quotes, dashes, NBSP) — the full ladder the
   * MCP's ui_find runs today. null is the normal "absent" answer.
   */
  findByLabel(label: string): Promise<AXElement | null>;

  /** Exact-match lookup by accessibility identifier. */
  findByIdentifier(identifier: string): Promise<AXElement | null>;

  /**
   * The element at a logical-space point, or null when nothing is there.
   * Hit-tests (~10ms). Corrects remote-hosted frames internally: when the
   * answer's frame is >44pt from the probed point, the tree is consulted
   * and the frame (never the identity) replaced.
   */
  describePoint(x: number, y: number): Promise<AXElement | null>;

  // ---- acting ----------------------------------------------------------

  /**
   * Tap by label or by coordinate. The two are different verbs, kept under
   * one name because callers think of them as one:
   *
   * - `{x, y}` is a literal touch at the caller's coordinates, delivered
   *   with the 0.1s floor. No resolution, no verification: coordinates are
   *   the caller saying where.
   * - `{label}` is "find this thing and operate it": resolve (throws
   *   ElementNotFoundError), refuse disabled controls
   *   (ElementDisabledError), route toggles through accessibility
   *   activation with state read-back (acted: "activation") — falling back
   *   to a real touch when the action API cannot reach the element — refuse
   *   hold/multi-tap on toggles (ToggleGestureError: the frame spans the
   *   row, the centre is not the control), hit-test the centre before
   *   touching and refuse when the touch would not land
   *   (TapObstructedError naming what is in the way), then touch.
   *
   * The result says which verb ran and what it read back. There is no
   * "success" that carries no information.
   */
  tap(target: TapTarget, opts?: TapOptions): Promise<TapResult>;

  // Deliberately no setToggle(target, on) in v1: it had no MCP consumer and
  // was the spec's one speculative addition. Flipping via tap({label}) with
  // before/after read-back covers the real use; see TODO #68 for the
  // set-to-state open question.

  /** Logical-space swipe. Void because there is genuinely nothing to read
   * back: the companion acks delivery and knows no more than we do. */
  swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { durationSeconds?: number; delta?: number }
  ): Promise<void>;

  /** Types printable ASCII + newline as key events. Throws
   * UntypeableTextError listing the offending characters BEFORE any event
   * goes out — never a half-typed string. */
  typeText(text: string): Promise<void>;

  /** Hardware buttons. HOME is the only way to leave an app without
   * launching another — the first thing a short script needs. */
  pressButton(
    button: "home" | "lock" | "side-button" | "siri" | "apple-pay",
    opts?: { durationSeconds?: number }
  ): Promise<void>;

  // ---- orientation -----------------------------------------------------

  /** Rotates the device (device vocabulary, as the Simulator's menus use;
   * the crossed mapping to idb's interface vocabulary is internal), waits
   * out the animation, then DETECTS what the interface adopted and reports
   * it. The result is authoritative for the coordinate space. */
  rotate(to: Orientation): Promise<RotateResult>;

  /** Probes the current orientation (a few hundred ms) and refreshes the
   * hint. Call after something external rotated the simulator. */
  detectOrientation(): Promise<Orientation>;

  // ---- capture ---------------------------------------------------------

  screenshot(opts?: ScreenshotOptions): Promise<Screenshot>;

  /** One recording per handle. Throws "recording-already-active". */
  startRecording(path: string, opts?: RecordingOptions): Promise<void>;

  /** Stops and finalizes. Throws "no-active-recording". */
  stopRecording(): Promise<{ path: string }>;

  // ---- low level — you should never need these -------------------------

  /** Restarts the guest's CoreSimulator bridge (the wedge cure). The
   * recovery machinery calls this itself; it is public for hosts that want
   * to force it. */
  restartBridge(): Promise<void>;

  /** Stops this simulator's companion process. The exit hook does this
   * anyway on process exit; long-lived hosts get tidier teardown. The
   * simulator itself keeps running, state intact. */
  releaseCompanion(): Promise<void>;
}
```

### Where `Promise<unknown>` survives, and why

Nowhere public. `IdbClient.accessibilityInfo()` keeps returning
`Promise<unknown>` **internally**, and that is honest rather than lazy: the
companion returns free-form JSON whose shape depends on the request — a
nested tree, a flat legacy element, or a `{elements: …}` marker wrapper — and
pretending the gRPC boundary is typed would be a lie the compiler enforces.
The rule is: `unknown` is allowed at exactly one seam (the JSON parse in
`idb/client.ts`), and every value is narrowed through one validation/
canonicalisation step (`ax/tree.ts`) before it reaches anything with a public
type. `IdbClient` itself is not exported from the package — the `exports` map
makes it unresolvable — so no user ever sees the raw seam. If a future
maintainer finds `unknown` anywhere a user can touch, that is a bug against
this paragraph.

### The coordinate contract

The library persists nothing it can re-derive, and is loud about the one
thing it cannot. Three classes of state:

- **Portrait point dimensions: cached forever, safely.** A udid's device
  type is fixed at creation; the dimensions are a property of the model.
  Sourced from the companion's `describe` call (pixels *and* points) —
  **confirmed as deliberate new code**, not a port: today they come from the
  accessibility root frame. `describe` is cheaper, and it answers from
  target metadata while the bridge is still silent, so dimensions are
  available before the simulator is driveable — the accessibility-read
  source never was. Contract check #9 pins the both-units belief.
- **Orientation aspect (portrait-family vs landscape-family): re-derived per
  describe, for free.** Every describe returns the root frame; its aspect
  refreshes the hint as a side effect. `rotate()` refreshes it
  authoritatively.
- **Chirality (which landscape; portrait vs upside-down): rides on the hint,
  and the contract says so.** A describe cannot distinguish the two
  landscapes — the aspect is identical — and the probe costs too much to run
  inside every tap. The hint is updated by `rotate()` and
  `detectOrientation()`; an external flip between same-aspect orientations is
  invisible until the caller resyncs.

Stated for the README:

> Coordinates are interpreted in the space of your most recent describe.
> `tap({x, y})` works as long as nothing *external* has changed the simulator
> since your last describe or rotate — those are exactly the calls that
> refresh the library's knowledge. `tap({label})` resolves the element inside
> the call, so it is immune to prior rotations, with one footnote: an
> external flip between the two landscapes changes nothing a describe can
> see, so chirality rides on the hint until `detectOrientation()`. And two
> `Simulator` handles for one udid each carry their own hint — if you hold
> two, you resync both.

Detecting orientation *inside* `tap({x, y})` was considered and rejected on
semantics, not cost: the caller's coordinates only mean anything in the space
of the describe they came from. If the simulator rotated since, they are
stale, and transforming old-space coordinates with freshly-detected
orientation lands the tap in a *different* wrong place. Coordinate-space
consistency, not freshness, is the honest guarantee — and it is the same
contract the MCP already imposes on agents, so library and server tell one
story.

## The MCP on top

`simgadget-mcp` becomes a renderer: it owns sessions, ownership policy,
transports, Zod validation and agent-facing prose, and builds every tool
response from the library's structured results. It imports **only the public
API above** — if a tool cannot be built from it, that is a library API bug to
fix in `simgadget`, never a reason to reach into internals.

Functional parity means: every tool behaves as today, and response text stays
equivalent (TESTING_TOOLS.md is the arbiter). The mapping:

| tool | library calls |
|---|---|
| `start_simulator` | resume: `sim.state()` + `sim.showWindow()`; create: `createSimulator({deviceType, name})`, message from `sim.lastBoot` and `sim.deviceType` |
| `destroy_simulator` | owned: `sim.delete()`; attached: `sim.releaseCompanion()` + drop from registry |
| `attach_simulator` | `attachSimulator(udid)` + `sim.state()` check + `sim.waitReady()` |
| `rotate` | `sim.rotate(o)` → message from `requested` vs `adopted` |
| `detect_rotation` | `sim.detectOrientation()` |
| `ui_describe_all` | `sim.describeScreen()` → `JSON.stringify(result.elements)` |
| `ui_find` | `sim.findByLabel(label)`; null → the "No element found…" answer |
| `ui_tap` | `sim.tap(target, {durationSeconds, count})` → render `TapResult` / catch typed errors |
| `ui_type` | `sim.typeText(text)` |
| `ui_swipe` | `sim.swipe(from, to, opts)` |
| `ui_describe_point` | `sim.describePoint(x, y)`; null → the "empty or covered" answer |
| `ui_view` | `sim.screenshot({format: "jpeg", quality: 80, resizeTo: "points"})` → base64 image content |
| `screenshot` | `sim.screenshot({format, display, mask, path})` |
| `record_video` / `stop_recording` | `sim.startRecording(path, opts)` / `sim.stopRecording()` |
| `install_app` / `launch_app` | `sim.installApp(path)` / `sim.launchApp(bundleId, opts)` |

Error rendering replaces today's regex-on-message: `SimulatorNotAnsweringError`
→ the "usually still booting — wait a few seconds" guidance;
`AccessibilityUnreadableError{verdict}` → the booting/file-a-bug messages
(the GitHub issue URL lives here, in the server, not the library);
`TapObstructedError` → the "covered, off screen, or scrolled out of view"
refusal naming the obstruction; and so on. The prose stays; its trigger
becomes a typed catch.

What stays server-side, deliberately: session ids and the `owned` flag,
delete-what-we-created-on-exit, `FILTERED_TOOLS`, `DEFAULT_OUTPUT_DIR` path
resolution, the base64-JPEG `ui_view` shape (an MCP wire format with no JS
use), transports and the Host allowlist, and `SERVER_INSTRUCTIONS`.

## Configuration and the env rename

`IOS_SIMULATOR_MCP_*` → `SIMGADGET_*`. Read the new name, fall back to the
old with one stderr deprecation line, drop the fallback two releases later.
The real list is **ten** (the old sketch said twelve: `SIMCAMCTL_PATH` exists
only in the unimplemented CAMERA.md proposal, and `IDB_PATH` is a tombstone —
see below):

| var | read by |
|---|---|
| `SIMGADGET_COMPANION_PATH` | **library** |
| `SIMGADGET_COMPANION_CACHE` | **library** |
| `SIMGADGET_ALLOWED_HOSTS` | server |
| `SIMGADGET_CLEANUP_ON_EXIT` | server |
| `SIMGADGET_DEFAULT_OUTPUT_DIR` | server |
| `SIMGADGET_FILTERED_TOOLS` | server |
| `SIMGADGET_HTTP_HOST` | server |
| `SIMGADGET_HTTP_PORT` | server |
| `SIMGADGET_TRANSPORT` | server |
| `SIMGADGET_VERBOSE` | server |

The two library vars must read identically from both packages.
`IOS_SIMULATOR_MCP_IDB_PATH`'s only behaviour is to throw an explanatory
error; extend that tombstone to also catch `SIMGADGET_IDB_PATH` and move on —
a deprecation shim for a variable that only ever errors is meaningless.

## Rename scope

Beyond `package.json` names, the GitHub repo (clones survive on the
redirect), the MCP server key in users' client configs (breaking, loud,
unavoidable), and every doc — the **in-code strings**, which redirects do not
cover and the old sketch missed:

- `troubleshootingLink()` and the bug-report URLs baked into error messages
  (today's index.ts:664, 706, 1313, 1433) — point at the new canonical repo
  path, and per the design rules above these move into the *server*, not the
  library
- the `user-agent: ios-multi-simulator-mcp` header on the companion download
- the `[ios-simulator-mcp]` stderr log prefix
- the `ios-simulator-mcp-` tmpdir prefix
- the EADDRINUSE message naming the old package
- the env-var advice embedded in companion error text
- the server's self-reported MCP name — `new McpServer({ name:
  "ios-simulator", ... })` — becomes `simgadget`; clients display it
- the GitHub Actions workflows: `ci.yml` (typecheck/test/smoke must go
  workspace-aware), `publish.yml` (packs, installs and `initialize`-tests
  ONE package today; must do both, in dependency order), and
  `build-companion.yml` (release tag naming and upload target follow the
  renamed repo)
- `.mcp.json`, `AGENT_INSTRUCTIONS.md`, `.cursor/commands`
- `scripts/imsmd.sh`, its pidfile, `/tmp/imsm-daemon.log`
- `/tmp/imsm-<uid>/` socket dir → `/tmp/simgadget-<uid>/`. The sun_path
  104-byte check in companionManager already exists — re-run it against the
  longer prefix rather than assuming (it fits: `/tmp/simgadget-501/` + udid +
  pid + generation ≈ 75 bytes)
- `~/Library/Caches/ios-multi-simulator-mcp/` → `simgadget`. Orphans an
  already-downloaded 19 MB companion; harmless (next run re-downloads and
  re-verifies) but worth a changelog line for metered connections

Search equity: "ios simulator mcp" is literally what users type and the
current name *is* the query. Mitigate deliberately — npm keywords, a README
title of the form "SimGadget — iOS simulator automation for JS/TS and MCP",
and the deprecated wrapper package. The offsetting gain: a distinct name ends
the permanent confusion with upstream `ios-simulator-mcp` (joshuayoes).

## The push

No phases, no intermediate shippable states, no gradual migration. The
preparation that benefited from being early is already done (npm names
reserved, domain registered). Everything else lands as **one branch, one
sustained push**, ending when the MCP is functionally identical on top of the
library and both packages publish. Rewriting CLAUDE.md "after publishing" —
as the old sequencing had it — was backwards; docs are part of the branch.

The shape of the work: **stand up the tree, then get the library working and
proven — almost ignoring the MCP — and only then port the MCP onto it.** The
server is a port onto a finished, validated API, not something co-developed
with it; co-developing the two is how the API would end up shaped by whatever
the port found convenient that afternoon.

Nothing ships between steps, but **every commit on the branch compiles and
passes `npm test` and the typecheck**. When the manual gate at step 6 finds a
fault, a bisectable branch is the difference between an afternoon and a week.

Work order (dependency order):

1. **Scaffold**: rename the repo (the lockfile's canonical URL needs the new
   path to exist), workspaces root, two package.jsons, env shim, string
   renames from the scope list above, and the CI workflows. **First commit on
   the branch: replace CLAUDE.md's architecture section with a pointer to
   this file as authoritative for the branch** — CLAUDE.md currently forbids
   exactly this restructure ("no architecture changes", "tools stay in the
   single src/index.ts"), and an implementing agent reads CLAUDE.md at
   session start; leaving the old rule in place sets every session against
   the work it was asked to do. The full CLAUDE.md rewrite still happens at
   step 5.
2. **Library**: move `src/ax/` and `src/idb/` into `packages/simgadget`
   intact; build `errors.ts`, `simulator.ts`, `lifecycle.ts`, `capture.ts`
   per the API above, absorbing the semantics currently inlined in
   `index.ts` tool bodies; move recovery state into the handle; wire the
   `exports` map; move and extend the tests (the ax/ suite moves unchanged;
   new pure logic — result shaping, error mapping — gets tests in the same
   style). **This step has its own exit gate, and step 3 does not start
   until it passes**: `npm test` + typecheck green, and a live validation
   run driving the `testapp/` fixture through the library directly — boot,
   install, launch, find (marker path and AXBridge fallback), tap by label
   including a toggle and an obstructed refusal, type, swipe, rotate with a
   tap from the landscape tree, screenshot, record — the library-level
   analogue of TESTING_TOOLS.md, scripted where possible so it can be re-run
   cheaply.
3. **Server**: rewrite `simgadget-mcp` on the public API — `tools.ts` (all
   registrations, one file), `sessions.ts`, `transport.ts`. Tool responses
   rendered from structured results; no message-regexing anywhere.
4. **Lockfile**: point `companion.lock.json` at the renamed repo's canonical
   release URL (assets moved with the repo; nothing to re-cut). Add the
   never-recreate-the-old-name rule to CLAUDE.md.
5. **Docs**: rewrite CLAUDE.md (architecture, the split rule, env vars),
   README (companion + system deps on the first screen, coordinate contract,
   prefetch), CONTRIBUTING, TESTING_*, TROUBLESHOOTING, AGENT_INSTRUCTIONS.
6. **Verify** — the gate for publishing, all of it:
   - `npm test` + `npm run typecheck` green in both packages
   - `scripts/smoke-packed.sh` packs **both** tarballs and installs the
     server from them, verifying it resolves the library from the tarball
     rather than the workspace symlink — the classic way this split breaks
     only for real users
   - `npm run check:companion -- <udid>` against a booted simulator
   - full TESTING_TOOLS.md run against the fixture — the definition of
     "functionally the same"
   - TESTING_SERVER.md — transports and process lifecycle moved files, so it
     is not optional this time
7. **Publish** `simgadget` then `simgadget-mcp` (dependency order); then
   publish `ios-multi-simulator-mcp` one last time as a wrapper — a
   package.json depending on `simgadget-mcp` whose bin re-exports the
   server's entry, so existing client configs keep working unchanged — and
   `npm deprecate` it with a message naming the new package. The wrapper is
   the only place the old env var names must keep working indefinitely,
   which the shim already covers.

### The regression rule

Holds during step 3 and forever after: **a newly discovered bug lands three
things, not one** — the fix, a step added or adjusted in TESTING_TOOLS.md
that would have caught it against the fixture, and a unit test in the library
that catches it in milliseconds. A unit test is only possible when the broken
rule is pure logic; when it is not expressible purely, that is the signal to
extract the decision into a pure function first — which is exactly how
`ax/recovery.ts` came to exist. This is how the existing suite was built
(every rule in `src/ax/` traces to a bug that cost simulator boots to find),
and it is the difference between tests that validate and tests that decorate.

## Decisions register

Kept because the answers still steer development. Everything else that was
in this file — answered one-off questions, superseded sketches, the
phase-by-phase sequencing — is deliberately gone; git has it.

- **Intel / x86_64: no, permanently.** `companion.lock.json` is arm64-only.
  An Intel user on Xcode 26.6 can exist (Apple ships it Universal; Xcode 27
  drops Intel), but the audience is four Mac models on the final
  Intel-supporting OS with a published expiry date. Fail loudly at resolve
  time (`UnsupportedArchitectureError`) and spend nothing more — including on
  the two testing ideas already rejected: `macos-13` runners (real Intel,
  cannot carry Xcode 26.6, so they test *a* companion rather than *this*
  one) and Rosetta smoke tests (prove the slice loads, not that it drives a
  simulator on hardware we do not have).
- **Never recreate `ios-multi-simulator-mcp`** — repo or npm name — under
  this account. Recreation kills the GitHub redirect that every published
  old version's lockfile downloads through. Standing rule, lives in
  CLAUDE.md.
- **One package, two entry points: no.** 14 MB of MCP SDK + zod in front of
  every library user. The dependency asymmetry is the whole reason the split
  is worth its ceremony; the code boundary was already clean.
- **`AXElement` keeps Apple's key names** (`AXLabel`, not `label`). It is the
  source vocabulary, and it keeps the MCP's tool output byte-compatible with
  today's without a translation layer.
- **Handles are not deduplicated per udid.** Recording state and the
  orientation hint are per-handle and the MCP's per-session semantics depend
  on it. The divergence hazard is documented in the coordinate contract.
- **The raw unpruned tree is not public.** No caller of the old code ever
  consumed it for anything but the root rectangle; `screenSize()` serves
  that at the same ~13ms cost. Fewer things frozen forever.
- **`ui_view` has no library equivalent.** Base64-JPEG-in-a-tool-response is
  an MCP wire shape; the library's `screenshot()` options (`resizeTo:
  "points"`, jpeg quality) are what it is built from.
- **Cross-process companion reuse: not in v1.** Socket paths embed pid and
  generation, so a new process cannot reconnect to a survivor; each script
  run pays a ~0.5s companion spawn. A persistent-companion daemon with
  stable sockets is a real design with real staleness hazards — and the HTTP
  server already *is* that daemon.
- **The `process.on("exit")` companion reaper stays**, with its header
  rewritten in host-agnostic terms. It reaps *companions*, never simulators —
  a script's simulator keeps running, state intact, after the script exits.
  `releaseCompanion()` is the tidy path; the hook is the backstop (`'exit'`
  never fires on an unhandled fatal signal).
- **Simulator lifecycle: verbs in, policy out.** The library gets explicit
  list/create/boot/shutdown/delete with the hard-won knowledge folded in
  (newest-first devicetype ordering, latest-runtime lookup, the BOOT_BUG.md
  driveability wait inside `boot()`). Nothing implicit ever destroys a
  simulator; ownership and cleanup-on-exit are `simgadget-mcp` policy.
- **`boot()`/`waitReady()` do not throw on timeout.** The simulator exists
  either way; a throw discards the handle and the udid with it. The MCP's
  55s honest-return behaviour (return the UDID, say "poll") is built on
  exactly this, and it predates the library for a measured reason: an MCP
  client cancels a long call, and a cancelled call tells the caller nothing.
- **Recovery state is udid-keyed, not per-handle** (decided 2026-08-16,
  resolving a contradiction between "state moves into the handle" and
  "handles are not deduplicated"). `hasAnsweredAccessibility`, the recovery
  cooldown and the in-flight dedup are facts about a simulator; per-handle
  copies would let two handles on one udid each order a bridge restart —
  losing the dedup that exists because a wedge presents as several
  simultaneous failures. Internal registry, reached through the handle,
  behind the deps seam (so tests drive the cooldown via a fake clock),
  cleared by `delete()`.
- **Portrait point dimensions come from `describe`** (decided 2026-08-16) —
  the one piece of the coordinate contract that is new code rather than a
  port. See the contract section; contract check #9 is its gate.
- **`deviceType` is a field on the handle, not a lookup** (decided
  2026-08-21, found by agent A while writing `render.ts`). `start_simulator`'s
  answer names the model — an agent asks for `"iPhone"` and the reply is where
  it learns which iPhone it got — and `createSimulator` resolves exactly that
  on its way to `simctl create` and used to drop it. Nothing downstream can
  recover the *name* from a udid: `SimInfo` carries `deviceTypeIdentifier`
  only, and at the cost of a `simctl list`. So the creator keeps what it
  already knew, and an attached handle says `undefined` rather than paying for
  a half-answer nobody asked for. Additive: no existing signature changed.
- **`showWindow()` is on the handle** (decided 2026-08-20, from the step-3
  planning pass). The MCP's resume path raises the window of a simulator that
  is already up; before this, the only thing in the library that ran `open -a
  Simulator.app` was `boot()`, which then charges the full driveability
  ladder — and `BOOT_SETTLE_MS` is unconditional, so a sub-second resume
  became an eight-second one on the call an agent makes most after a
  disconnect. The two alternatives were rejected on the same ground: a fast
  path in the boot ladder means retiming a wait that sits underneath
  BOOT_BUG.md's unexplained wedge, and accepting the eight seconds is wrong
  where users feel it. `boot()` now calls `showWindow()` rather than
  repeating the line.
