# SimGadget — website copy

Draft copy for the marketing site. Written to be lifted more or less verbatim:
the landing page sells both products, then one section each for the library and
the MCP server. Every number in here traces to something measured in this
repository — see "Claim sourcing" at the end before you publish any of it.

---

# Landing page

## Hero

> ### Drive an iOS simulator like you mean it.
>
> SimGadget boots simulators, reads the accessibility tree, and taps controls by
> name — from TypeScript, or from any AI agent that speaks MCP. No Python, no
> Homebrew, no four-year-old tooling.
>
> ```bash
> npm install simgadget
> ```
> ```bash
> npx -y simgadget-mcp
> ```

**Alternate hero lines** (pick one, keep the rest for section headers and social
cards):

- *iOS simulator automation that answers with facts, not "success".*
- *One `npm install`. No Python, no brew, no idb.*
- *The simulator automation stack, rebuilt on a companion from this decade.*
- *Tap "Sign Up". That's the whole API.*

## The one-line pitch

**SimGadget is a TypeScript library for driving iOS simulators, and an MCP
server built on it that lets a fleet of AI agents each drive their own
simulator at once.**

## Why it exists

Everything else in this space shells out to the Python `idb` CLI, or to
Homebrew's `idb_companion` — **last released in 2022** — or to `xcrun simctl`,
which cannot read accessibility at all. That is why simulator automation has
the reputation it has: taps that report success and change nothing, elements
inside tab bars that are simply invisible, coordinates that silently invert the
moment you rotate the device.

SimGadget ships its own `idb_companion`, built from current upstream source
against current Xcode, pinned by sha256 and fetched on first use. Everything
above it was rewritten on top of that: a direct gRPC client with no Python in
the loop, a tap that verifies it landed, a coordinate space that survives
rotation, and automatic recovery from the accessibility wedge that used to cost
you a whole simulator.

## Four things worth the switch

### ⚡ Built for speed, and measured

A tap costs **~1.2 ms** of wire time instead of the **~165 ms** it takes to
spawn a Python process for every single call. Finding a control by name is
**~13 ms** on the fast path. Reading a whole screen is **~350 ms**. Asking what
is at a point is **~10 ms**.

The whole design is shaped by that: `tap({label: "Sign Up"})` resolves the
element *on the simulator* and operates it, so an agent never pulls down a
kilobyte-scale tree just to find one button — a few hundred bytes instead of
7–10 KB.

### 📦 Almost zero dependencies

The library has exactly **two** npm runtime dependencies: `@grpc/grpc-js` and
`@bufbuild/protobuf`. That's it. No test framework leaking into your install,
no CLI wrappers, no 14 MB of transitive weight.

That is also *why* there are two packages. The MCP SDK and Zod are 14 MB
between them, and a library that taps a simulator has no business putting them
in front of you. Install `simgadget` and you get a library; install
`simgadget-mcp` and you get the server, which depends on the library.

### 🔧 A companion from this decade

Facebook's last `idb` release was 2022. SimGadget pins a build from current idb
source against Xcode 26.6 / Swift 6.3.3, sha256-verified, downloaded once and
cached.

This is not housekeeping — it is what makes the rest possible. Tap-by-name
doesn't work on the old companion. Neither does reading the contents of a tab
bar, a nav bar or a toolbar. There is deliberately **no fallback to whatever
`idb_companion` is on your `$PATH`**, because an old companion doesn't reject
request fields it doesn't understand: it ignores them and answers anyway, so a
fallback returns results that are wrong but entirely plausible.

### 🐛 Bugs nothing else has fixed

Each of these cost real debugging time to find, and none of them are fixed
anywhere else:

- **Instant taps don't register.** Every tap in every tool built this way is a
  touch-down and touch-up in the same instant, and UIKit doesn't reliably see
  one. Measured against a real switch: **5 of 12** instant taps actuated it,
  **12 of 12** with a 0.1s hold. SimGadget always holds — well under UIKit's
  0.5s long-press threshold, so nothing that was a tap becomes one.
- **Taps that can't land now say so.** A ~10 ms hit-test before a ~110 ms tap
  catches the element that is covered, below the fold, or scrolled out of view.
  In our own test fixture, tapping a stepper by name used to focus the toolbar
  search field, open the keyboard, and report `Tapped successfully` — with
  every frame involved perfectly correct.
- **Switches were never tappable at all.** A switch's accessibility frame
  routinely spans its whole row, so its centre is the gap between label and
  control. Tapping the centre actuated nothing: **0 of 6** on the current
  companion, **0 of 8** on the 2022 one. SimGadget operates a toggle the way
  VoiceOver does, and reports the state it read back — `off -> on`.
