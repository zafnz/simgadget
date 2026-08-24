<a href="https://simgadget.dev"><img src="https://raw.githubusercontent.com/zafnz/simgadget/main/website/assets/banner.png" alt="SimGadget" width="100%"></a>

# simgadget

**The simulator, as an object.** Boot an iOS simulator, read its accessibility
tree, and tap controls by name — from TypeScript or JavaScript, with two runtime
dependencies and no Python anywhere in the loop.

```bash
npm install simgadget
```

You do not need to install `idb` or `idb_companion`. SimGadget
brings its own.

- **Website:** [simgadget.dev/library.html](https://simgadget.dev/library.html)
- **Driving simulators from an AI agent instead?** That is
  [`simgadget-mcp`](https://www.npmjs.com/package/simgadget-mcp), an MCP server
  built on this library.

---

## Three lines to a booted simulator

```js
import { createSimulator } from "simgadget";

// Creates on the latest installed iOS runtime and waits until the device is
// actually driveable — `simctl boot` returns a minute before accessibility
// answers. Does not throw on a slow boot; ask the handle how it went.
const sim = await createSimulator({ deviceType: "iPhone 16 Pro" });
console.log(sim.udid, sim.lastBoot); // { ready: true, waitedMs: 41000, ... }

await sim.installApp("./build/MyApp.app");
await sim.launchApp("com.example.myapp"); // -> { pid: 18900 }

// Resolve the element, refuse it if disabled or covered, then touch it.
const result = await sim.tap({ label: "Sign Up" });
// { acted: "touch", x: 201, y: 442, count: 1, durationSeconds: 0.1, element: {...} }

await sim.tap({ label: "Email" });
await sim.typeText("test@example.com");

// null is the ordinary "not on screen" answer, not an error.
const banner = await sim.findByLabel("Welcome back");

await sim.screenshot({ path: "/tmp/signup.png" });
await sim.delete();
```

CommonJS works the same way: `const { createSimulator } = require("simgadget")`.

Nothing in the library ever destroys a simulator except a `delete()` you wrote
yourself.

## Requirements

- **macOS on Apple Silicon.** iOS simulators are macOS-only and the pinned
  companion is arm64-only.
- **Xcode**, with at least one iOS runtime installed.
- **Node.js 18+.**


## Every action answers with what happened

There are no success strings. `"Tapped successfully"` is the bug class this
library was reshaped to kill, because a tap that hit the wrong control, a tap
that landed 40% of the time and a tap that actuated nothing each reported that
same cheerful string.

```js
const result = await sim.tap({ label: "Sound" });
// {
//   acted:   "activation",
//   element: { AXLabel: "Sound", type: "Switch", … },
//   before:  "off",
//   after:   "on",
// }
```

- **A toggle tells you the state it read back** — and when it cannot read it
  back, it says so rather than claiming success.
- **A touch tells you where it landed** and which element it resolved.
- **A rotate tells you which orientation the interface adopted**, not which one
  you asked for. Apps decline orientations; no Face ID iPhone ever adopts
  `upside_down`.
- **A failure is a typed error** with a `code` and a payload, so no caller ever
  regexes a message.
- **"Absent" is an answer, not an exception.** `findByLabel`, `findByIdentifier`
  and `describePoint` return `null` for a clean miss. Actions that cannot
  proceed without the element throw.
- **Where there is genuinely nothing to read back** — `swipe`, `typeText` — the
  return is `void`, and that is honest rather than lazy.

---

## API

A short summary of the public surface. The authoritative signatures — every
option, default and thrown error — are in the generated reference at
[simgadget.dev/api](https://simgadget.dev/api/).

### Top-level functions

Everything else hangs off a `Simulator` handle, which these return.

| Signature | Description |
|---|---|
| `listSimulators(): Promise<SimInfo[]>` | Every simulator `simctl` knows about. |
| `createSimulator(opts?: CreateOptions): Promise<Simulator>` | Creates on the latest available iOS runtime and, by default, boots and waits until actually driveable. Does not throw on a boot that timed out — the simulator exists either way; inspect `sim.lastBoot`. Throws `DeviceTypeNotFoundError` carrying the available list. |
| `attachSimulator(udid: string, opts?: AttachOptions): Promise<Simulator>` | Adopts an existing simulator. Verifies it exists; does not probe, does not boot, claims no knowledge of orientation. Call `waitReady()` next if you need it driveable. |
| `prefetchCompanion(onProgress?): Promise<string>` | Resolves — downloading if necessary — the pinned `idb_companion` and returns its absolute path. Also exposed as `npx simgadget prefetch`. |

`CreateOptions`: `deviceType` (substring match against `simctl devicetypes`,
newest match wins, default `"iPhone"`), `name`, `boot` (default `true`),
`budgetMs` (default `55_000`), `onLog`.

### Simulator — lifecycle

Verbs in, policy out. Nothing implicit ever destroys a simulator.

| Member | Description |
|---|---|
| `readonly udid: string` | The simulator's UDID. |
| `readonly name: string` | Its `simctl` device name. |
| `readonly lastBoot?: ReadyResult` | How the last boot or `waitReady` went. Undefined on a fresh attach. |
| `state(): Promise<SimulatorState>` | Current `simctl` state. Cheap. |
| `boot(opts?): Promise<ReadyResult>` | Boots and waits until driveable. Does not throw on timeout. An already-booted simulator still performs the wait. |
| `waitReady(opts?): Promise<ReadyResult>` | Waits, without booting, until an accessibility read answers with a real frame. Costs nothing when already up. |
| `showWindow(): Promise<void>` | Opens the Simulator app onto this device. |
| `shutdown(): Promise<void>` | Shuts down. The simulator still exists. |
| `delete(): Promise<void>` | Shuts down and deletes. Stops the companion first and blocks respawn for this udid. The handle is stale afterwards; every method then throws `SimulatorNotFoundError`. |

### Simulator — apps

| Member | Description |
|---|---|
| `installApp(appPath: string): Promise<void>` | An `.app` directory or an `.ipa`. Throws `app-bundle-not-found` before calling `simctl` if the path does not exist. |
| `launchApp(bundleId, opts?): Promise<{ pid: number \| null }>` | `opts.terminateRunning` relaunches an app that is already running. |

### Simulator — reading

Absent is `null`, not a throw.

| Member | Description |
|---|---|
| `describeScreen(): Promise<ScreenRead>` | The complete tree — AXBridge backend, so tab bars, nav bars and toolbars have their contents — with remote-hosted subtrees rebased into screen coordinates, pruned to elements you can act on. ~350 ms. Runs the full recovery ladder internally and throws `AccessibilityUnreadableError` only when both cures failed. |
| `screenSize(): Promise<{ width, height }>` | Logical screen dimensions from the cheap (~13 ms) read. Refreshes the orientation aspect hint as a side effect. |
| `findByLabel(label): Promise<AXElement \| null>` | Resolves one element by the text you know it by. Fast marker query first (~13 ms), then identifier, then the AXBridge tree walk with typography folding — curly quotes, dashes, non-breaking spaces. |
| `findByIdentifier(identifier): Promise<AXElement \| null>` | Exact match on the accessibility identifier. |
| `describePoint(x, y): Promise<AXElement \| null>` | The element at a logical-space point. Hit-tests (~10 ms). Corrects remote-hosted frames internally. |

### Simulator — acting

`tap` is two different verbs under one name, because callers think of them as one.

| Member | Description |
|---|---|
| `tap(target: TapTarget, opts?: TapOptions): Promise<TapResult>` | `{x, y}` is a literal touch at your coordinates, delivered with the 0.1 s floor. No resolution, no verification — coordinates are you saying where.<br><br>`{label}` is "find this and operate it": resolve (`ElementNotFoundError`), refuse disabled controls (`ElementDisabledError`), route toggles through accessibility activation with state read-back, refuse hold and multi-tap on toggles (`ToggleGestureError`), hit-test the centre and refuse if the touch would not land (`TapObstructedError`, naming the obstruction), then touch. |
| `swipe(from, to, opts?): Promise<void>` | Logical-space swipe. Void because the companion acks delivery and knows no more than you do. `opts`: `durationSeconds`, `delta`. |
| `typeText(text: string): Promise<void>` | Printable ASCII plus newline, as key events. Throws `UntypeableTextError` listing the offending characters before any event goes out — never a half-typed string. |
| `pressButton(button, opts?): Promise<void>` | `"home"` \| `"lock"` \| `"side-button"` \| `"siri"` \| `"apple-pay"`. `home` is the only way to leave an app without launching another. |

`TapOptions`: `durationSeconds` — a floor of 0.1 s is always applied, so passing
less changes nothing; above ~0.5 s UIKit reads it as a long press. `count` — 2
is a double-tap.

### Simulator — orientation

| Member | Description |
|---|---|
| `rotate(to: Orientation): Promise<RotateResult>` | Device vocabulary, as the Simulator's own menus use it; the crossed mapping to idb's interface vocabulary is internal. Waits out the animation, then detects what the interface adopted. The result is authoritative for the coordinate space. |
| `detectOrientation(): Promise<Orientation>` | Probes the current orientation (a few hundred ms) and refreshes the hint. Call after something external rotated the simulator. |

### Simulator — capture

| Member | Description |
|---|---|
| `screenshot(opts?: ScreenshotOptions): Promise<Screenshot>` | Always rotated to match the interface orientation — `simctl` captures physical portrait regardless. `resizeTo: "points"` returns the logical dimensions your coordinates live in. |
| `startRecording(path, opts?): Promise<void>` | One recording per handle. Throws `recording-already-active`. |
| `stopRecording(): Promise<{ path: string }>` | Stops and finalizes. Throws `no-active-recording`. |

### Simulator — low level

You should never need these.

| Member | Description |
|---|---|
| `restartBridge(): Promise<void>` | Restarts the guest's CoreSimulator bridge — the wedge cure. The recovery machinery calls this itself; it is public for hosts that want to force it. |
| `releaseCompanion(): Promise<void>` | Stops this simulator's companion process. The exit hook does this anyway; long-lived hosts get tidier teardown. The simulator keeps running, state intact. |

---

## Types

`AXElement` keeps Apple's key names deliberately — it is the vocabulary of the
source data. It is a closed type: no index signature, so a caller reading
`element.role` learns from the compiler that there is no such field.

```ts
interface Frame { x: number; y: number; width: number; height: number }

interface AXElement {
  AXLabel?: string;
  AXValue?: string | number;
  AXUniqueId?: string;
  type?: string;        // normalised role: "Button", "Switch", "SearchField", …
  enabled?: boolean;
  frame?: Frame;
  children?: AXElement[];
}

type Orientation = "portrait" | "upside_down"
                 | "landscape_left" | "landscape_right" | string;

type SimulatorState = "Booted" | "Shutdown" | "Booting"
                    | "Shutting Down" | "Creating" | string;

interface SimInfo {
  udid: string; name: string; state: SimulatorState;
  deviceTypeIdentifier: string; runtimeIdentifier: string;
}

interface ReadyResult {
  ready: boolean; waitedMs: number;
  recoveryTried: boolean; recovered: boolean;
}

interface ScreenRead {
  elements: AXElement[];              // [0] is the screen root
  screen: { width: number; height: number };
}

type TapTarget = { x: number; y: number } | { label: string };

type TapResult =
  | { acted: "touch"; x: number; y: number;
      count: number; durationSeconds: number; element?: AXElement }
  | { acted: "activation"; element: AXElement;
      before?: string | number; after?: string | number };

interface RotateResult { requested: Orientation; adopted: Orientation }

interface Screenshot {
  data: Buffer; format: string;
  width: number; height: number;      // pixels of the returned image
  orientation: Orientation;
}
```

## Errors

One base class, `SimGadgetError`, with a `code` you branch on. Subclasses exist
only where there is a payload to carry. Messages are host-agnostic: they never
name a tool, a URL, or remediation that assumes a particular caller.

| `code` | Class and payload |
|---|---|
| `unsupported-architecture` | `UnsupportedArchitectureError` — message names the architecture |
| `companion-download-failed` | `CompanionDownloadError` — HTTP failure or checksum mismatch |
| `companion-start-failed` | `CompanionStartError` · `stderrTail: string[]` |
| `simulator-not-found` | `SimulatorNotFoundError` · `udid` |
| `device-type-not-found` | `DeviceTypeNotFoundError` · `keyword`, `available: string[]` |
| `no-ios-runtime` | `SimGadgetError` |
| `not-answering` | `SimulatorNotAnsweringError` · `recoveryTried` — the wedge, after recovery was tried or suppressed by cooldown |
| `accessibility-unreadable` | `AccessibilityUnreadableError` · `verdict: "booting" \| "unrecoverable"` |
| `element-not-found` | `ElementNotFoundError` · `query` |
| `element-disabled` | `ElementDisabledError` · `element` |
| `element-unusable-frame` | `SimGadgetError` — resolved, but no frame to aim at |
| `tap-obstructed` | `TapObstructedError` · `element`, `obstruction`, `point` |
| `toggle-needs-plain-tap` | `ToggleGestureError` · `element`, `gesture: "hold" \| "multi-tap"` |
| `untypeable-text` | `UntypeableTextError` · `characters: string[]` |
| `recording-already-active` | `SimGadgetError` |
| `no-active-recording` | `SimGadgetError` |
| `app-bundle-not-found` | `SimGadgetError` |

## Coordinates

Every coordinate crossing this API is a **logical point** in the *current
interface orientation* — the same space the accessibility tree reports, and what
you see on screen. The portrait-space translation the companion actually
requires is applied inside `tap`, `swipe` and `describePoint`, and never leaks
out: a landscape tap at (162, 352) is reported back as (162, 352), not as the
portrait pair that went over the wire.

Screenshots are the exception you have to know about, and they are handled:
`simctl` captures in physical portrait regardless of rotation, so `screenshot()`
always rotates the image to match the interface, and reports the `orientation`
it matched. Pixels are still pixels, though — use `resizeTo: "points"` if you
want to compare an image against coordinates.

## Configuration

Two environment variables, both about the companion:

| Variable | Description | Default |
|---|---|---|
| `SIMGADGET_COMPANION_PATH` | Custom path to the `idb_companion` binary, used verbatim and ahead of everything else | — |
| `SIMGADGET_COMPANION_CACHE` | Cache root for the downloaded companion | `~/Library/Caches/simgadget` (or `$XDG_CACHE_HOME/simgadget`) |

The former `IOS_SIMULATOR_MCP_*` spelling of each still works, with one
deprecation line on stderr per variable. That fallback goes away two releases
after the rename. `SIMGADGET_IDB_PATH` is a tombstone and throws — there is no
Python `idb` CLI to point at any more.

## More

- **[simgadget.dev/api](https://simgadget.dev/api/)** — the generated API reference: every signature, option, default and thrown error, with a search box
- **[TROUBLESHOOTING.md](https://github.com/zafnz/simgadget/blob/main/TROUBLESHOOTING.md)** — common issues and their solutions
- **[TESTING_LIBRARY.md](https://github.com/zafnz/simgadget/blob/main/docs/testing/TESTING_LIBRARY.md)** — the end-to-end suite: what it covers and what it deliberately does not
- **[CONTRIBUTING.md](https://github.com/zafnz/simgadget/blob/main/CONTRIBUTING.md)** — development setup and the vendored idb submodule
- **[simgadget-mcp](https://www.npmjs.com/package/simgadget-mcp)** — the MCP server built on this library, for driving simulators from AI agents

## License

MIT. Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp)
— all foundational work by Joshua Yoes.
