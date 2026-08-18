# Testing the library

Drives the whole `simgadget` public API against a real simulator, and against
the `testapp/` fixture — the library-level counterpart to
[TESTING_TOOLS.md](TESTING_TOOLS.md), which drives the same fixture through the
MCP tools by hand.

Unlike that plan, this one runs itself:

```bash
npm run test:e2e -w simgadget
```

Roughly 110 seconds, unattended, from a cold start. It creates two throwaway
simulators, deletes them, and leaves nothing behind.

## Why it exists, given there are already 250 unit tests

The unit suite proves the library calls the right things in the right order,
against a fake `idb_companion` that answers instantly and always agrees with
itself. Every case here is one that fake cannot answer, because the thing being
checked belongs to iOS, to the real companion, or to the geometry between them:

- whether the AXBridge read really does see inside a toolbar,
- whether a marker match really is a substring,
- whether the action API really does refuse an element it cannot reach,
- whether a coordinate read off a **landscape** tree really lands where it was
  aimed,
- whether a deleted simulator produces a typed error rather than a
  thirty-second gRPC timeout.

Where the fake encodes a belief about someone else's undocumented binary,
[`scripts/check-companion-contract.mjs`](scripts/check-companion-contract.mjs)
pins that belief directly. This suite is the layer above: it checks that the
library built on those beliefs actually drives a device.

## Layout, and why it is two files

| file | what it owns |
|---|---|
| `packages/simgadget/test/e2e/lifecycle.e2e.mts` | the handle's life: create, boot, list, attach, delete, and being dead afterwards |
| `packages/simgadget/test/e2e/library.e2e.mts` | the ordered journey through every other method, against the fixture |
| `packages/simgadget/test/e2e/support.mts` | skip detection, companion resolution, fixture build, cleanup. Not `*.e2e.mts`, so the runner does not try to run it |