- **System sheets landed taps 476 points away.** iOS draws autofill sheets,
  photo pickers and share sheets from a separate process, with frames measured
  from the hosting window rather than the screen. Tapping "Fill Strong
  Password" resolved the label, tapped, reported success, and pressed a
  different button entirely. SimGadget rebases hosted subtrees into screen
  coordinates.
- **Tab bars, nav bars and toolbars were empty.** Apple's accessibility
  translator omits their children, so every control inside one was invisible to
  a lookup that hit-tested perfectly well. SimGadget reads the app's real view
  hierarchy.
- **One element, one name.** Two accessibility backends named the same control
  differently — `SearchField` vs `TextField`, `Switch` vs `CheckBox`, `Button`
  vs `RadioButton`. On a screen with one of every control kind: 17 elements
  described both ways, **five disagreements, now zero.**
- **The boot wedge.** Roughly **one in four** freshly created simulators came
  up rendering fine, responding to taps, answering `describe` — while every
  accessibility read failed forever, blaming a fullscreen dialog that did not
  exist. SimGadget detects it and restarts the guest's CoreSimulator bridge;
  the simulator answers again in about five seconds with its apps intact.
  Previously the only cure was destroying the simulator.
- **Rotation inverted your coordinates.** idb reports frames in rotated logical
  space but accepts input in portrait space, and its orientation enum uses
  UIKit's *interface* vocabulary while the Simulator's own menus name the
  *device* — and UIKit crosses the two landscapes on purpose. SimGadget owns
  that translation and reports the orientation the interface **actually
  adopted**, because an app can decline the one you asked for.

## Two packages

| | `simgadget` | `simgadget-mcp` |
|---|---|---|
| **For** | TypeScript / JavaScript code | AI agents (Claude Code, Cursor, anything MCP) |
| **Install** | `npm install simgadget` | `npx -y simgadget-mcp` |
| **Runtime deps** | 2 | 4 |
| **Gives you** | `Simulator` handle, typed results, typed errors | 17 tools, sessions, multi-agent isolation |

**Requirements, stated up front:** macOS on Apple Silicon, Xcode with iOS
simulators, Node 18+. The library also uses `xcrun simctl`, `sips` and `tar`,
which ship with macOS. You do **not** install `idb_companion` — SimGadget
fetches a pinned one on first use, or `npx simgadget prefetch` if you'd rather
front-run the download in CI.

---

# Section: SimGadget — the library

## Header

> ## The simulator, as an object.
>
> ```bash
> npm install simgadget
> ```
>
> Two runtime dependencies. Full TypeScript types. Every action answers with
> what actually happened.

## The pitch

You have a shell and a Node runtime. You don't need a protocol between you and
a simulator.

```ts
import { createSimulator } from "simgadget";

const sim = await createSimulator({ deviceType: "iPhone 16 Pro" });
await sim.installApp("./build/MyApp.app");
await sim.launchApp("com.example.myapp");

await sim.tap({ label: "Sign Up" });
await sim.typeText("test@example.com");

const shot = await sim.screenshot({ format: "png", path: "./signup.png" });
```

`createSimulator` doesn't return until the simulator is genuinely driveable —
not when `simctl boot` returns, which is a minute or more early. Every piece of
hard-won knowledge about that boot is folded into the call.

## No success strings

Every action returns data. This is the design rule the whole API is built on,
and it's the difference between a script you trust and one you babysit.

```ts
const result = await sim.tap({ label: "Sound" });
// { acted: "activation", element: {...}, before: "off", after: "on" }
```

A toggle tells you the state it read back. A touch tells you where it landed
and which element it resolved. A rotate tells you which orientation the
interface *adopted*, not which one you asked for. Where there is genuinely
nothing to read back — `swipe`, `typeText` — the return is `void`, and that's
honest rather than lazy.

## Failures you can branch on

No caller ever regexes an error message. Every failure worth acting on is a
typed error with a `code` and a payload:

```ts
try {
  await sim.tap({ label: "Submit" });
} catch (e) {
  if (e.code === "tap-obstructed") {
    // e.element  — what you asked for
    // e.obstruction — what's actually in the way
    // e.point — the logical coordinates that were probed
  }
}
```

The taxonomy covers the whole surface: `element-not-found`,
`element-disabled`, `tap-obstructed`, `toggle-needs-plain-tap`,
`untypeable-text`, `not-answering`, `accessibility-unreadable`,
`simulator-not-found`, `device-type-not-found`, `companion-download-failed`,
`unsupported-architecture`, and the rest — each with the payload you'd need to
recover.

And "absent" is an answer, not an exception: `findByLabel`, `findByIdentifier`
and `describePoint` return `null` for a clean miss.

## What you get

