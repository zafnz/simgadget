The generated reference for the `simgadget` package: every exported function,
class, interface and type alias, with its full type and the documentation
written beside it in the source. It is rebuilt from `src/index.ts` on each
deploy.

`src/index.ts` is also the package's only entry point. The `exports` map in
`package.json` resolves that module and nothing else, so a path such as
`simgadget/build/idb/client.js` does not resolve regardless of the file layout.
Anything absent from this reference cannot be imported.

An introduction in prose is at
[simgadget.dev/library.html](https://simgadget.dev/library.html). To drive
simulators from an AI agent rather than from code, see
[simgadget-mcp](https://simgadget.dev/mcp.html).

## Where to start

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

CommonJS works the same way:
`const { createSimulator } = require("simgadget")`.

Nothing in the library deletes a simulator except a `delete()` written by the
caller.

Three functions return a `Simulator`:

- `createSimulator(opts?)` creates a device on the newest installed iOS runtime
  and, by default, boots it and waits until accessibility answers. It does not
  throw when that wait runs out; read `sim.lastBoot` for the outcome.
- `attachSimulator(udid)` adopts a simulator that already exists. It checks the
  device is present. It does not boot it or probe it; call `waitReady()` if it
  needs to be driveable.
- `listSimulators()` reports every simulator `simctl` knows about, without
  creating or attaching anything.

The rest of the API is on `Simulator`: reads (`describeScreen`, `findByLabel`,
`findByIdentifier`, `describePoint`, `screenSize`), actions (`tap`, `typeText`,
`swipe`, `pressButton`), lifecycle (`boot`, `waitReady`, `shutdown`, `delete`),
apps (`installApp`, `launchApp`), orientation (`rotate`, `detectOrientation`)
and capture (`screenshot`, `startRecording`, `stopRecording`).

The fourth exported function, `prefetchCompanion`, returns the path to the
pinned `idb_companion` binary, downloading it if the cache is cold. The
`simgadget prefetch` command does the same from a shell.

## Conventions

These apply throughout the API, and none of them is visible in the types.

### Coordinates are logical points in the current orientation

Arguments to `tap`, `swipe` and `describePoint`, and the frames inside every
`AXElement`, are logical points in the orientation the interface is currently
displaying. This is the space the accessibility tree reports, and the space
visible on screen.

The companion requires portrait-space coordinates. `tap`, `swipe` and
`describePoint` convert to portrait on the way in and back on the way out, so a
landscape tap at (162, 352) is reported as (162, 352).

Screenshots are the exception. `simctl` captures in physical portrait whatever
the rotation, so `screenshot()` rotates the image to match the interface and
reports the `orientation` it matched. The image is measured in pixels, not
points; pass `resizeTo: "points"` to compare it against coordinates.

### Actions return the outcome

An action reports what happened, not what was asked for. `tap` returns the
element it resolved, which kind of action it performed (`acted`) and, for a
toggle, the state read back afterwards. `rotate` returns the orientation the
interface adopted, which is not always the one requested. Applications decline
orientations, and no Face ID iPhone adopts `upside_down`.

`swipe` and `typeText` return `void`. The companion acknowledges both and
reports nothing further, so there is no outcome to return.

### Lookups return null; actions throw

`findByLabel`, `findByIdentifier` and `describePoint` return `null` when the
lookup finds nothing. A miss is an ordinary result.

An action that cannot proceed without the element throws instead. `tap({label})`
checks the touch will reach the element before sending it, so a control that is
covered, disabled or scrolled out of view produces an error rather than a touch
that lands nowhere.

### Errors carry a code

Every error extends `SimGadgetError` and carries a `code` from the `ErrorCode`
union. Subclasses add a payload where there is one to inspect:
`DeviceTypeNotFoundError` carries the list of available device types,
`TapObstructedError` carries the obstructing element, `UntypeableTextError`
carries the offending characters.

Branch on `code`, not on the message. Messages name no tool, URL or remediation
specific to a caller, and can change between releases.

## Requirements

macOS on Apple Silicon: iOS simulators are macOS-only and the pinned companion
is arm64-only. Xcode with at least one iOS runtime installed. Node.js 18 or
newer.

`idb` and `idb_companion` do not need to be installed. The package resolves a
pinned, checksum-verified companion build and caches it under
`~/Library/Caches/simgadget`.

## Elsewhere

- [simgadget.dev/library.html](https://simgadget.dev/library.html) — the same
  API in prose, grouped by task
- [TROUBLESHOOTING.md](https://github.com/zafnz/simgadget/blob/main/TROUBLESHOOTING.md)
  — failures that are environmental rather than API misuse
- [simgadget-mcp](https://simgadget.dev/mcp.html) — the MCP server built on this
  library, for driving simulators from an AI agent
- [CONTRIBUTING.md](https://github.com/zafnz/simgadget/blob/main/CONTRIBUTING.md)
  — development setup, for changing the library rather than using it