Two files because `node --test` gives each file its own process and a booted
simulator cannot cross that boundary. Two boots (~80s of the ~110s) was weighed
and approved against a shared-udid runner script (SIMGADGET_PLAN.md, "Open
items" 3). The runner is pinned to `--test-concurrency=1`: booting two
simulators at once on one machine is exactly the kind of thing that turns a
suite intermittent, and the cost of serialising is one boot's wall time.

## Rules the suite keeps

These are enforceable, and they are the reason it is safe to run on a machine
that is doing other work:

- **It creates its own simulators and deletes them in `after()`, including on
  failure.** They are named `simgadget-e2e-lifecycle` and `simgadget-e2e-library`
  so a leak is findable: `xcrun simctl list devices | grep -i simgadget` must
  come back empty after a run. `Simulator.delete()` is the proper route;
  `deleteQuietly` in `support.mts` is the backstop for a case that failed
  holding a handle too broken to use.
- **It never touches a simulator it did not create**, and never starts, stops or
  signals a server. The library uses its own socket directory
  (`/tmp/simgadget-<uid>/`), so it cannot collide with the MCP server's
  companions even when both are running.
- **It skips with a reason** off macOS or without Xcode, rather than failing with
  a stack trace out of `xcrun`.
- **It builds the fixture** (`testapp/build.sh`) if `testapp/build/MCPTestApp.app`
  is missing, so it runs from a clean checkout.
- **Assertions are on data, never on prose.** Nothing here matches an error
  message. Every failure is checked by `code` and payload; every success by
  something the app itself reports — its status label, a field's value, a frame
  that moved.
- **The setup for an assertion may be waited for; the assertion may not.**
  `waitFor` exists for things the simulator does on its own schedule (an app
  reaching the foreground, the home animation finishing) and throws when the
  wait does not come good. Nothing under test is ever retried — a tap that lands
  eleven times in twelve is a bug, and a retry is how it ships.

### The companion it uses

`SIMGADGET_COMPANION_PATH`, if set, is honoured. Otherwise `support.mts` looks
for a companion in the **old** cache directory
(`~/Library/Caches/ios-multi-simulator-mcp/companion/`) before letting the
library resolve one for itself. The cache directory was renamed to `simgadget`
this phase, which orphaned a perfectly good 19 MB download; re-fetching it to
run the tests would make the first run slow and network-dependent for no gain.
With neither, the ordinary download path runs — which is also worth exercising
occasionally, by unsetting the variable on a machine with an empty cache.

---

## Part 1 — `lifecycle.e2e.mts`

One simulator, created and destroyed by the file itself. No app is ever
launched.

| case | what it proves | what a failure means |
|---|---|---|
| creates a simulator that is booted and answering | `createSimulator` does not return until the device has served a real accessibility read — `lastBoot.ready` is the boot ladder's verdict, and a caller's next call needs no polling of its own | `ready: false` means the ladder's five measured constants (55s budget, 8s settle, 12s recovery tail…) are no longer enough for this machine or this runtime. Note it does **not** throw: the simulator exists either way, and throwing would discard the handle and the udid with it |
| reports its simctl state | `state()` reaches simctl and parses its JSON | a wrong state usually means `parseDevices` has lost track of simctl's nesting, which changes between Xcode releases |
| appears in `listSimulators()` | a udid this library created is a udid it reports, with the device type keyword having reached simctl | absence means `listSimulators` and `createSimulator` disagree about which runtime bucket a device is in |
| gives a second, working handle | `attachSimulator` adopts a running simulator: same udid, same name, `lastBoot` **undefined** because it booted nothing and must not claim to have, and it drives the device — the same screen through its own companion connection | a handle that constructs but cannot read means the companion manager is keying something per handle that should be per udid |
| refuses to attach to a udid that does not exist | `SimulatorNotFoundError`, carrying the udid | anything else — especially a gRPC timeout — is the failure mode the typed error exists to replace |
| deletes the simulator | `delete()` completes: companion closed first, then shutdown, then delete | see the ordering note in `Simulator.delete()`; a delete that races its own companion respawn leaves a companion attached to nothing |
| every method on the deleted handle throws `SimulatorNotFoundError` | all twenty-three public methods, from one table. The guard is per-method | a method missing `assertNotDeleted` reaches simctl or the companion for a udid that no longer exists, and the answer to that is a thirty-second timeout rather than an error. This is the case that catches a newly added method that forgot |
| the same error on the *other* handle, by both routes out of it | external deletion is mapped wherever it surfaces: a handle whose simulator was deleted underneath it says `SimulatorNotFoundError` in the same words as one that deleted it itself, whether the call went through simctl (`state()`) or over the companion (`describeScreen`, `findByLabel`) | the attached handle's staleness flag is clear, so nothing local knows the device has gone. A `companion-start-failed` here is the bug this case was widened for: a companion spawned for a udid that no longer exists cannot resolve its target and exits, which is true about the companion and silent about the cause. `findByLabel` is in the list because it is the one that could answer `null` instead of throwing — right about a label, wrong about a simulator |
| gone as far as simctl is concerned | the ground truth, read from `simctl list devices -j` rather than from the library | a pass on `delete()` with a device still listed means the delete failed and was swallowed |

## Part 2 — `library.e2e.mts`

One simulator, one running fixture, and **the order is the specification.**
Cases share the screen, and several depend on what the one before left on it —
the status label, the scroll position, the interface orientation. Two ordering
constraints are load-bearing and called out on the cases themselves.

### Reading

| case | what it proves | what a failure means |
|---|---|---|
| installs and launches the fixture | `installApp` and `launchApp` reach simctl, and the app comes up with `status: ready` | an install failure is usually an architecture or runtime mismatch in `testapp/build.sh`, not the library |
| reads a screen including system chrome | the root frame is the logical screen, and `NavButton`, `ToolbarButton`, `ToolbarSwitch`, `ToolbarField` are all in the tree | **this is the AXBridge read working.** Apple's AX translation graph has no parent→child edge into a nav bar or a toolbar, so the cheap default backend's tree stops at the container. A tree with the plain hierarchy and no chrome means `describeScreen` has fallen back to the default backend and every lookup that depends on the fallback will fail below |
| resolves a plain control on the cheap marker path | `findByLabel("Plain Button")` returns one element with a usable frame, and the same element is reachable by identifier — which is what says the lookup ended at the ~13ms marker query rather than paying ~300ms for a tree read | |
| reaches a control inside the toolbar | `findByLabel` resolves `Toolbar Switch` (in the bottom band of the screen), and resolves `Toolbar Search` — an element with **no** `AXLabel` whose identifier (`ToolbarField`) does not contain the string asked for, so *neither* marker query can return it. Only the AXBridge tree walk can | if `Toolbar Search` comes back `null`, the tree fallback is broken or the AXBridge read has regressed. See "What this suite found" for why the *path* is not asserted |
| resolves by accessibility identifier | the exact identifier from `testapp/main.m` resolves, with its label, value and type | |
| matches on visible text where there is no label | the search bar has no `AXLabel` and its visible text in `AXValue`, which is the case the tree fallback's value matching exists for | a `null` here means value matching has been lost, and every search field on iOS becomes unnameable |
| answers a miss with `null` | absent is an answer, not an error (design rule 3), for both lookups, after the full ladder | a throw here means a host has to catch to ask "is this on screen?" |
| hit-tests a point | `describePoint` names the element at a coordinate, in the **tree's** type vocabulary — `reconcileType` is what makes the point read's backend say the same word the tree did | a different `type` for the same element depending which call asked is the inconsistency TODO #58 was closed to prevent |

### Acting

| case | what it proves | what a failure means |
|---|---|---|
| taps a control by name | `acted: "touch"`, the element it resolved, the frame's centre in the caller's own coordinates, and `durationSeconds: 0.1` — the floor that is the difference between a touch actuating 5 times in 12 and 12 in 12. Confirmed by the app's own status line | a `durationSeconds` below 0.1 means the floor has been lost, and taps are unreliable again in a way nothing else notices |
| operates a toggle through accessibility | `acted: "activation"` with `before: "0"` and `after: "1"`. A switch's frame spans its row, so its centre is the gap between label and control and no coordinate can hit it; this is the `AXPress` VoiceOver performs | `acted: "touch"` means the element stopped being recognised as a toggle. `after === before` means activation reached it and it did nothing |
| falls back to a real touch for a toggle the action API cannot reach | `AccessibilityActionRequest` has no `backend` field where the read request does, so a lookup can fall back to AXBridge and an activation cannot: the toolbar switch is findable and not activatable, and handing back to an ordinary touch is what keeps it operable by name | `acted: "activation"` would mean the action API has grown the reach it lacked — welcome news, but the fallback is then untested. **Do not move this case earlier in the file**; see "What this suite found" |
| refuses a disabled control | `ElementDisabledError` with `element.enabled === false`, and the status line unchanged | the fixture's disabled button is wired to an action on purpose: `status: disabled button fired` would mean something activated a control iOS says is off |
| refuses a covered control and names the obstruction | `TapObstructedError` carrying the stepper it aimed at, `ToolbarField` as what is there instead, and the point in logical coordinates | **a pass here is the regression.** Before the hit-test existed, this exact call focused the toolbar's search field, opened the keyboard and reported success. Every frame involved was correct, so no amount of tree work would have caught it |
| refuses a multi-tap aimed at a toggle | `ToggleGestureError` with `gesture: "multi-tap"` | a single tap has an escape (activation); a double-tap does not, so it is refused rather than aimed at the gap |
| types into the focused field | the field's own `AXValue` reads back, and the app reports it | |
| refuses untypeable text before anything goes out | `UntypeableTextError` carrying the distinct offending characters, **and the field still holds what the previous case typed** | the second half is the part only a real device can check: half a string typed into an app is not a failure a caller can undo |
| swipes | the tree moves with the content — the same element, meaningfully higher up | no movement means the gesture arrived as a tap, usually a `delta`/`duration` regression |
| presses HOME | the fixture leaves the foreground and stops appearing in reads | HOME is the only way to leave an app without launching another |

### Orientation, capture

| case | what it proves | what a failure means |
|---|---|---|
| rotates to landscape, and a landscape coordinate lands | `adopted: "landscape_left"` (read back, never assumed); the screen's dimensions swap; and a coordinate taken straight out of the landscape tree, handed straight back, reaches the element it pointed at | **this is the real assertion of the whole orientation story.** The crossed HID orientation map, the portrait transform and the cached dimensions are all invisible when they work and all produce a plausible-looking tap somewhere else when they do not. The nav bar is used because it never scrolls: a coordinate case should fail for the coordinate, not the layout |
| screenshot in landscape | `orientation: "landscape_left"` and the image's dimensions are the landscape screen — simctl captures in physical portrait whatever the device is doing, so this is the rotation being applied | a sideways image means `rotationForOrientation` has been "fixed"; `sips --rotate` is clockwise |
| rotates back to portrait | `adopted: "portrait"`, dimensions restored | |
| reports what an iPhone actually adopts | `requested: "upside_down"`, `adopted: "portrait"` — no Face ID iPhone adopts upside-down portrait whatever its Info.plist says | **the preceding rotate back to portrait is what makes this assertable at all**: iOS leaves the interface where it was when it refuses an orientation, so after a landscape the answer would be a landscape. `adopted === requested` here would mean `rotate` has gone back to trusting the request, which leaves every later coordinate silently wrong |
| screenshot in points | the image comes back in the coordinate space the caller's own taps live in — same numbers as `describeScreen` reported | a mismatch means the portrait point dimensions from `describe` and the accessibility root frame have diverged, which is contract check 9's business |
| records a video | `stopRecording` returns the path it was started with and the file is non-empty | empty means the recorder was killed rather than interrupted — `SIGINT`, not `SIGKILL`, is what lets simctl finalize the container |

---

## What this suite found

Recorded here because each one contradicts something that was written down, and
a finding that lives only in a commit message is a finding that gets rediscovered.

1. **A `UNIQUE_ID` marker match is a substring, and `findByIdentifier` had never
   actually been exact.** Measured here and, independently, by contract check 11
   the same afternoon: `findByIdentifier("PlainButto")` resolved `PlainButton`,
   against a doc comment claiming exact matching since the method was written.
   Fixed in `329a447`, which filters the companion's hit down to an exact match
   in the library. The suite's case now runs the other way round — five near
   misses that the companion *does* answer and the library must discard, plus
   three partial labels that must still resolve, because the asymmetry between
   the two lookups is the whole point of having both. This is a case a fake
   cannot carry: a fake that generalised substring to both keys would agree
   equally well with a library that had no filter at all.

2. **"The default backend cannot see toolbar contents" is true eventually, not
   immediately.** Measured over forty consecutive reads on one unchanging
   screen: for the first few reads after launch, a marker query *does* answer for
   `ToolbarSwitch`; thereafter it stops, and the AXBridge tree walk answers
   instead. The transition happened once and stuck. So which of `findByLabel`'s
   paths serves a chrome control is a function of how long the app has been up,
   and the suite therefore asserts *that the element resolves* rather than *how*.
   The same timing is why the action-API fallback case must not be moved earlier:
   an activation aimed at the toolbar switch would succeed in those first
   moments and the fallback would go untested.

3. **The marker path did not normalise `type` where the point read does —
   fixed.** The default backend, which serves a marker query, calls a
   `UISwitch` a `CheckBox`; the tree calls it a `Switch`. `readPoint` ran
   `reconcileType` and so agreed with the tree, and the marker path did not, so
   `findByIdentifier("PlainSwitch").type` was `CheckBox` while `describeScreen`
   and `describePoint` both said `Switch` for the same element — an agent
   branching on `type` behaving differently depending on which lookup happened
   to answer, which is the inconsistency `canonicalise` exists to end. The
   marker path now runs `reconcileType` as well, and the case above asserts all
   three paths agree. A marker hit carries `subrole` regardless of the
   requested keys (the companion honours `keys` only for point and
   whole-screen reads), so the evidence `reconcileType` needs was already
   arriving.

4. **`launchApp` could never return a pid — fixed.** `simctl launch` answers
   `com.example.mcptestapp: 18900`, and the parse was `/^(\d+)/`, anchored at
   the start of a line that begins with the bundle identifier. It could not
   match, so `{pid}` was `null` for every launch that ever succeeded. The
   shipped server has the same bug (`src/index.ts:2648`). Now parsed from the
   end of the reply, since a bundle identifier may itself contain digits, and
   the suite asserts a real pid comes back — its absence is exactly how the
   bug survived a port.

   Reading from the end has an edge the fixture cannot show, because
   `com.example.mcptestapp` does not end in a digit: a reply that is *only* a
   bundle identifier, from a launch that reported no pid, would have had its
   trailing digits read as one (`com.example.app2` → `2`). The pid must now be
   preceded by the colon or space that separates it from the identifier, which
   changes nothing about a real reply. Pinned in `test/lifecycle.test.mts`,
   "does not read a digit-ending bundle id as a pid" — a pure test, because
   there is nothing about it a device could settle.

4. **`launchApp` never returns a pid.** `simctl launch` prints
   `com.example.mcptestapp: 18900`, and the parse is `/^(\d+)/` — anchored at the
   start of a line that begins with the bundle identifier. So `{pid}` is always
   `null`. Faithfully ported from `src/index.ts:2648`, where it has the same
   effect; the suite therefore asserts that the launch *worked* (by reading the
   app off the screen) and says nothing about the pid.

## What it deliberately does not cover

This suite is the library-level analogue of TESTING_TOOLS.md, and it follows
that plan's Part 1 (portrait), Part 2 (coordinates after rotation) and Part 4
(toggles, disabled and covered controls) closely. Part 5 is
`check-companion-contract.mjs` rather than anything here.

**Part 6 — timing — is not covered yet, and should be.** It measures how long
the work itself takes; the MCP round trip in those figures is overhead that had
to be tolerated because there was no way to call the functions directly. There
is now. Two of its rows are the only thing that would catch their regression:
a tap under 100 ms means the hold floor has been lost and taps are unreliable
again, and a point read at ~300 ms means `isRemotelyHosted` is firing on
ordinary elements — in both cases every other check still passes. See TODO #73.

**A recorder that dies the instant it starts is not something a device does on
request.** `simctl io recordVideo` either records or fails outright, and the
case that matters sits between the two: a child that says "Recording started"
and then exits within the same millisecond, while `startRecording` is still
waiting on that greeting. What it costs is not the lost clip — it is that the
handle is left holding a dead process and refuses every later recording until
someone stops one that has already gone. Pinned at the fake layer instead
(`test/capture.test.mts`, "a recording that dies the instant it starts releases
the handle too"), where the greeting and the close can be delivered in that
order deliberately. What this suite does check is the ordinary path either side
of it: a recording that starts, stops, and leaves a non-empty file.

**`delete()`'s failure paths cannot be reached from here, and the state they
leave behind is process-wide.** The suite deletes simulators that delete
cleanly, which is the only kind a real run produces on demand. What the failure
paths decide is who reopens the companion: `delete()` closes it first, on
purpose, so that a concurrent call cannot respawn one against a device that is
about to stop existing — and that block outlives the call. A delete that then
fails for a real reason leaves a simulator that is still there, still meant to
be drivable, and blocked for every handle in the process until something
reopens it. A delete that fails because the device had *already* been deleted
is the opposite: nothing to reopen, and the handle must go stale exactly as a
successful delete leaves it. Both are asserted against the fake's ordered call
log in `test/simulator.test.mts` ("a delete that fails for a real reason
reopens the companion", "a delete that finds it already gone marks the handle
stale anyway"), because forcing `simctl delete` to fail on a real machine means
contriving the failure, and a contrived failure proves the contrivance.

**A timer that outlives the call it was armed in is not assertable here, and
the suite's wall clock is the only sign of it.** Twice now a raced
`deps.sleep` has been left pending after the race was decided — the recording
path's 3s fallback, and `waitForBootStatus`'s 30s cap on `simctl bootstatus`.
Both are invisible to every assertion in this file: the call returns the right
answer at the right time, and it is the *process* that then refuses to exit
until the orphaned timer fires. `boot()` and `waitReady()` were the worse of
the two, because `bootstatus -b` against a device that has already booted exits
at once, so the full 30s tail landed on exactly the short scripts this library
is for. What this suite can show is the aggregate: `npm run test:e2e` runs in
~110s, and a run noticeably longer than the sum of the boots it reports is a
file's process being held open after its last case passed. The precise check is
one layer down — `deps.setTimer` records cancellation, so the fake-clock cases
in `test/lifecycle.test.mts` ("the cap timer is cancelled when bootstatus exits
first", and the other direction) prove it in microseconds.

**Part 3 — remote-hosted views — has no counterpart here, and that is the one
worth knowing about.** It is the machinery behind TODO #60: a sheet or picker
drawn by another process, hosted inside the app's window, whose elements arrive
with frames measured from that window rather than the screen. Untranslated, a
tap by name lands hundreds of points away and reports success, with every frame
involved correct in its own space. `translateRemoteSubtrees`, `isRemotelyHosted`
and `locateInTree` are unit-tested against captured tree shapes, and the
contract check's `--remote` mode confirms the companion still marks the
boundary — but nothing exercises our translation of it against a real hosted
view. See TODO #72, which records what an implementation would need.

## Adding to it

The regression rule (SIMGADGET.md) says a newly discovered bug lands three
things: the fix, a step in the testing plan that would have caught it against
the fixture, and a unit test that catches it in milliseconds. This file is where
the second of those goes when the bug is one only a device can show — and if the
broken rule turns out not to be expressible against the fixture at all, that is
the signal to extract the decision into a pure function first, which is exactly
how `ax/recovery.ts` came to exist.

Two things to hold to when adding a case:

- **Assert on data.** If the only thing a new case can check is that an error
  was thrown, it belongs one layer down, against the fake.
- **A flaky case is a finding, not a nuisance.** Do not add a sleep or a retry
  to settle one. Every case in this file that looks over-specified about
  ordering is over-specified because measuring the flake explained it.