- **Lifecycle** — `listSimulators`, `createSimulator`, `attachSimulator`, and
  on the handle: `state`, `boot`, `waitReady`, `shutdown`, `delete`.
- **Reading** — `describeScreen` (complete, pruned, in screen coordinates),
  `findByLabel`, `findByIdentifier`, `describePoint`, `screenSize`.
- **Acting** — `tap` (by label or coordinate), `swipe`, `typeText`,
  `pressButton`.
- **Orientation** — `rotate`, `detectOrientation`, and a coordinate contract
  that is written down rather than assumed.
- **Capture** — `screenshot` (rotated to match the interface, because simctl
  captures physical portrait regardless), `startRecording`, `stopRecording`.
- **Escape hatches you shouldn't need** — `restartBridge`,
  `releaseCompanion`.

Nothing in the library ever destroys a simulator except a `delete()` you wrote
yourself. Ownership and cleanup policy belong to whoever is calling.

## Honest about the edges

The coordinate contract, stated plainly rather than buried:

> Coordinates are interpreted in the space of your most recent describe.
> `tap({x, y})` works as long as nothing *external* has changed the simulator
> since your last describe or rotate. `tap({label})` resolves the element
> inside the call, so it's immune to prior rotations — with one footnote: an
> external flip between the two landscapes changes nothing a describe can see,
> so call `detectOrientation()` to resync.

---

# Section: SimGadget MCP — for agents

## Header

> ## Give every agent its own iPhone.
>
> ```bash
> npx -y simgadget-mcp
> ```
>
> One server. Many agents. Many simulators. Nobody steps on anybody.

## The pitch

Every tool takes an `id` naming your session, and each session owns exactly one
simulator. Three agents, three ids, three simulators, one server process — and
because the state lives in the server rather than the client, a simulator
survives its agent disconnecting. Call `start_simulator` again with the same
id and you resume where you left off.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Agent A    │  │   Agent B    │  │   Agent C    │
│  (id: "qa1") │  │  (id: "qa2") │  │  (id: "dev") │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       └────────────┬────┴────┬────────────┘
              ┌─────┴─────────┴──────┐
              │    simgadget-mcp     │
              │   (single process)   │
              └──┬─────────┬──────┬──┘
          ┌──────┴──┐ ┌────┴───┐ ┌┴────────┐
          │ iPhone  │ │ iPad   │ │ iPhone  │
          │ 16 Pro  │ │ Air    │ │ 16 Pro  │
          │ (qa1)   │ │ (qa2)  │ │ (dev)   │
          └─────────┘ └────────┘ └─────────┘
```

This is the part that doesn't exist elsewhere. Stdio-transport MCP servers give
every client its own private process, which means every agent gets its own
private world and no way to share one. SimGadget defaults to HTTP for exactly
this reason. (`--stdio` is still there if you want the old shape.)

## Setup, in full

```bash
npx -y simgadget-mcp
```

```bash
claude mcp add --transport http simgadget http://127.0.0.1:8008/mcp
```

Or for a config-file client (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "simgadget": { "type": "http", "url": "http://127.0.0.1:8008/mcp" }
  }
}
```

There is no step three. No `pipx install fb-idb`, no `brew install
idb-companion`, no Xcode command-line archaeology. Agent running in a
container? The simulators live on the host, so run the server there and point
the container at `host.docker.internal` — which is allowlisted out of the box,
along with Podman's equivalent.

## Designed to be easy for a model to use

An agent's biggest costs are tokens and wrong turns. Every tool is shaped
against both.

- **Tap by name.** `ui_tap { label: "Sign Up" }` — the simulator resolves the
  element and operates it. ~340 bytes, versus 7–10 KB for a screen tree. The
  model never sees a coordinate.
- **Refusals are the useful answer.** A control that is covered, disabled or
  scrolled out of view is *refused*, naming what's in the way, rather than
  silently missed. That turns a whole class of "the test passed but nothing
  happened" into an error the agent can actually react to.
- **Every reply names what it did.** `Tapped "Toolbar Button" (Button) at
  (102, 822).` `Toggled Sound off -> on.` Substring matching means the first
  hit isn't always the one you meant, and naming it puts that where the model
  notices immediately.
- **Misses are ordinary answers.** `ui_find` reports "not found" as a result,
  not an error, so an agent can branch instead of spiralling.
- **`start_simulator` doesn't return until the simulator answers** — and if it
  runs out of budget it says so and hands back the UDID, rather than being
  killed mid-wait by the client's timeout and telling you nothing.
- **The server tells the agent how to use it.** Tool descriptions and server
  instructions are written for a model, including when *not* to reach for the
  expensive tool.

**Pro tip worth putting on the page:** you don't need a frontier model for
this. Cheap fast models are perfectly good at navigating an app and comparing
screenshots — the tools do the hard part. Haiku is nearly fast enough to record
demo videos in real time.

## The tools

| Tool | Does |
|---|---|
| `start_simulator` | Create, boot and open a simulator for this session |
| `destroy_simulator` | Shut it down and delete it (or just detach, if attached) |
| `attach_simulator` | Adopt an already-booted simulator by UDID |
| `ui_tap` | Operate an element by name, or tap at coordinates |
| `ui_find` | Resolve one element by label, text or identifier |
| `ui_describe_all` | The whole screen's accessibility tree, pruned to what you can act on |
| `ui_describe_point` | What's at these coordinates |
| `ui_type` | Type text |
| `ui_swipe` | Swipe |
| `ui_view` | Compressed screenshot, inline |
| `rotate` | Rotate, then report what the interface actually adopted |
| `detect_rotation` | Re-probe orientation and fix the coordinate mapping |
| `screenshot` | Save a screenshot to a file |
| `record_video` / `stop_recording` | Record the screen |
| `install_app` / `launch_app` | Install and launch |

## Safe by default

The HTTP transport binds to `127.0.0.1`, checks `Host` headers against an
allowlist so a web page you happen to visit can't drive your simulators, and
tells you exactly what it rejected and how to permit it. Owned simulators are
cleaned up when the server exits, so a day's work doesn't leak twenty
simulators.

---

# Supporting copy

## FAQ

**Do I need to install idb or idb_companion?**
No. SimGadget fetches a pinned, sha256-verified companion on first use and
caches it. A Homebrew companion on your `$PATH` is deliberately ignored — see
above for why a silent fallback would be worse than none.

**Do I need Python?**
No. SimGadget speaks gRPC to the companion directly. That's where most of the
speed comes from.

**Intel Macs?**
No — Apple Silicon only, and it fails loudly at startup naming your
architecture rather than timing out thirty seconds later.

**Can I use it without an AI agent?**
That's what the library is for. `npm install simgadget`.

**Can I use it without writing code?**
That's what the MCP server is for. `npx -y simgadget-mcp`.

**Is this the same as `ios-simulator-mcp`?**
It started as a fork of Joshua Yoes' `ios-simulator-mcp` and has diverged
substantially — different transport, different lifecycle model, its own
companion, and a library underneath. The foundational work is his and is
credited.

## Social / meta description

> SimGadget drives iOS simulators from TypeScript and from AI agents over MCP.
> Two runtime dependencies, a current `idb_companion` instead of the 2022 one,
> taps that verify they landed, and one server that lets many agents each drive
> their own simulator. `npm install simgadget`.

## Footer credit

Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) —
all foundational work by Joshua Yoes. MIT licensed.

---

# Claim sourcing

For whoever builds the site: every number above comes from somewhere in this
repository, so it can be defended. Check the starred ones before launch.

| Claim | Source |
|---|---|
| ~1.2 ms tap wire time / ~165 ms Python spawn | CHANGELOG 2.0.0 ("~165 ms to ~3 ms"), README ("~1.2 ms") |
| ~13 ms find, ~330 ms fallback, ~350 ms full screen, ~10 ms point | SIMGADGET.md API docs, CHANGELOG 2.0.0 known issues |
| 5/12 → 12/12 tap hold, 1/10 → 10/10 on 2022 companion | CHANGELOG 2.2.0 |
| 0/6 and 0/8 switch centre taps | CHANGELOG 2.2.0 |
| 476 points, hosted-sheet offset | CHANGELOG 2.2.0 |
| 17 elements, 5 disagreements → 0 | CHANGELOG 2.2.0 |
| 1-in-4 boot wedge, ~5 s bridge-restart recovery | CHANGELOG 2.0.3, BOOT_BUG.md |
| 340 bytes vs 7–10 KB | README |
| 2 runtime deps; 14 MB of MCP SDK + zod | SIMGADGET.md package table and Decisions register |
| Xcode 26.6 / Swift 6.3.3 companion pin | SIMGADGET.md, `companion.lock.json` |
| 4 runtime deps for `simgadget-mcp` | grpc + protobuf + MCP SDK + zod |

**Verify before publishing:**

- ★ The default port. The copy uses `8008`, which is the current default;
  the old README's examples used `54321`. Pick one and make the site
  consistent with the shipped default.
- ★ `claude mcp add` command syntax against the current Claude Code CLI.
- ★ Dependency counts, once both packages are actually published — quote
  what `npm install` reports, not what the spec predicts.
- ★ The Xcode/Swift version in `companion.lock.json` at release time.
- ★ Whether `npx simgadget prefetch` shipped in v1 as specced.
- ★ All performance numbers were measured against the pre-split server. Re-run
  a couple against the shipped library so the site quotes the shipped thing.
