# TODO — SimGadget library, 2026-08-16

- [ ] **#89 `pressButton` is in the library and not on the MCP.** The handle
  has `pressButton(name, {durationSeconds})` and the e2e drives it (`home`
  leaves the app); no tool exposes it, and none did before the split, so
  parity kept it out of the port — see SIMGADGET_PLAN_SERVER.md's open items.
  Worth adding as a tool on its own merits afterwards: "press home" is
  something an agent asks for and can currently only fake by other means.


- [ ] **#68 Implement a toggle set-to-state call in the JS library.** Cut from
  the v1 API in SIMGADGET.md as its one speculative addition (no MCP consumer;
  `tap({label})` already flips a toggle and reads the state back). Open
  question before designing it: **unclear whether a toggle can be forced to a
  value at all, or only flipped.** The mechanism we have is `AXPress` via
  `accessibility_action`, which is a flip — idb's wire has no set-value for
  toggles (#63 noted sliders would need `setValue`, which likewise is not on
  the gRPC surface). If flip is all there is, set-to-state has to be
  read-then-flip-if-needed, which is racy if the screen changes between the
  read and the flip — decide whether that race is acceptable and how the
  result reports it before freezing a signature.

- [ ] **#69 The bridge wedge can no longer be manufactured on demand, so
  nothing about it is regression-testable.** Found 2026-08-16 while adding
  contract check 8, which was specified to compare an empty point read's error
  text against a wedged bridge's.

  **The measurement.** `xcrun simctl spawn <udid> launchctl stop
  com.apple.CoreSimulator.bridge` — the exact recipe `restartSimulatorBridge`
  uses — produces **no observable read failure at all** on iOS 26.5 with the
  pinned companion. Three independent ways, on a throwaway iPhone 16 Pro:

  | probe | result |
  |---|---|
  | 250ms polling across the stop, 15s | 0 failures |
  | tight sequential loop, 8s | 98/98 OK |
  | 300 concurrent reads staggered over 3s spanning the stop | 0/300 failed |

  `launchctl list` confirmed the bridge pid genuinely changed (98313 → 98517),
  so the stop-and-respawn really happened — there is simply no window to sample.

  **What it does not mean.** It is not evidence the wedge is gone, and not a
  reason to touch the recovery machinery. Stopping the bridge is the *cure*;
  the wedge in BOOT_BUG.md is a bridge that never comes back on its own, and
  running the cure on a healthy simulator was never the same thing as
  reproducing the disease. `isWedgeError` matching `no translation object`
  still rests on field evidence, and check 8's empty-point half — which does
  pass — is the load-bearing half anyway: it establishes that the same message
  means both things, which is what makes `describePoint`'s disambiguation
  necessary in the first place.

  **What it does mean, and is worth someone's judgement.**
  - The wedge half of check 8 was dropped rather than shipped red; the evidence
    above lives in the comment above that check so nobody re-adds it.
  - **Two comments in the recovery code now assert a measurement that no longer
    reproduces**: `RECOVERY_PROBE_TIMEOUT_MS`'s "took ~5s to return, and the
    device answered ~11s after the restart was ordered", and
    `RECOVERY_TAIL_MS`'s "a recovered simulator answered within ~5s in
    testing". Deliberately left alone for now — they are the argument for
    numbers that are merely generous rather than wrong, and rewriting them
    from one machine's reading would trade recorded evidence for a fresh guess.
    Worth revisiting the next time a real wedge is caught in the wild.
  - There is no way to prove the recovery path works end to end short of
    catching a wedge in the wild. That is the honest state of it, and it should
    be said out loud rather than implied by a green suite.

- [ ] **#73 Do TESTING_TOOLS.md Part 6's timings in the e2e, where they can
  finally measure the thing itself.** Requested 2026-08-17.

  Part 6 measures how long the *work* takes. The MCP round trip in those
  figures was never the subject — it was overhead nobody could subtract,
  because until this branch there was no way to call the functions directly.
  There is now, so the numbers get sharper and the current expected bands
  (which include HTTP, JSON-RPC and a server hop) need re-deriving against
  direct calls rather than copied across.

  **Two of the rows are the only thing that would catch their regression**,
  which is what makes this worth automating rather than leaving as a table
  someone eyeballs:

  - **A tap that costs less than the 100 ms hold means the floor has been
    lost.** `MIN_TAP_HOLD_SECONDS` exists because an instantaneous touch
    actuates a control about 40% of the time (#62). Lose it and every tap still
    reports success, every assertion in the e2e still passes, and taps merely
    become unreliable — the timing is the only witness.
  - **A point read at ~300 ms instead of single digits means `isRemotelyHosted`
    is firing on ordinary elements**, so every point read is paying for a
    whole-screen fallback while still returning the right answer. Nothing
    fails. Measured at 313 ms once, because a hit-test at x=200 returned the
    home screen's Health icon, whose frame ends at x=188.67.

  **Assert load-robustly, or this will be the flaky part of the suite** — and
  SIMGADGET_PLAN.md is explicit that flakiness is not acceptable and must not
  be retried away. Absolute milliseconds on a machine that might be building
  something else are exactly the wrong shape. Both regressions above are
  reachable without them:
  - the hold floor is a **lower bound** — `tap({x, y})` must take *at least*
    `MIN_TAP_HOLD_SECONDS`. A busy machine only makes a lower bound safer.
  - the fallback is a **ratio** — `describePoint` must be substantially cheaper
    than `describeScreen` on the same screen. Load moves both together, which
    is precisely what the doc means by "the ratios are what matter".
  Anything wanting absolute figures belongs in a reported table rather than an
  assertion.

  **Methodology already learned the hard way, in Part 6's own notes:** measure
  against a screen that does not change (three tools alter what is on screen,
  and a `ui_find` hit silently becoming a miss reads as a fast-path regression
  — it happened three times while writing that table); tap something inert;
  take medians of several runs; and discard the first call after a boot, which
  includes connecting to the companion and runs an order of magnitude slower.

  Worth reporting the full table as output even where it is not asserted, so a
  human running the suite sees the same figures Part 6 tabulates today.

- [ ] **#72 The e2e suite has no counterpart to TESTING_TOOLS.md Part 3 —
  remote-hosted views.** Noted 2026-08-17 while checking the new
  `test:e2e` journey against the manual plan it is the library-level analogue
  of. Parts 1, 2 and 4 map across closely; Part 5 is
  `check-companion-contract.mjs`; Part 6 is #73 below. Part 3 has nothing.

  **Why this is the gap worth naming.** It is the machinery behind #60, the one
  bug on this list that reached production. iOS draws the "Use Strong
  Password?" sheet, the photo and document pickers and share sheets from a
  *separate process*, hosted inside the app's window, so their elements arrive
  in one tree with the app's own while their frames are measured from the
  hosting window rather than the screen. Untranslated, `tap({label})` resolved
  the label, tapped its centre, reported success, and landed 476 points away —
  in the fixture, "Fill Strong Password" tapped "Login Submit". **Every frame
  involved was correct in its own space**, so nothing in the tree could
  contradict it, which is what makes this failure mode a confident false
  success rather than an error.

  **What is covered, so the gap is precise.** `translateRemoteSubtrees`,
  `isRemotelyHosted` and `locateInTree` are all ported and unit-tested against
  captured tree shapes, including the picker case where the hosting window sits
  at the screen origin and the offset is legitimately zero — the case that kills
  "sheets are wrong, shift them". `check-companion-contract.mjs --remote`
  checks that the companion still emits the type-83 boundary node. **What
  nothing checks is our translation of it against a real hosted view.**

  **What an implementation would need.** The sheet has to be raised by
  interaction (the fixture's login screen, `ShowLoginButton`, then the password
  field), and it does not appear reliably on demand — which is the reason the
  manual plan has it as its own part rather than a step in Part 1. The picker
  (`ShowPickerButton`) is the more reproducible half and is also the
  zero-offset case, so it proves the guard rather than the shift. Assert a
  frame inside the hosted view is in screen space, and that a tap by name
  actually lands, which is the assertion #60 would have failed.

  **Smaller omissions found in the same pass**, none of them load-bearing:
  TESTING_TOOLS #45 (tapping a toggle by *coordinate* — the e2e taps by
  coordinate only in landscape), #46 (a name that resolves to something that is
  not a control), and #19 (activity while a recording runs). `ui_view` has no
  library equivalent by design — it is an MCP wire shape.

- [ ] **#70 A script needs to be able to read, and to assert where it is.** The
  motivating shape: `tap the button, then make sure we are on the XYZ screen`.
  Requested 2026-08-17. A v1-API addition, so it needs a SIMGADGET.md amendment
  before it is written, not a note afterwards.

  **What already exists, so this is not built from nothing.** `findByLabel`
  matches against an element's label, its visible text (`AXValue`) *and* its
  identifier, and returns the element or `null` — so "is XYZ on screen" is
  already answerable, and a text field's contents already come back in
  `AXValue`. `describeScreen()` returns the whole pruned tree. The gap is
  ergonomics and, more importantly, **timing and identity**:

  - **Reading text by name has no first-class verb.** `findByLabel("Total")`
    then `?.AXValue` is the whole implementation, but every caller writing it
    themselves will get the `null` case wrong. A `readText(name)` returning
    `string | null` is a two-line method and a real improvement in what scripts
    look like.
  - **The race is the hard part, not the read.** A tap is followed by an
    animation, and reading immediately is measurably wrong: #53 found dismiss
    taps fired straight after a presentation failed in 2 of 3 rounds, and 4 of 4
    with a 1s settle. So the useful primitive is not `read` but **`waitFor`** —
    a predicate with a budget, polling a cheap read. Without it every script
    grows its own `sleep(1000)`, which is the thing this library exists to stop.
    Open: what the predicate takes (a label? an element test?), what it returns
    on timeout (throw, or a `false` a caller must check — design rule 3 says
    absent is an answer, but a timed-out *wait* is arguably different), and
    whether it shares the ~13ms cheap read or needs the ~350ms AXBridge one.
  - **"What screen am I on" has no answer in the accessibility tree, and that is
    the genuinely open question.** iOS publishes no screen identity. Candidates,
    in rough order of promise:
      - **`pid`.** The companion returns it per element and `DESCRIBE_KEYS`
        deliberately drops it (`ax/tree.ts:59`) as near-constant. It is not
        constant across a *process* boundary, which is exactly the case that
        matters: #37 records that a system alert replaces the app in the tree
        entirely, and the whole remote-hosted-view mechanism (#60) is about
        subtrees drawn by another process. Cheapest lead, and it is being thrown
        away today.
      - **The navigation bar's title**, which is what a human means by "the XYZ
        screen". Only AXBridge sees nav bar contents at all (contract check 4),
        so this costs the expensive read.
      - **The set of visible labels** as a fingerprint. Crude, and brittle
        against any dynamic content.
    Worth an investigation session against the fixture before designing an API:
    the question "what can we actually know about where we are" has never been
    asked directly, and the answer decides whether this is a `currentScreen()`
    verb or just documentation telling scripts to assert on a landmark.

  **What it must not become:** a general assertion framework. The library's job
  is to answer accurately; `expect`/`should` belongs to whatever test runner the
  caller already has.

- [ ] **#71 Swipe to a label — scroll until XYZ is on screen, then tap it.**
  Requested 2026-08-17. Also a v1-API addition needing a spec amendment first.

  **The subtlety that makes this worth designing rather than scripting:** being
  in the tree is not the same as being on screen. A scrolled-out control keeps
  its place in the accessibility tree with a perfectly correct frame — that is
  precisely why `tap({label})` hit-tests before touching and refuses with
  `TapObstructedError` (#64a; the fixture's stepper under the toolbar tapped the
  *search field* and reported success). So **the stopping predicate must be the
  hit-test, not `findByLabel` returning non-null**, or this will confidently
  stop scrolling while the target is still under a toolbar. The machinery to
  decide it already exists inside `tap`; this needs it factored out rather than
  reinvented.

  Open questions, none of them settled:
  - **Where to swipe.** A screen can hold several scrollable regions, and a
    swipe in the wrong one does nothing at all — which is indistinguishable from
    "not scrollable" and would burn the whole budget. Does the caller name a
    container, do we swipe the largest scrollable frame, or the one containing a
    landmark?
  - **When to give up.** Two conditions, and both are needed: a step budget, and
    *no progress* — the tree stopping changing means the end of the list, and
    continuing past it is pure cost. Detecting "the tree did not change" cheaply
    is its own small problem.
  - **Direction.** Caller-specified, or inferred from where the element already
    is in the tree when it is present but off screen? The second is much nicer
    and only works when the target is in the tree at all.
  - **Overshoot.** Fast scrolling can carry a target past the viewport between
    reads; a smaller final step, or scrolling back, may be needed.
  - **What it answers.** Per design rule 1, not a bare success: how far it
    scrolled, how many steps, and the element it ended up with — so a caller
    that then taps is not re-resolving from scratch.

  **Relationship to #70:** these are the same primitive underneath — swipe,
  re-read, test a predicate, repeat within a budget. Design them together or the
  second will duplicate the first's polling loop.

# TODO — Code review: MCP server port (step 3), 2026-08-23

Full review of step 3 — `a0ceb9c`..`8d3afb0`, seventeen commits, four agents —
against SIMGADGET_PLAN_SERVER.md, SIMGADGET.md and DECISIONS.md, with every
tool body read against `git show a0ceb9c^:src/index.ts`.

**Verified clean and not repeated per-item below.** All seventeen tool bodies
diffed against their originals: **every optional argument reaches the library**
— `launch_app`'s `terminate_running`→`terminateRunning`, `record_video`'s
`codec`/`display`/`mask`/`force`, `screenshot`'s `type`→`format` plus
`display`/`mask`, `ui_view`'s `quality: 80` and `resizeTo: "points"`,
`ui_swipe`'s `delta`/`duration` including the `|| undefined` that keeps a zero
meaning "say nothing", and `ui_tap`'s `count`/`duration` including the subtlety
that `duration: "0"` still makes the gesture a *hold* (`holdSeconds` floors it
at 0.1s while `decideTapVerb` keys off `!== undefined`, exactly as
index.ts:1834 and :1899 did). The premise that "nothing proves the arguments
reach the library" turned out to be false: `tools.test.mts` asserts the
passthrough per tool with `fake.argsFor(...)`, and the fake records arguments,
not just names. The `--` separators survived into `screenshotArgs`/
`recordingArgs`. `index.ts`: one registry constructed once and closed over by
`createServer`, which `runHttp` calls per request; `shutdown` reachable from
SIGINT, SIGTERM and stdin close behind a once-latch; `assertIdbPathUnset()`
called first in `runServer`; `PACKAGE_VERSION` read exactly as index.ts:43 read
it; the deliberate absence of `capabilities` matches the old constructor.
`transport.ts` is faithful: the 403 keeps its whole explanation with the new
variable name, no `allowedOrigins`, the EADDRINUSE listener, the stdin-close
shutdown, and the `listening on` sentence `imsmd.sh` greps for. Seams: all
fourteen non-lifecycle tools go through `withSession`; all seventeen pass a
`RenderContext` except `attach_simulator`, which is documented and has a test
asserting the sentence is absent; no agent-facing prose is duplicated between
`tools.ts` and `render.ts`, and `describeFrame` exists only in the server.
Rules: no deep imports (grep and `imports.test.mts`), no `as any` in `src/`
(`summarizeRpc`'s `msg: any` is verbatim from index.ts:2776), the fake tethered
through `Pick<Simulator, …>` with the single cast confined to `asSimulator`,
and the baseline fixture has exactly one commit in its history (`a0ceb9c`) with
no diff since. Deletion: every top-level declaration of the 3038-line original
traces to a destination — `TMP_ROOT_DIR`'s cleanup is now `capture.ts`'s own
`mkdtemp`/`finally`, the freeze check had nothing left to guard, and
`verify-companion-download.mjs`, `check-companion-contract.mjs` and
`gen-keymap.mjs` all point into `packages/`. Suites re-run here: `npm run
typecheck` clean, `npm test` 523 + 414 green, `npm run smoke` green over both
tarballs — matching the counts every handoff entry claims. **Not checked:**
`npm run check:companion` and `npm run test:e2e` (both need a booted simulator;
I created none), the manual TESTING_TOOLS.md / TESTING_SERVER.md runs, and
agent B's three simulated fake-drifts, which cannot be re-run without editing
the library.

## Bugs

- [x] **#90 FIXED 2026-08-23. A clean checkout is red: nothing builds `packages/simgadget` before
  `npm test` and `npm run typecheck` run against it.** The 3.6 commit correctly
  stripped `"prepare": "npm run build"` from the root `package.json` — the root
  builds nothing now — but **neither package gained one**, and the workspace
  fan-outs do not build either. So after `npm ci` from a fresh clone,
  `packages/simgadget/build/index.d.ts` does not exist, and `simgadget-mcp`
  cannot resolve the library through its `exports` map.

  **Reproduced**, in a clean-room copy of both packages with the third-party
  `node_modules` linked in and the two `build/` directories removed:

  ```
  src/render.ts(59,8):  error TS2307: Cannot find module 'simgadget' or its
                        corresponding type declarations.
  src/sessions.ts(42,8): error TS2307: ...
  src/tools.ts(84,45):   error TS2307: ...
  ```

  and at runtime `ERR_MODULE_NOT_FOUND … node_modules/simgadget/build/index.js`
  from the first `.mts` test that touches the library.

  **This is invisible to every developer and fatal to CI.** Anyone who has run
  `npm run build --workspaces` once has a warm tree forever; `npm run smoke` is
  green because `smoke-packed.sh` builds first. `ci.yml` does `npm ci` →
  `typecheck` → `test` → `smoke`, so it fails at step two and never reaches the
  one check that would have passed. `publish.yml` does `npm ci` → `npm test`
  and fails there too, before the `npm publish` against a private root that
  agent D deliberately left broken. **The branch has never been pushed**
  (`origin/simgadget-impl` does not exist), which is why nobody has seen it.
  It also means exit condition 1 — "`npm test` and `npm run typecheck` green in
  **both** packages, from the workspace root" — has only ever been demonstrated
  on a tree that was already built.

  **Fix:** `"prepare": "npm run build"` on `packages/simgadget/package.json`.
  npm runs `prepare` for linked workspace packages during `npm ci`, `tsc` is a
  hoisted root devDependency so it is present, and the extra run during
  `npm pack` is harmless (`smoke-packed.sh` builds explicitly anyway). Adding
  one to `simgadget-mcp` is optional — `mcp.test.mts` builds that package
  itself — but is the symmetric choice and costs a second.

  **Test:** the check that catches this cannot live in a suite that runs in the
  warm tree. A CI step is the honest place: either add `npm run build
  --workspaces` before Typecheck in `ci.yml` **and** the `prepare` (belt and
  braces, since a contributor's first `npm test` deserves to work too), or a
  workflow job that runs `npm ci && npm run typecheck` in a container with no
  prior build. **TESTING_TOOLS.md:** not applicable — no tool behaviour is
  involved. CONTRIBUTING.md's "Unit tests" section is where a contributor meets
  it, and that section currently promises "No simulator, **no build step**, well
  under a second" — the exact claim this falsifies for `simgadget-mcp`.


  **Fixed, and the fix is not the obvious one.** Adding `prepare` to both
  packages does *not* work: npm does not order workspace lifecycle scripts by
  dependency, and in a clean room it ran `simgadget-mcp`'s build first — three
  `TS2307`s, and `tsc` emitted anyway, so the failure left a `build/index.js`
  that looked like success. The ordering belongs where it can be stated:

  - the root gains `"build": "npm run build --workspace=simgadget && npm run
    build --workspace=simgadget-mcp"` and a `prepare` that runs it, so `npm ci`
    alone leaves a usable tree and CI needs no new step;
  - `simgadget` keeps its own `prepare` — it has no workspace dependency, so it
    is always safe, and it covers `npm publish -w simgadget`;
  - `simgadget-mcp` deliberately has **no** `prepare`, because a standalone one
    cannot be made correct. **Step 7's publish workflow must therefore build
    before packing**, exactly as `smoke-packed.sh` does.
  - `smoke-packed.sh` stopped using `npm run build --workspaces`, which had the
    same unordered hazard and only ever passed because `build/` already existed.

  **Verified the way the finding was**: a clean room built from `git ls-files`
  only, `npm ci` from nothing, then typecheck, 523 + 415 tests and the packed
  smoke — all green, none of it on a pre-built tree.

- [x] **#91 FIXED 2026-08-23. `start_simulator` no longer recovers a session whose simulator was
  deleted out from under it; it refuses, and its advice loops.** The old resume
  branch called `findDevice(existing.udid)` and treated **both** "gone" and
  "not booted" as stale: *"Stale entry — the simulator is gone or shut down.
  Drop it and recreate below"* (index.ts:1234). The port replaced `findDevice`
  with `sim.state()`, which does not return `null` for a missing device — it
  throws `SimulatorNotFoundError` (simulator.ts:544), and `start_simulator`
  deliberately does not use `withSession`, so nothing catches it. Only the
  "shut down" half of the branch survives. The comment above it still claims
  both: *"Stale: the simulator is shut down or gone."*

  **Failing case**, driven through the real `registerTools` and
  `SessionRegistry` against a handle that throws as the library does:

  ```
  1. start_simulator {id:"qa"} -> Error starting simulator: No simulator found with
     UDID "AAAA-1111". Session "qa" can no longer use it — call destroy_simulator,
     then start_simulator for a fresh one.
  2. destroy_simulator {id:"qa"} -> Error destroying simulator: No simulator found
     with UDID "AAAA-1111". Session "qa" can no longer use it — call
     destroy_simulator, then start_simulator for a fresh one.
  3. start_simulator {id:"qa"} -> Simulator started: "qa_iphone" (…, BBBB-2222).
  ```

  Three calls and two errors where the old server took one call and none — and
  step 2's answer tells the agent to call the tool it has just called and which
  has just failed. (It does work: `destroy` drops the session before rethrowing.
  But an agent reading that sentence has no way to know the failure was
  progress.)

  **How it is reached.** Any deletion the server did not perform: a human using
  Simulator.app's Delete, `xcrun simctl delete`, or — most likely of all — the
  development loop CLAUDE.md documents, where `SIMGADGET_CLEANUP_ON_EXIT=false`
  leaves orphans that "accumulate silently until you delete them yourself".
  The same throw also arrives from `assertNotDeleted()` on a handle this server
  already deleted, which wants the same answer.

  **Fix:** in `tools.ts`'s resume branch, treat `SimulatorNotFoundError` from
  the probe as "gone", not as a failure:

  ```ts
  let state: SimulatorState | undefined;
  try { state = await existing.sim.state(); }
  catch (error) { if (!(error instanceof SimulatorNotFoundError)) throw error; }
  if (state === "Booted") { … } else sessions.drop(id);
  ```

  Better still, put it in the registry as `resume(id)` so `tools.ts` keeps its
  one-call shape and the rule lives beside the other stale-handle rule in
  `withSession`.

  **Unit test** (`packages/simgadget-mcp/test/tools.test.mts`, beside "a
  shut-down simulator is dropped and recreated"): a fake whose `state` fails
  with `new SimulatorNotFoundError(udid)`; assert `isError === false`, that
  `create` was called a second time, and that the answer names the new udid.
  The fake already supports it — `fails: { state: … }`.

  **TESTING_TOOLS.md step** (Part 1, after the attach/detach pair): start a
  simulator for id `gone`, note the udid, then — with the user's permission,
  since this is the one place the "never use simctl" rule is deliberately
  broken — `xcrun simctl delete <udid>`, then `start_simulator {id: "gone"}`
  again. **Expected:** a new simulator with a new udid, not an error.

## Spec / plan deviations needing sign-off or a doc fix


  **Fixed** in `tools.ts`: the `state()` call in the resume branch catches
  `SimulatorNotFoundError` and treats it as the stale case, which is what
  `findDevice` returning `null` did for both causes in the old server. The
  comment that claimed both cases were handled is now true.

  The regression test drives the real `registerTools` through the in-memory
  client: a session whose fake throws `SimulatorNotFoundError` from `state()`
  is dropped, a second simulator is created, no window is raised for the dead
  one, and the answer does not mention `destroy_simulator`. **Proved
  non-vacuous** — reverting the catch turns it red.

- [ ] **#92 `ui_describe_point` on empty space answers the four characters
  `null`, where the spec asks for a sentence.** SIMGADGET.md's "The MCP on top"
  mapping table is explicit: *`ui_describe_point` | `sim.describePoint(x, y)`;
  **null → the "empty or covered" answer**.* SIMGADGET_PLAN.md's deliberate
  change 3 makes the same split — the *library* stops throwing, *"the wedge
  disambiguation is unchanged; only the reporting is"* — leaving the reporting
  to the server. The port renders it as `JSON.stringify(null)`.

  ```
  ui_describe_point on empty space -> isError: false | text: "null"
  ui_find with no match            -> isError: false | text: "No element found
    whose label contains "Sign In". Use ui_describe_all to see what is on screen."
  ```

  The two "absent is an answer" tools now disagree about what an answer is, and
  the one that says nothing is the one whose old message told the caller what
  to do next: *"No accessibility element at (200, 400). The simulator is
  answering normally, so that point is empty or covered — check the coordinates
  against ui_describe_all."* (index.ts:341). SIMGADGET_PLAN_SERVER.md row 5
  authorises "answers rather than erroring" — it does not authorise dropping
  the sentence, and no row records that it was dropped, which makes this a
  quiet deviation rather than a decided one (plan rule 3).

  **Not certain it is wrong**, and that is why it is here rather than under
  Bugs: `null` is a legitimate machine-readable answer, and `ui_describe_point`
  otherwise returns raw JSON, so a caller parsing it gets a uniform shape. But
  it is the spec that decides, and the spec says otherwise.

  **Fix:** `renderNoElementAtPoint(x, y)` in `render.ts` carrying index.ts:341's
  wording, returned as a *successful* text result; `ui_describe_point` uses it
  when `describePoint` answers `null`. If instead the bare `null` is what is
  wanted, it needs a row in "Deliberate behaviour changes" and a line in
  SIMGADGET.md's mapping table, because those two documents currently say
  something else.

  **Unit test:** `render.test.mts` for the sentence; `tools.test.mts`'s
  "empty space answers null rather than failing" already has the fake in place
  (`createdFake({ atPoint: null })`) and currently asserts `text === "null"` —
  that assertion is the one that changes.

  **TESTING_TOOLS.md step:** #4 already queries a coordinate; add a sibling
  that queries a deliberately empty patch (the fixture's background) and states
  the expected sentence. There is no such step today, which is why nothing in
  the manual plan would have caught this either.

- [ ] **#93 Two tool descriptions still tell agents to set
  `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR`, and following that advice earns a
  deprecation warning.** `screenshot`'s `output_path` and `record_video`'s
  `output_path` both name the old variable, verbatim from the baseline — which
  is correct under the parity rule and wrong under the rename. A user who
  follows the description gets `[simgadget]
  IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR is deprecated; use
  SIMGADGET_DEFAULT_OUTPUT_DIR instead` on stderr. These are the most-read
  strings in the server: `tools/list` is sent to every agent at connect.

  Agent D's handoff lists README, TROUBLESHOOTING and CAMERA as the stale
  env-var docs; it does not list these two, and they are not docs — they are
  the wire surface, pinned by a fixture whose README says it must never be
  regenerated. So this cannot be quietly fixed at step 5: changing them turns
  `mcp.test.mts`'s whole-surface `deepEqual` red on purpose.

  **Fix:** a decision, then three small edits together — the two descriptions,
  a new row in "Deliberate behaviour changes" ("the two output-path
  descriptions name `SIMGADGET_DEFAULT_OUTPUT_DIR`; the shim keeps the old name
  working"), and a third entry in `mcp.test.mts`'s `ALLOWED_DIFFERENCES` citing
  that row. Doing it any other way either leaves the advice wrong or
  regenerates the baseline.

  **Test:** the allowlist entry *is* the test — it names what changed and
  fails if anything else does. No TESTING_TOOLS step: nothing behavioural moves.

- [ ] **#94 The wedge message lost idb's own text, and no row records it.**
  `clarify()` ended with `\n\nOriginal error: ${message}` (index.ts:730), so the
  underlying idb sentence travelled with the rewritten one. `renderError`'s
  `"not-answering"` row reproduces the first half verbatim and the second half
  branches on `recoveryTried` — which is documented, as row 10 — but the
  `Original error:` tail is simply gone, and no row in "Deliberate behaviour
  changes" mentions it.

  It is arguably right: design rule 2 exists so idb's vocabulary never leaves
  the idb client, and pasting its message back in is a way of leaking it. But
  it is the only text an operator had for distinguishing one wedge from
  another, and dropping it was not a decision anyone wrote down.

  **Fix:** either a row in the table saying it was dropped and why, or — if it
  is wanted — `SimulatorNotAnsweringError` carrying a `cause`/`detail` the
  renderer appends. The second is a library change and therefore the owner's
  call. **Test:** one `render.test.mts` case either way. **TESTING_TOOLS.md:**
  the wedge cannot be manufactured on demand (#69), so there is no step to add.

## Risks

- [ ] **#95 A second signal exits the process in the middle of the first
  signal's cleanup.** `shutdown()` latches on `cleaningUp`, so it runs at most
  once — that part is right, and is what the handoff asked to be checked. But
  the *handlers* do not share the latch: a SIGINT arriving while a SIGTERM's
  `sessions.shutdown()` is still awaiting `simctl delete` finds `cleaningUp`
  already true, returns immediately, and runs `process.exit(0)` underneath the
  first pass. Every simulator not yet deleted is orphaned.

  **Pre-existing** — index.ts:3037 had exactly this shape — and unlikely, since
  `imsmd.sh stop` sends one signal and waits 5s. Listed because the port made
  `sessions.shutdown()` the *only* thing that deletes simulators, where the old
  server also had `companions.shutdownAll()` and a synchronous `'exit'` hook
  covering part of the ground.

  **Fix:** one line — hold the promise rather than a boolean:
  `let cleanup: Promise<void> | undefined; const shutdown = () => (cleanup ??=
  sessions.shutdown().catch(() => {}));` — so a second caller awaits the first
  instead of racing past it. **Test:** `index.ts` has no test by construction,
  which is the argument for moving the latch into a two-line exported helper
  (or into `SessionRegistry`) where `sessions.test.mts` can call it twice
  concurrently and assert one pass and two resolutions. **TESTING_SERVER.md:**
  its process-lifecycle section is the place — "send SIGTERM, then SIGINT
  immediately; every owned simulator is gone".

## Comments that do not match the code

- [ ] **#96 Four claims in the new files that the code contradicts.** None
  changes behaviour; all four would mislead the next reader, and two of them
  are the kind of thing someone "fixes".

  1. **`paths.ts`'s header and `tools.ts`'s `screenshot` body both say the
     library "takes absolute paths only" and "resolves nothing".** It does
     resolve: `Simulator.startRecording` and `captureScreenshot` both call
     `path.resolve()`, per DECISIONS.md #12 — which is the authority, and which
     says exactly that. What is true is the useful half: `~/` expansion and the
     `DEFAULT_OUTPUT_DIR` fallback are host policy and stay in the server. Say
     that instead. (`install_app`'s comment already gets it right: "the
     library — which resolves identically".)
  2. **`env.ts` says the four CLI-overridable settings "are combined with
     `parseArgs` in `index.ts`, which is the only place that knows a command
     line exists".** Agent D's own deviation 1 moved `parseArgs` and
     `resolveConfig` into `transport.ts`; `index.ts` calls them and knows
     nothing else. Written before that move and not revisited.
  3. **`test/harness/mcp.ts` says its server is built "the way `index.ts` will
     build it — same instructions, same `tools` capability".** `index.ts`
     deliberately passes **no** `capabilities`, with a comment explaining that
     `server.tool()` declares it and that the baseline came from a server that
     passed none. The harness passes `capabilities: { tools: {} }`. The
     practical difference is nil and the parity gate does not compare
     capabilities — which is precisely why the claim of sameness should either
     be true or be dropped.
  4. **`tools.ts`'s header states the rule "One library call and one render"**,
     and four of its own bodies are not that: `start_simulator` (get, `state`,
     `showWindow`, `create` and two branches), `attach_simulator` (`attach` +
     `waitReady`), `ui_tap` (target selection and a refusal), and the two
     capture tools (path resolution first). Each departure is justified inline
     and correct; the rule as written is the plan's softer "bodies **mostly**
     become one library call" (SIMGADGET_PLAN_SERVER.md:81). Restate it as the
     boundary it actually is — no element resolution, no coordinate maths, no
     deciding what a toggle is — which is the sentence the rest of that header
     already argues for.

## Housekeeping

- [ ] **#97 TESTING_TOOLS.md has a dead link and one expected string that
  predates a deliberate change — both in a document step 6 is about to run.**

  - Line 670 links `[src/ax/tree.ts](src/ax/tree.ts)`, deleted at 3.6. It is
    now `packages/simgadget/src/ax/tree.ts`, and the surrounding paragraph is
    the diagnosis for a real regression this row has caught before — so it is
    the one link in the file worth having work.
  - Line 95 expects `"App com.example.mcptestapp launched successfully"`. With
    deliberate change 12 the answer now carries a pid, so a step-6 run reads a
    mismatch and has to decide on the spot whether it is a regression —
    exactly what the plan's step 5 says to prevent ("derived from the table
    **before** the step 6 run, not during it, or the run becomes a negotiation
    with itself"). Row 12 is in the table; the string was not updated from it.
  - Lines 189 and 613 still name `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` and
    `IOS_SIMULATOR_MCP_COMPANION_PATH`. Both still work through the shims —
    verified, the library's `readEnv` covers `COMPANION_PATH` — so these are
    stale rather than broken, and are step 5's along with README and
    TROUBLESHOOTING. Listed so they stay on the list.

  Also still true from the library review: **#88's `.DS_Store`** is untracked
  and absent from `.gitignore`.

- [x] **#98 FIXED 2026-08-24. The first push failed CI: `EBADPLATFORM`.**
  `npm ci` on the Ubuntu runner refused the whole install — *"Unsupported
  platform for simgadget@0.0.1: wanted {"os":"darwin"} (current:
  {"os":"linux"})"* — before a single check ran.
  - **The declaration did not change; its meaning did.** npm enforces `os` on
    a package installed *as a dependency*, not on a project or a workspace
    package for itself. One package meant the field was decorative on the
    runner; two means `simgadget` is a dependency of `simgadget-mcp` and is
    checked. Nothing about it was visible until the branch was pushed, because
    every local install is on macOS.
  - **Fixed by dropping `os` from the library and keeping it on the server**,
    with the reasoning in SIMGADGET.md's decisions register. The library still
    refuses non-darwin loudly at resolve time
    (`assertSupportedArchitecture` → `UnsupportedArchitectureError`, unit
    tested), which is the same arrangement it already has for arm64 — it
    declares no `cpu` field either.
  - **Watch the smoke step on the next run.** The old CI installed a
    darwin-only tarball on Linux without complaint (run 31915294749), so the
    packed install is expected to stay green; if it does not, it is the same
    cause and the same fix one layer down.

- [ ] **#99 `verify-companion-download.mjs` drives whatever simulator happens
  to be booted.** Noticed 2026-08-24 while running it for step 4: its step 7
  picks `simctl list devices booted` and attaches to the first result, which on
  this machine was `whisky-autofill_iphone-16-pro` — a simulator belonging to
  another session's daemon. Two read-only calls, and it detaches rather than
  deleting, so nothing was disturbed; but "never touch a simulator you did not
  create" is a rule this repository states in DECISIONS.md and CLAUDE.md, and
  the script breaks it by design on any machine where somebody else is working.
  - **Fix:** create a throwaway simulator the way the e2e suite does and delete
    it in a `finally`, or require an explicit `--udid` / `--allow-attach` before
    adopting one it did not create. Skipping when nothing is booted is already
    the behaviour, so the fallback path exists.
  - Not urgent — it is a script a human runs deliberately — but it is the kind
    of thing that eventually deletes somebody's afternoon rather than reading
    from it.

# TODO — Code review: library rewrite, 2026-08-18

Full review of the step-2 library (`packages/simgadget`) against SIMGADGET.md
and SIMGADGET_PLAN.md. Verified clean and not repeated per-item below: port
fidelity against the frozen originals (no smuggled behaviour changes; every
diff traces to a deliberate change), rename completeness, sun_path headroom,
error-vocabulary containment in `ax/recovery.ts`, the exports boundary, the
tether rule (all twelve fake beliefs map to contract checks 1–12), plan test
coverage for steps 1.1–8, the step-9 e2e journey item-for-item, and the exit
conditions: typecheck, 495/495 unit tests, root build + frozen manifest, and
the e2e suite re-run during the review — 32/32 in 110s unattended. The one
thing not re-run: `check:companion` against a booted fixture (exit condition 5).

## Bugs

- [x] **#74 DONE 2026-08-18. DECISIONS.md recovered and committed at the repo
  root.** It survived intact in the session scratchpad it was written in
  (`d15f9e10-.../scratchpad/DECISIONS.md`); the committed copy is
  byte-identical, sha256 `e6883300…`. Its numbering matches every citation, so
  all 40-odd `DECISIONS.md #N` references across `src/`, the fakes and
  TESTING_LIBRARY.md now resolve — including #1 (boot opens Simulator.app,
  settled with the owner), #2 (`(string & {})`), #12 (`path.resolve`-only),
  #19 (companion close/reopen on the deps seam) and #21 (registry fresh per
  test). No prose was rewritten: the sign-off trail is the original document,
  not a reconstruction of it — which is what makes #83's and the
  `(string & {})` deviation's sign-off claims checkable (items 26 and 2).

  Original finding: cited 82 times and absent from the repo. At least 18
  distinct numbered decisions (#1–#24) were cited as load-bearing authority
  across `src/internal/deps.ts`, `internal/registry.ts`, `lifecycle.ts`,
  `simulator.ts`, the test fakes and TESTING_LIBRARY.md — including decisions
  the spec does not record.

- [x] **#75 DONE 2026-08-18. `waitForBootStatus` waits on a cancellable timer,
  and cancels it whichever way the race goes.** `lifecycle.ts`'s
  `deps.sleep(BOOTSTATUS_CAP_MS)` race is now `deps.setTimer` with a `settle`
  that calls the loser off, the same shape `waitForRecordingStart` already
  used. Landed with #81 in one rewrite. Tests: `test/lifecycle.test.mts`,
  "the cap timer is cancelled when bootstatus exits first" (asserts
  `timers[0].cancelled`) and "the cap fires, and kills the child rather than
  leaving it" (fires the timer by hand, asserts nothing is armed after it) —
  the fake's `setTimer` log proves both directions in microseconds.
  TESTING_LIBRARY.md's "does not cover" section records why the suite's wall
  clock is the only device-level sign of this class of defect.

  The fake's default spawned child now exits on the next turn, as
  `bootstatus -b` does against an already-booted device — the case that paid
  the full 30s tail, and now the case the fake models.

  Original finding: `lifecycle.ts:400` raced the bootstatus child's exit
  against `deps.sleep(BOOTSTATUS_CAP_MS)` (30s) and never cancelled the losing
  timer, holding the event loop open. Confirmed empirically: a raced
  `realDeps.sleep(3000)` resolves at 0ms and the process exits at 3002ms —
  the same measurement that motivated `setTimer` for the recording path.

- [x] **#76 DONE 2026-08-18. The companion path maps external deletion too, by
  asking simctl who exists.** Every companion call the handle makes now goes
  through one private `Simulator.withClient`, which on a failure consults
  `findDevice`: only a udid simctl no longer lists becomes
  `SimulatorNotFoundError`, and everything else is rethrown exactly as it
  arrived — a companion that could not start against a simulator still sitting
  there keeps its own error and its `stderrTail`. The wedge vocabulary is
  exempt and never pays the round trip: those errors are about a bridge
  belonging to a simulator that plainly exists, `withAccessibilityRecovery`
  reads them to choose the cure, and they are the only companion failure
  frequent enough for the cost to matter.

  **The e2e is what settled the mechanism, and it contradicted the review.**
  Written first as the finding described — catch `CompanionStartError`, look
  the udid up — it passed every fake-layer test and failed against a real
  simulator: a handle that *already has* a companion never reaches a spawn, so
  it fails on the block `delete()` puts on the udid, as an untyped `IdbError`.
  An external `simctl delete` against a live companion lands the same way.
  Chasing error shapes is how half of this went missing the first time, so the
  question is now asked of the only thing that can answer it. Widening past the
  finding's letter was checked with the owner before it was written.

  Tests: `test/simulator.test.mts`, "a failed companion call is resolved
  against simctl" — gone → `SimulatorNotFoundError` (both a start failure and
  the closed-udid refusal), present → the original error untouched, a wedge
  error asks simctl nothing, and `findByLabel` throws rather than answering
  `null` through its tree fallback. The e2e case at
  `test/e2e/lifecycle.e2e.mts` drives the stale handle by all three routes
  instead of `state()` alone; TESTING_LIBRARY.md's Part 1 row says why.

  Original finding: the spec promises that after external deletion "every
  method throws SimulatorNotFoundError — a clear error, never a gRPC timeout",
  and only the simctl half existed (`mapSimctlError`). A read on a stale handle
  spawned a companion against the vanished udid, which exited failing target
  resolution → `CompanionStartError` with the misleading code
  `companion-start-failed`. The e2e knew: it tested external deletion only
  through `state()`, the one method that goes through simctl.

- [x] **#77 DONE 2026-08-18. A `delete()` that fails no longer leaves the udid
  wedged shut.** The shutdown/delete pair is wrapped: any failure other than
  `SimulatorNotFoundError` calls `reopenCompanion` before rethrowing, so a
  simulator that is still there is still drivable. A mapped
  `SimulatorNotFoundError` — someone else deleted it first — instead marks the
  handle deleted and runs `recovery.forget`, so the thrown error is the only
  difference between that and a delete that worked, and the companion stays
  blocked because there is nothing left to drive. Tests:
  `test/simulator.test.mts`, "a delete that fails for a real reason reopens the
  companion" (asserts the reopen lands *after* the failed simctl call, via the
  fake's ordered call log, and that the handle still works) and "a delete that
  finds it already gone marks the handle stale anyway" (no reopen, recovery
  forgotten, and the handle touches deps no further). TESTING_LIBRARY.md
  records why the e2e cannot reach either path.

  Original finding: `closeCompanion` ran first (correctly), but a `simctl
  delete` that then failed for a real reason threw without `reopenCompanion`,
  so every later read on the still-existing simulator, from any handle in the
  process, failed inside `companionFor` with an untyped `IdbError` ("is being
  shut down"). Related edge: an already externally deleted simulator propagated
  the mapped `SimulatorNotFoundError` while `this.deleted` stayed false and
  `recovery.forget` never ran.

- [x] **#78 DONE 2026-08-18. `parseLaunchPid` requires a delimiter before the
  pid.** `/[:\s](\d+)\s*$/` rather than `/(\d+)\s*$/`, so the digits have to be
  separated from the bundle identifier by the colon or space simctl puts there.
  Every real reply parses exactly as it did; a reply that is only a
  digit-ending identifier now stays null instead of reporting its own suffix as
  a process id. Test: `test/lifecycle.test.mts`, "does not read a digit-ending
  bundle id as a pid". TESTING_LIBRARY.md's item 4 records why the fixture
  cannot show this one — `com.example.mcptestapp` does not end in a digit.

  Original finding: `lifecycle.ts:229` matched `/(\d+)\s*$/`. The doc claimed a
  no-pid reply "stays null", but if such a reply is just the bundle id and the
  id ends in digits (`com.example.app2`), the trailing digits parse as a pid.

- [ ] **#79 Custom `resizeTo: {width, height}` is applied before rotation, so
  a landscape screenshot comes back transposed.** In `captureScreenshot`
  (`capture.ts:260`) the resize acts on the portrait capture and the rotation
  follows — correct by construction for `"points"`, but a caller asking for
  `{width: 800, height: 600}` in landscape receives 600×800. Decide the
  contract: either document that explicit dimensions are interpreted in
  portrait space, or swap them when a rotation is coming. Either way the
  `ScreenshotOptions.resizeTo` doc should say which.

- [x] **#80 DONE 2026-08-18. `startRecording` arranges everything it owes the
  child in the same window as the spawn.** `trackRecording` and the `close`
  handler are attached before `await started`, keeping the identity guard. The
  early listener alone turned out not to be enough, and the test is what said
  so: a close arriving before the handle has published the recording finds
  nothing of its own to clear, and the publish that follows would store a
  process that had already gone. So the same handler sets a `closed` flag and
  the publish is skipped — the handle ends the call with no active recording
  rather than with a corpse, which is the stated observable ("able to start a
  new recording"). Test: `test/capture.test.mts`, "a recording that dies the
  instant it starts releases the handle too", verified to fail against the
  previous ordering before being kept. TESTING_LIBRARY.md records why the
  fixture cannot stage this.

  Original finding: `simulator.ts:1870` attached the `close` cleanup after
  `await started`, so a recording that said "Recording started" and then died
  while `started` was being awaited emitted `close` before the listener
  existed; `this.recording` then held a dead child and the handle refused new
  recordings until a manual `stopRecording()`.

- [x] **#81 DONE 2026-08-18. The spawned bootstatus child has an `error`
  listener.** Folded into #75's rewrite of the same function, as that item
  said to. Treated exactly like an exit — stop waiting, let the poll decide
  readiness — rather than propagated, since there is nothing here a caller
  could act on. Test: `test/lifecycle.test.mts`, "a spawn that cannot run the
  binary is a wait ended, not a crash", which emits `error` on the fake child
  and would take the test process down without the listener.

  Original finding: if `deps.spawn` cannot execute the binary, the unhandled
  `error` event crashes the process (EventEmitter semantics). Effectively
  unreachable on a working macOS box, but it was the only unguarded spawn in
  the library — `awaitReadiness` and `waitForRecordingStart` both handle it.

- [x] **#82 DONE 2026-08-20. Both named sites carry codes; one further site is
  deliberately left untyped and now says so.**
  - **The closed-udid refusal is `SimulatorNotFoundError`.** `delete()` is the
    only thing that closes a udid, so a call arriving at the refusal is a call
    racing a teardown, and the caller's remedy is the one the stale-handle
    check gives it a moment later. The prose is kept as an override, so
    "being shut down" still distinguishes it from a udid that was never there.
    Overstated only by a `delete()` that then fails and reopens — a caller who
    asked for the deletion, getting a momentary "gone" instead of an
    unbranchable error.
  - **The window this closes is narrow and was the whole bug.** `withClient`
    resolves a companion failure by asking simctl, so a udid already gone came
    back typed anyway; between `closeCompanion` and the end of `simctl delete`
    the device is *still listed*, so the raw error was rethrown as caught.
    That path now has its own test.
  - **`readLock`'s two failures are `CompanionDownloadError`.** The lock file
    is what a download is made from, so missing or unparseable is the download
    path failing before the network, with the same remedy. The code's gloss
    widened to "HTTP failure, checksum mismatch, or no readable pin to fetch"
    in both `errors.ts` and SIMGADGET.md. `readLock` takes an optional path now
    — the shipped file always exists, so neither branch was reachable in a test
    otherwise.
  - **Left untyped on purpose, with a comment saying why:
    `SIMGADGET_COMPANION_PATH` pointing at a missing file**
    (`companionBinary.ts`). Nothing in the frozen `ErrorCode` union is honest
    about it: no download was wanted — avoiding one is what the override is for
    — and nothing was spawned. Typing it means *adding* a code, which is a spec
    change and your call, not a tidy-up. Same reasoning covers the three
    remaining `IdbError`s in `companionManager.ts` (socket dir not ours, uid
    mismatch, sun_path overrun), which are environment pathologies a caller can
    only read.

## Spec / plan deviations needing sign-off or a doc fix

- [ ] **#83 Contract check 8's `--wedge` flag was never implemented, and the
  variation is unsigned.** The plan specifies it; the script instead documents
  (convincingly — see #69's measurements) that a wedge cannot be manufactured
  on demand and that the empty-point half is the load-bearing half. The plan's
  rule is sign-off *before* the variation is written; nothing in the repo
  records it. Same story as `(string & {})` replacing the spec's `| string`.
  Both are probably right; both are currently unverifiable — see #74.

- [x] **#84 DONE 2026-08-20. The doc carries the caveat; the behaviour is
  unchanged.** `TapOptions.durationSeconds` now says that passing less than the
  floor changes nothing *about the touch*, and that setting it at all makes a
  `{label}` tap at a toggle a hold — refused with `ToggleGestureError` even
  below the floor, because asking for a duration is what marks a caller as
  wanting a real press. SIMGADGET.md's copy of the type says the same in one
  sentence.
  - **Not fixed the other way round on purpose.** Treating a sub-floor duration
    as plain would hand a caller who asked for a press an activation instead —
    a different verb, quietly. The refusal is the honest answer.
  - The pure layer already pinned it (`tap.test.mts`, "a switch, held for less
    than the floor"); the public layer now does too, at the exact call in this
    entry.

- [ ] **#85 Plan step 5's `describeObstruction(atPoint)` pure extraction does
  not exist.** The behaviour lives in `TapObstructedError`'s constructor and
  is covered at the fake layer and in the e2e — missing named extraction, not
  missing coverage. Extract or strike it from the plan with a note.

## Comments that do not match the code

- [x] **#86 DONE 2026-08-18. All six corrected; no behaviour changed.**
  - `ax/tree.ts` — the closed type's doc now says `index.ts` publishes it as
    `AXElement`, and names `RawAXElement` as the internal open one.
  - `simulator.ts:46` — the import comment described an aliasing that is not
    there: `ax/tree.ts` exports both names itself, and the comment now says
    which is which without inventing a rename.
  - `lifecycle.ts` — `deriveDeviceName`'s doc moved back onto
    `deriveDeviceName`; `parseLaunchPid` and its own doc had been inserted
    between the two.
  - `simulator.ts` — `HID_BUTTON`'s "unlike `HID_ORIENTATION` above" is now
    "further down this file", which is where it is.
  - `test/fakes/idb.ts` — the action-API "found no element" wording is pinned
    by contract check 12, so the header no longer claims it is unpinned; the
    flag is now a pointer to the check.
  - `lifecycle.ts:25` and `internal/registry.ts` — both step-narrating headers
    rewritten in the present tense, describing what the files hold rather than
    the order they were built in and then patching themselves.

- [x] **#87 DONE 2026-08-18. TESTING_LIBRARY.md's duplicate item 4 and its
  test count.** The stale second copy — which claimed the `launchApp` pid parse
  was "faithfully ported" and unasserted, contradicting the corrected item
  immediately above it — is deleted. The heading now says 507 unit tests, which
  is what the suite reports after this session's additions.

## Housekeeping

- [ ] **#88 Repo hygiene.** `.DS_Store` is untracked and not in `.gitignore`.
  (`companion.lock.json` and `package.json` still pointing at the old repo
  path is **correct** for this phase — plan Risks says so; do not "fix" it.)
  - **Corrected 2026-08-20:** this entry also claimed
    `packages/simgadget/build/` was committed alongside `src/`. It is not —
    `git ls-files` returns nothing under it and `.gitignore` has `build/`.
    The real hazard is the opposite one: `exports.test.mts` does
    `require("simgadget")`, which resolves through `build/index.js`, so the
    exports assertions run against **whatever was last compiled**. Change the
    public surface without rebuilding and that test passes on yesterday's
    output. Worth wiring a build into `npm test` for the library, or having
    that test fail loudly when `build/` is older than `src/`.

# TODO — Production bug, reported 2026-08-15

- [x] **#60 FIXED 2026-08-15. The offset was in the tree all along, and we were throwing it away.**

  **Root cause.** A remote-hosted view's contents are not simply "in another coordinate space with nothing marking the boundary" — the boundary is a node of `type: "83"`, and it is the point at which the subtree restarts at a local origin. Its *parent* still describes that same region in screen space, and the two rectangles are the same size, because they are the same region named twice. The difference between their origins is the translation, exactly:

  ```
  Any "" {x:0 y:476 w:402 h:340}        <- hosting window, screen space
    83  "" {x:0 y:0   w:402 h:340}      <- boundary: same size, origin reset
          Button "Close"                {x:351 y:16  ...}   -> screen y=492
          Button "Fill Strong Password" {x:36  y:239 ...}   -> screen y=715.33
  ```

  `239.33 + 476 + 22 = 737.33`, which is where the button is. **No probing, no hit-testing, no extra RPC** — candidate fix 2 below assumed ~30 point reads to recover an offset the tree already carried. What hid it was our own `pruneTree`: it drops anonymous containers and hoists their children, which discards the very parent the offset is measured against. The old flat tree was the pruned one.

  **Why the type check alone was not trusted.** `83` is a bare number because it has no name — it falls outside the role vocabulary idb maps, so it arrives stringified — and an undocumented magic number is a poor thing to move coordinates on. So the geometry has to agree before anything moves: the boundary node's size must match its parent's. That guard is what makes the arithmetic self-validating, and it is what the second test case below exercises.

  **Verified on two remote-hosted views, which differ in the way that matters:**

  | view | hosting window | offset | tree before | tree after |
  |---|---|---|---|---|
  | "Use Strong Password?" sheet | `{0, 476}` | (0, 476) | y=239.33 **wrong** | y=715.33 ✓ |
  | photo picker (`PHPicker`) | `{0, 0}` | (0, 0) | y=86 **already right** | y=86, untouched ✓ |

  The picker is the case that kills "sheets are wrong, shift them": it is hosted exactly the same way and its frames are already correct, because its window is at the screen origin. Both fall out of the one formula. Confirmed by hit-test: the picker's `Collections` at its reported centre (248, 110) resolves to `Collections`, and tapping it switched the picker to Collections.

  **End to end, on a simulator created from scratch:** `ui_tap {label: "Fill Strong Password"}` now presses the button — the sheet dismisses and the password field fills with a generated password. It previously pressed **Login Submit** and reported `Tapped successfully`.

  **`ui_describe_point` was fixed too, because the tree fix would otherwise have broken it.** A point read hit-tests, so it names the right element wherever it lives, but it returns one element and no ancestry — and the ancestry is where the offset comes from. It therefore kept answering `y=239.33` while the tree said `715.33`, which is a fresh instance of exactly what #58 was closed to prevent. A frame that does not cover the point it was found at is the signature, and it is free to check; on that signal only, the tree is read and the frame replaced (never the identity, which the hit-test established). Costs ~350ms on the broken path and nothing on every other read — verified: `Login Submit` at (201, 271) still answers straight from the point read. Both tools now report `y=715.33` for the same button.

  **Implementation:** `translateRemoteSubtrees` and `locateInTree` in [src/ax/tree.ts](src/ax/tree.ts), pure and unit tested (103 assertions, ~100ms). `describeScreen` translates before pruning. The tests were checked against three deliberate mutations — dropping the size guard, reversing the offset sign, and accumulating the offset instead of replacing it at each boundary — which failed 2, 4 and 2 assertions respectively.

  **The point-read trigger was wrong first time, and only the timing run caught it.** The condition started as "the frame does not cover the point", which is not evidence of anything: a control's touch target is routinely larger than its accessibility frame, so on the home screen a read at (200, 400) hit-tests to the Health icon, whose frame ends at x=188.67 — 11 points short. Every such read then paid a whole-screen lookup for an element that was never mislaid, and **nothing failed**: the answers stayed correct, `ui_describe_point` just went from ~10ms to **313ms**. TESTING_TOOLS.md Part 4 is what noticed, which is the argument for keeping a timing row on a tool whose cost can change without its output changing. `isRemotelyHosted` now requires the miss to exceed 44 points — Apple's minimum touch target, so a ceiling on legitimate overshoot — and ignores zero-sized frames. Measured after: **9 ms**. The autofill case misses by 454, so it still fires.

  **What is not covered.** An AXBRIDGE *marker* query returns local frames too (confirmed: it finds the button at y=239.33 where the AX marker query finds nothing at all). It is not reachable today — `findByLabel` only ever sends markers to the AX backend, and its miss is what routes these lookups through the corrected tree — so this is a note for whoever changes that, not a live bug.

  <details>
  <summary>Original report and investigation, kept as the record</summary>

- [x] **#60 (original) Elements inside a remote-view sheet report frames in the sheet's own coordinate space, so `ui_tap {label}` taps the wrong place and says it succeeded.**

  Reported from production: an agent on a login screen, with iOS's **"Use Strong Password?"** autofill sheet up, was given a tree whose frames disagreed with the screen. It diagnosed the cause itself and was right.

  **Symptom.** On a 402x874 screen with the sheet at the bottom, the tree reports the sheet's contents near the top:

  | element | tree `y` centre | actually on screen | delta |
  |---|---|---|---|
  | `Close` (✕) | 30.7 | ~507 | ~476 |
  | `Use Strong Password?` | 160 | ~635 | ~475 |
  | `Fill Strong Password` | 261 | ~738 | ~477 |

  `x` is already screen space (the ✕ centre reads 365.3 against ~365 on screen), because that sheet's window starts at x=0. A window not spanning the full width would be wrong in both axes. The app's own elements in the same tree are correct — `Create account` at y=415+44/2 = 437 matches the screen — so **one tree mixes two coordinate spaces with nothing marking the boundary**.

  **Consequence, and why it is the priority.** `ui_tap {label: "Fill Strong Password"}` resolves the label to that frame, taps its centre (201, 261), and returns `Tapped successfully`. Verified: `ui_describe_point(201, 261)` returns the login form's `ScrollArea`. The tap lands on the password field. The caller is told it worked, and the tree that would contradict it is the same tree that lied. Tapping by label is the documented, cheapest navigation path, so the failure sits on the route agents are told to take.

  **Measured on the reported simulator** (`whisky-autofill_iphone-16-pro`, `0F37F84D-8B42-4397-A9DD-E5184E814B82`), attached read-only:
  - `ui_describe_point(201, 738)` — the button's true position — returns the right element, `AXUniqueId: GenerateStrongPasswordButton`, but with the same wrong frame `{x:36, y:239.3, w:330, h:44}`. **So the frame is local-space in both backends**; hit-testing finds the element, it just cannot tell you where it is.
  - With `pid` and `is_remote` temporarily added to the key set: every element in the AXBridge tree, sheet included, reports `pid: 89215` (the app) and `is_remote: false`. The AX point read at the true position reports **`pid: 89486`** — the remote view service. **The tree carries no signal at all; the point read does.**

  **Upstream does not translate these either**, so this is not us mis-reading a field. `discoverRemoteElements` in [FBAXTranslationRequest.swift:204](vendor/idb/FBSimulatorControl/Commands/FBAXTranslationRequest.swift:204) grid hit-tests for other processes and serializes `hitElement.axFrame()` verbatim, marking the result `isRemote: true`; nothing anywhere adjusts for the hosting window's origin.

  **There is a workaround today**, and it is worth telling users about regardless of the fix: `ui_view` returns logical space in portrait — the same space `ui_tap` takes — so an agent can read the button's position off the screenshot and tap explicit coordinates. Confirmed: (201, 738) read off the screenshot hit-tests to the button. It costs a screenshot per step, asks the model to eyeball a position, and stops being true once the device is rotated.

  **Candidate fixes, cheapest first.** Not yet decided:
  1. **Verify before tapping.** `ui_tap {label}` already has the frame; hit-test its centre first (~10ms) and if the element there is not the one that was resolved, refuse rather than tap, and say the position is untrustworthy and to use `ui_view` with coordinates. Turns a silent wrong action into a plain answer — the same shape as `rotate` reporting the orientation it read back. Does not fix the frames.
  2. **Locate the element for real.** Having detected the mismatch, recover the window offset by probing: the size is right and the offset is shared by every element of that window, so scanning for one edge calibrates the rest. Roughly 30 point reads, ~300ms, only on the broken path. Fixes tapping; the tree still reports local frames to anyone reading it.
  3. **Tap by accessibility instead of by coordinate.** idb exposes an `accessibility_action` RPC whose `Tap` targets a marker, and the accessibility backend implements it as `AXPress` — [FBAccessibilityUIAutomation.swift:92](vendor/idb/FBSimulatorControl/Commands/FBAccessibilityUIAutomation.swift:92), which says outright that it does not synthesize a touch. Immune to the whole problem, but: `AXPress` is not a real touch and some controls respond differently, a hold duration is unsupported, and **it is untested whether a marker query resolves an element in another process at all** — our marker path already misses system chrome, which is why the AXBridge fallback exists. Worth an experiment before it is worth a design.

  **Try upstream first (the user's call, and the cheapest move).** We pin `da0f89a`; upstream has been active. Before building anything, run a current `idb_companion` against this exact screen and see whether remote frames are translated now — this is precisely the kind of thing their remote-content work would touch. If it is fixed there, this becomes a submodule bump. See #49 for how upstream releases are consumed, and note #36b — the searchbar issue we were going to add findings to — is adjacent.

  **Reproducible in `testapp/` — recipe below, validated on a simulator created from scratch.**

  The blocker was never the field configuration. `testapp` had `.username`, `.newPassword` and `secureTextEntry` from the first attempt, read back live from UIKit as `config: user=username pass=new-password secure=YES`, and iOS still would not offer a password. **What was missing was an `application-identifier` entitlement.** Offering to *generate* a password means offering to *save* it, saving means the keychain, and an app with no keychain identity is refused — the same failure Apple reports as *"Cannot show Automatic Strong Passwords ... Cannot identify the calling app's process. Check teamID and bundleID in your app's application-identifier entitlement"*. The reported app has exactly one entitlement, `application-identifier = 75KCDCRBC7.uk.whiskyreview.app`, in its binary's `__TEXT,__entitlements` section; ours had no such section at all. `testapp/entitlements.plist` now supplies one with an invented team prefix, which a simulator does not check, and `build.sh` embeds it the way Xcode does for simulator builds (`-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements`).

  **Recipe — four steps, no device preparation at all.**

  1. `testapp/build.sh` — the entitlement must be in the binary. Check with
     `otool -l testapp/build/MCPTestApp.app/MCPTestApp | grep -A2 __entitlements`.
  2. `start_simulator`, then `install_app` and `launch_app` the fixture.
  3. `ui_tap {label: "Show Login"}`, then `ui_tap {label: "Login Password"}`.
  4. The **"Use Strong Password?"** sheet appears across the bottom of the screen.

  **Validated on a simulator created from scratch for the purpose**, with nothing done to it beyond installing the fixture. Two beliefs held during the investigation turned out to be wrong, and the clean run is what settled them:

  - **A saved password is not required.** The sheet appeared with an empty store — verified afterwards by opening the Passwords app on that same simulator and finding it still showing its first-run onboarding, then `All: 0`. The earlier belief came from testing on a simulator that had been primed by hand.
  - **No Settings changes are required.** `AutoFill Passwords and Passkeys` and `Suggest Strong Passwords` are on by default; check them only when diagnosing a failure to reproduce.

  A saved credential can in fact *prevent* the sheet: an entry for `example.com` fuzzy-matched the bundle id `com.example.mcptestapp`, and iOS answered with a *fill* suggestion for that credential instead of generating one. If a store has entries, keep them on sites that cannot match the fixture.

  **What it then reports**, on a 402x874 screen with the sheet occupying roughly y=460 downwards:

  ```
  ui_find "Fill Strong Password"        -> frame y=239.3  =>  ui_tap would tap (201, 261)
  ui_describe_point(201, 261)           -> "Login Submit"      <- what the tap actually hits
  ui_describe_point(201, 738)           -> "Fill Strong Password", frame y=239.3 again
  ```

  So in the fixture the mis-tap is not merely harmless: `ui_tap {label: "Fill Strong Password"}` presses **Login Submit** and reports `Tapped successfully`.

  Not needed, despite early guesses: the software keyboard (the sheet appears with a hardware keyboard attached), any Settings change beyond confirming the defaults, an associated domain, or a real Apple Developer team.

  </details>

  **Searched for prior art before building anything — we are not the only ones, and nobody has fixed it.**

  - **Appium hits the same class through an entirely different toolchain.** Their XCUITest driver documents it as a standing limitation: elements belonging to another process have coordinates in that process's own context, and their answer is not to translate but to *switch which application is active* (`respectSystemAlerts`, `defaultActiveApplication`, `mobile: activateApp` on springboard) — see [their troubleshooting guide](https://appium.github.io/appium-xcuitest-driver/latest/troubleshooting/). [appium/appium#11324](https://github.com/appium/appium/issues/11324), "incorrect element location for native Share dialog buttons", is our bug in a share sheet: coordinates found, taps land elsewhere, manual coordinates off a screenshot work. Open, unresolved. That it reproduces through WDA/XCUITest and not just idb is what says this is Apple's layer, not idb's — and it is why "try a newer companion first" was never likely to pay.
  - **Nobody publishes a translation.** No fix in idb, WDA, Maestro or Mixbox. [facebook/idb#892](https://github.com/facebook/idb/issues/892) (the #36b searchbar issue) is still the closest neighbour and still unanswered.
  - **The `simctl` recipes for suppressing the sheet that circulate are cargo cult.** Both were tested on iOS 26.5 against the fixture, and **neither has any effect** — the sheet appears exactly as before, verified by `ui_find` still returning the button:

    ```bash
    xcrun simctl spawn "$UDID" defaults write com.apple.UIKit.StartUpOptions DidShowStrongPasswordIntroduction -bool true   # no effect
    xcrun simctl spawn "$UDID" defaults write com.apple.Passwords AutoFillPromptDisabled -bool YES                          # no effect
    ```

    Both writes land (`defaults read` confirms), and `com.apple.Passwords` had no such key beforehand, which is the tell that nothing reads it. `killall cfprefsd` — the step every blog post insists is the one people miss — **does not exist in the guest**, so that advice cannot be followed as written either. Apple's own forum thread on this ([728529](https://developer.apple.com/forums/thread/728529)) has one reply in three years and no solution.
  - **Suppression was the wrong goal anyway**, which is worth recording because it is where an afternoon could have gone. Turning autofill off would hide one instance of a bug that belongs to every remote-hosted view — pickers, share sheets, Sign in with Apple — and would change the behaviour of the app under test. The fix above is indifferent to which one is on screen.

# TODO — Observed 2026-08-15

- [x] **#64 DONE. `ui_tap` no longer reports success for a touch that could not have worked.** A review of the whole tool after #62/#63, since both had turned out to be instances of one habit — answering `Tapped successfully` whatever happened.
  - **#64a Verify before tapping.** A frame can be exactly right and still not be tappable at its centre: an element under a toolbar, behind a keyboard, or below the fold keeps its place in the tree while its centre belongs to whatever is drawn over it. Demonstrated on our own fixture — `ui_tap {label: "Plain Stepper, Increment"}` focused the **toolbar's search field**, opened the keyboard, and answered `Tapped successfully`. Every frame involved was correct, so nothing in the tree could have revealed it. `ui_tap` now hit-tests the point it is about to touch (~10ms against a tap that costs ~110ms) and **refuses**, naming what is in the way. Coordinates are exempt: `ui_tap {x, y}` is the caller saying where.
  - **#64b Say what was tapped.** `Tapped "Toolbar Button" (Button) at (102, 822).` rather than `Tapped successfully`. This is the answer to #3 in the review — the fast path physically cannot detect ambiguity (the companion resolves a marker with `elements.first`, server-side, and returns one element with no sign that others matched), so the affordable move is to name what was acted on, where a caller sees it immediately instead of deducing it from the aftermath. It paid immediately: `Tapped "Split Switch" (StaticText)` explains that boundary case without a word of documentation.
  - **#64c Rank the tree path's candidates.** Free, because `matchInTree` already collected them and merely took `[0]`. An exact name beats a partial one; a control beats prose. Every collision on record is that shape — a status line reading `Settings Switch = on` beating the switch, a permission alert's sentence beating the Photos icon, a wizard's body text beating the Collections tab. **Deliberate behaviour change:** an enclosing container no longer wins on document order alone, and the test that pinned the old rule was rewritten rather than made to pass.
  - **#64d Refuse a disabled control**, instead of touching it and reporting success — the symptom was otherwise indistinguishable from a mis-aimed tap. Free; the element already carries `enabled`. The fixture gained a `Disabled Button` for it, wired to an action it must never fire, and the refusal was checked against a real coordinate tap at the same place: `status: ready`, unchanged. TESTING_TOOLS.md #48.
  - **#64e Look up by accessibility identifier.** The tree publishes `AXUniqueId`, so a caller handing one back is doing the obvious thing, and used to get "No element found" for a name it had just been given. Tried after the label, so it costs ~15ms only once that has missed.
  - **#64f A toggle with a hold or a multi-tap now refuses.** Introduced by #63's own escape hatch: those keep the real touch, and a real touch at a toggle's centre lands in the gap. Measured doing exactly that, silently. It cannot be caught by #64a either — the switch's frame spans the row, so the centre hit-tests *to the switch* and looks perfectly consistent.
  - Covered by TESTING_TOOLS.md **#49**, which checks the refusal and then checks three ordinary taps still work — an over-eager guard would be worse than the bug it prevents.

- [x] **#66 DONE — and it was a regression of my own making.** `ui_tap {label}` on a toggle the action API cannot reach now falls back to a real touch instead of erroring.
  - **What #63 broke.** `AccessibilityActionRequest` has **no `backend` field**, where `AccessibilityInfoRequest` does — so a *lookup* can fall back to AXBridge and an *activation* cannot. Anything only that backend can see is therefore findable and not activatable. Before #63 such a switch was tapped by coordinate and worked; #63 routed every toggle through activation and turned that into `INTERNAL: The accessibility backend found no element ...`, with `ui_find` and `ui_tap` contradicting each other about an element plainly on screen.
  - **The irony worth keeping:** #63 exists because a switch's frame is usually not its control. In this case it *is* — the toolbar switch's frame is the switch — and the fix stopped using the geometry that would have worked.
  - **Fix:** activation failing with "found no element" hands the tap back to the ordinary coordinate path rather than throwing, so it gets the 100ms hold and the hit-test verification like any other tap. Measured: `Tapped "Toolbar Switch" (Switch) at (201, 822).` and `status: toolbar toggle = on`, round-tripping, while `Settings Switch` still answers `Toggled Settings Switch off -> on`. The two verbs must stay different — a build where both say the same thing has lost one of the mechanisms.
  - **Found by chasing the last open item of the #64 review** rather than by a report, which is the argument for finishing that list: the combination nobody had exercised was not exotic, it was a switch in a toolbar.
  - **Residual, and not fixable here:** a toggle whose frame is *also* not its control, inside a view the cheap backend cannot see, is unreachable by name. That needs `backend` on `AccessibilityActionRequest` upstream — the same shape as #42's missing `filter`, and the second candidate if patches are ever sent.
  - Covered by TESTING_TOOLS.md **#47**, with a fixture switch in the toolbar for it.

- [x] **#67 WONTFIX — the AXBridge tree reports `enabled: true` for a control that is disabled, and that is upstream's, not ours.** Found running Part 2 against the fixture's `Disabled Button`: `ui_find` answers `enabled: false` while `ui_describe_all` answers `true` for the same element.
  - **Attributed properly before writing it off**, by reading both backends straight from the companion with no pruning, canonicalise or reconciliation in the way:

    | backend | the disabled button | elements reported disabled anywhere |
    |---|---|---|
    | default (AX) — what `ui_find` uses | `enabled=false` | 1 of 22 |
    | AXBRIDGE — what `ui_describe_all` uses | `enabled=true` | **0 of 76** |

    The second row is the finding: AXBridge does not get this control wrong, it never reports *anything* disabled. The field is uniformly `true` and carries no information. Nothing of ours touches it.
  - **Not fixed, deliberately.** Dropping `enabled` from the tree loses a field that is right for every enabled control; re-reading each element through the other backend puts a second round trip on the path whose whole purpose is to be cheap. Both cost more than the fault, which errs only towards optimism.
  - **Barely reachable in practice:** `ui_tap {label}` resolves through the AX backend first, so it sees the true value and refuses a disabled control (#64d). The gap is elements only AXBridge can see — system chrome, which is already the awkward corner for #66.
  - Documented for users in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) under "`ui_describe_all` says a greyed-out control is enabled", with the table above and the instruction to trust `ui_find`.

- [x] **#65 DONE. The behaviours we assume of `idb_companion` are now checked, because they are somebody else's and nobody upstream has promised to keep them.** `scripts/check-companion-contract.mjs`, run with `npm run check:companion -- <udid>` against the fixture. Prompted by how much of this session's work rests on undocumented behaviour of a binary under active development.
  - **What it checks, and why each is load-bearing:** a marker match is a substring (every partial name an agent uses); it resolves to the **first** hit server-side (why ambiguity is undetectable on the fast path, hence #64b/#64c); it returns one element rather than a list (`findByLabel` would mis-parse a list rather than reject it); the default backend cannot see toolbar contents while AXBridge can (the whole reason for the ~300ms fallback); a point read hit-tests in under 100ms (or #64a's verification stops being affordable); `accessibility_action` activates without a touch (#63 has no mechanism at all without it). Plus, under `--remote`, that a hosted view still restarts its coordinate space at a node of type `"83"` (#60).
  - **Calibrated against a companion that genuinely differs**, rather than only ever seen passing: the 2022 brew build **fails five of the six**, reporting among other things that `accessibility_action` is `UNIMPLEMENTED`. The `--remote` check was likewise confirmed to fail with no sheet on screen, so it is not vacuous.
  - Every one of these is invisible while it holds — that is the point. A companion that changed its mind would leave this server doing the wrong thing quietly, which is the failure mode this whole file is a record of.


- [x] **#62 FIXED. Every tap this server has ever sent was instantaneous, and an instantaneous touch actuates a control about half the time.** Found while investigating #63 — a coordinate tap aimed squarely at a Settings switch failed twice in a row, which was not supposed to be the interesting part of that session.
  - **Measured rather than inferred, because single samples are worthless on an intermittent fault.** Tapping the Sound switch in Settings > General > Keyboard, 10–12 trials each, reading `AXValue` back between every one:

    | companion | instant (what we sent) | 0.1s hold |
    |---|---|---|
    | pinned `da0f89a` | **5/12** `.Y..Y.Y.YY..` | **12/12** |
    | brew `1.1.8` (Aug 2022) | **1/10** `.....Y....` | **10/10** |

  - **Not a regression in any version.** Both companions behave the same, so this is what a zero-length touch has always been worth. `client.tap` sends touch-down and touch-up with nothing between unless a caller passes `duration`, and almost no caller does — the parameter existed and was documented as "Press duration", which reads like a long-press knob rather than the thing that makes a tap land.
  - **This is the likeliest explanation for every "the tap said it worked but nothing happened" we have chased**, and it is worth remembering before blaming a coordinate again. It also means the fixture's own suite was passing on taps that could have failed.
  - **Fixed as a floor, not a default**: `MIN_TAP_HOLD_SECONDS = 0.1` in [src/index.ts](src/index.ts), applied to both the label and coordinate paths, so a caller asking for less gets 0.1 anyway. 0.1s is well under UIKit's 0.5s long-press threshold, so nothing that was a tap becomes a long press. Verified through the real tool over HTTP with no duration given: **12/12**, and ordinary navigation rows still tap normally.

- [x] **#63 FIXED. `ui_tap {label}` now operates a toggle instead of aiming a touch at it.**
  - **The decision, and it was a decision rather than a bug fix.** `ui_tap {label}` has never been literal: it matches substrings, folds curly apostrophes (#38), matches an element's *value* when it has no label (#23) and falls back to a different backend when the first cannot see the control (#39). It is "find this thing and operate it"; `ui_tap {x, y}` is the literal touch. So the split is now explicit — **coordinates are always a real touch, a label operates the control** — and no flag was needed to say so.
  - **The cost, stated plainly:** `AXPress` does not hit-test, so it will operate a switch a finger could not reach — one under an invisible overlay, say. A touch would catch that. Two things make the trade acceptable: the coordinate form is still there for anyone who needs touch fidelity (and #62 made it reliable), and the tool now **reports the value it read back** — `Toggled Sound off -> on` — so a false pass is visible instead of silent. Every expensive bug in this file has been a silent success; `rotate` reporting the orientation it actually got is the same principle.
  - **Scope:** toggles only, decided by `isToggle` — a switch/checkbox type *with a value*, which is what separates a thing that is switched from a thing that is pressed. A `duration` or a multi-tap keeps the real touch, since a hold is a gesture and `AXPress` cannot express one. Steppers already work (they publish labelled Increment/Decrement children). Sliders remain a gap: `AXPress` does nothing useful on one, and they would need `setValue`.
  - **Three shapes now in the fixture**, because one example would have hidden the rule:

    | fixture control | how iOS publishes it | tap by name |
    |---|---|---|
    | `Settings Switch` | one element — the switch, reporting the whole row as its frame | **works** (activated) |
    | `Plain Switch` | a bare `UISwitch` whose frame the stack stretched to 282pt around a 63pt control | **works** (activated) |
    | `Split Switch` | *two* elements — a StaticText carrying the name, an unnamed switch beside it | correctly does nothing |

    `Plain Switch` is the one that kills a geometric fix on its own: it is not merged at all, its frame is simply wider than the control, and the control is at the **leading** edge where Settings' is trailing.
  - **Two wrong turns worth keeping, both about the fixture rather than the fix.** A `UITableViewCell` with a switch accessory *looks* like a Settings row and is not one: UIKit fuses the label and value into an element of its own making, 52 points high (the row) rather than 28 (the switch), and activating it routes nowhere — so the row published a switch that nothing could operate. The real Settings element is the control with a widened frame, which is why it activates. Second: `accessibilityFrameInContainerSpace` is declared on `UIAccessibilityElement` only; assigning it to a view compiles through `id` and dies at runtime with `doesNotRecognizeSelector`. `UIAccessibilityConvertFrameToScreenCoordinates` in a getter is the working form, and does not go stale on scroll.
  - **A read-back keyed on a label is not safe**, found when the second toggle in a row silently became a coordinate tap: the fixture's status line said `Settings Switch = on`, which *contains* the control's name, so the lookup resolved that sentence instead of the switch. The confirming read is now keyed on `AXUniqueId` where there is one (`findByIdentifier`), and the fixture reports in lower case so it collides with nothing. Any app that echoes a control's name in its own UI would have hit this.
  - Covered by **TESTING_TOOLS.md Part 4**, which checks the name path and the coordinate path together on purpose: they are different mechanisms that regress independently, and when a toggle stops working the first useful fact is which one broke.

- [x] **#63-orig `ui_tap {label}` cannot toggle a switch row, and never could.** Reported from production against "Suggest Strong Passwords", reproduced here on Settings > General > Keyboard > Sound. The tap is delivered and reports success; the switch does not move.
  - **The report's proposed fix does not apply.** It described an unlabelled child `Switch` at the row's trailing edge to tap instead. There is no such child: AXBridge returns the row as an anonymous childless node (`uid=keyboard-audio`), and the AX backend returns a single **merged** element — `role_description: "switch"`, `subrole: AXSwitch`, `traits: [Button, Toggle, …]`, `AXValue`, `children: []`. Hit-testing the switch itself at (340, 495) returns that same row-spanning frame, so **accessibility cannot locate the control within the row at all**.
  - **So the centre is the wrong place by construction**: the merged frame `{36, 481.33, 330, 28}` spans label and switch, and its centre (201, 495) is the gap between them. Measured 0/6 and 0/8 there, with and without a hold, on both companions — this is not #62 wearing a disguise.
  - **A geometric rule cannot fix it.** Settings puts the switch at the trailing edge; our own fixture's `Plain Switch` renders at the leading edge. "Tap the trailing edge" fixes one and breaks the other.
  - **It has never worked**, checked specifically because it felt like a regression: the 2022 companion resolves the identical frame and fails identically. Nothing was removed.
  - **What does work: the accessibility activate action.** idb's `accessibility_action` is implemented as `AXPress` ([FBAccessibilityUIAutomation.swift:92](vendor/idb/FBSimulatorControl/Commands/FBAccessibilityUIAutomation.swift:92)) — the same activation VoiceOver performs on the same merged element. Verified end to end: `AXValue` `1` → `0`, **and it persists** across navigating away and back, so it is a real commit rather than a UI-only flip.
  - **Not implemented pending a decision**, because it is a genuine change in kind: `AXPress` is not a synthesized touch, so it bypasses hit-testing and would not notice a control covered by an invisible overlay, and it cannot express a hold. Shape if it goes ahead: resolve with our own `findByLabel` (so #38 typography and #23 value matching still apply), then act keyed on `AXUniqueId`; keep a real touch whenever `duration` is given; and **report the value read back** rather than "Tapped successfully", since a silent success is what made this bug expensive. Untested: a toggle inside a remote-hosted sheet (#60).
  - Worth noting for whoever picks this up: with #62 fixed, a *coordinate* tap on a switch is now reliable, so the remaining gap is only "toggle by name".

- [x] **#61 WONTFIX — `scripts/imsmd.sh restart` deletes every simulator the server created, and that is being left alone.** CLAUDE.md tells you to restart after every build, so every code change costs a 40s boot, a reinstall and re-navigating to whatever screen was under test. It cost a validated reproduction outright during #60.
  - **Not fixed because the whole benefit is to developers.** No user of this server is ever affected: they start a simulator, use it, and destroy it. Making a restart preserve sessions means persisting the registry, re-adopting on startup, and replacing the garbage collector that daemon-exit currently *is* — roughly 100–150 lines plus a design decision about what guarantees leaked simulators are cleaned up. That is a lot of machinery to buy nothing but development speed.
  - **It also carries a hazard the size of the feature.** Other people's servers run on this machine, from this same checkout, on other ports. A shared registry file would let two servers re-adopt each other's simulators, and then one exiting would delete the other's — strictly worse than the problem being solved. Any implementation would have to key the registry per instance and never touch entries it did not write.
  - **There is a free mitigation, and it works — verified rather than assumed.** `IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false` already exists and stops the deletion; `scripts/imsmd.sh` forwards `KEY=VALUE` arguments as environment:

    ```bash
    scripts/imsmd.sh restart IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false
    ```

    Measured: a simulator created under that flag survives a daemon restart still **Booted**, with the app installed and the screen where it was left. `attach_simulator {id, udid}` re-adopts it and `ui_find` works immediately — so the 40s boot, the install and the navigation are all saved.
  - **What the flag does not do**, and why it is a mitigation rather than the fix: the session registry is in memory, so the new server has no record of the simulator. You re-attach by UDID, which means keeping the UDID around. An attached session is `owned: false`, so `destroy_simulator` only *detaches* — the simulator is then yours to `xcrun simctl delete`, and orphans accumulate silently until you do. Fine for a development loop where you know what you created; not something to make the default.

# TODO — Code Review Findings

## Bugs

- [x] **#1** `record_video` promise silently swallows failures — fixed: track process in `activeRecordings`, properly reject on close/error, prevent duplicates, `stop_recording` uses tracked handle
- [x] **#2** `ui_view` temp files never cleaned up — fixed: `finally` block cleans up all temp files; eliminated unnecessary portrait `copyFileSync`
- [x] **#3** Troubleshooting link points to wrong repo — fixed: `joshuayoes/` → `zafnz/`
- [x] **#4** ~~No `--` separator in `launch_app` and `install_app`~~ — Not a bug: simctl doesn't support `--` as an option terminator (treats it as a literal argument)
- [x] **#5** No signal handling — fixed: shared `shutdown()` wired to SIGINT/SIGTERM/stdin close, also kills active recordings

## Code Smell / Anti-patterns

- [x] **#6** Massive boilerplate repetition — fixed: extracted `handleToolError` wrapper, all 15 handlers use it
- [x] **#7** Inconsistent simulator lookup — fixed: renamed `getManagedSimulatorId` → `getManagedSim` returning full `SimSession` object, all inline `.get()` + null checks replaced
- [x] **#8** `getScreenDimensions` duplicates `describe-all` IDB call on every tap/swipe/describe_point — fixed: cached `screenDims` in `SimSession`, populated by `ui_describe_all`/`ui_view`/`getScreenDimensions`, invalidated on `detect_rotation`
- [x] **#9** `getIdbPath()` does `fs.existsSync` on every call — fixed: resolved once at startup as `idbPath` constant
- [x] **#10** Typo: `collectProbeCandiates` → `collectProbeCandidates` — fixed
- [x] **#11** `require("../package.json")` for version — fixed: read via `fs.readFileSync` at startup
- [x] **#12** Session ID allows dangerous characters — fixed: regex restricted to `[a-zA-Z0-9_-]+`
- [x] **#13** `ui_view` copies file unnecessarily in portrait — fixed as part of #2
- [x] **#14** `cleanupAllSimulators` runs sequentially — fixed: uses `Promise.allSettled` to shutdown/delete all owned sims in parallel
- [x] **#15** Recording processes not tracked — fixed as part of #1

## Minor

- [x] **#16** ~~`run()` always trims output~~ — Won't fix: all callers expect trimmed output (JSON parsing, UDID extraction, etc.); no current use case where trailing whitespace matters
- [x] **#17** ~~`open -a Simulator.app` on every start~~ — Won't fix: `open -a` is idempotent (brings to front if already running), cost is one lightweight subprocess; removing it would risk the simulator window not being visible after create+boot

# TODO — Observed 2026-08-12

Found while exercising the running server end-to-end (start → describe → view → destroy), not by reading source.

## Boot race

- [x] **#18** *(closed in 2.0.2 — start_simulator now polls until the simulator answers)* `start_simulator` returns before the simulator is actually usable. It reported success for an iPhone 17 Pro, but `ui_describe_all` and `ui_view` both failed for ~40s afterwards; once booted, both worked first try. Either poll for readiness inside `start_simulator` before returning, or make the return value say plainly that the sim is not yet ready.
- [x] **#19** *(closed in 2.0.2 — the error is rewritten to name the boot)* The error surfaced during that window is misleading: idb's `INTERNAL: No translation object returned for simulator. This means you have likely specified a point onscreen that is invalid or invisible due to a fullscreen dialog`. It blames invalid coordinates and a fullscreen dialog, neither of which is the cause. An agent hitting it will chase the wrong problem. Map this idb error to a "simulator still booting, retry" message.
  - Related but distinct symptom: the `describe-all` empty-tree case (0x0 root frame), where the fix is `simctl erase`. Worth distinguishing the two in whatever error mapping gets added.

## Schema accuracy

Both cosmetic — the server behaves correctly, the advertised schema just under-describes it.

- [ ] **#20** `ui_tap` marks only `id` as required, with `label`, `x` and `y` all optional, so "label **or** coordinates" is enforced only at runtime. A client validating against the schema alone would think a bare `{id}` tap is valid. Consider expressing the choice in the schema (oneOf / two variants).
- [ ] **#21** Inconsistent param types for the same concept: `ui_swipe.duration` and `ui_tap.duration` are strings with a numeric pattern (`^\d+(\.\d+)?$`) while `ui_swipe.delta` is a plain number. Easy to get wrong on first use.

# TODO — TESTING_TOOLS.md run, 2026-08-12

Found while working through TESTING_TOOLS.md step-by-step on an iPhone 17 Pro (root frame 402x874).

## Product bugs

- [x] **#22** *(closed by #40 — describe_all serves the AXBridge tree, verified 2026-08-14 with nav bar and toolbar children present)* **`ui_describe_all` returns an incomplete tree.** On the Settings screen it reports the bottom `Toolbar` group at `{{0, 788}, {402, 86}}` with `"children": []`, but `ui_describe_point(200, 821)` resolves a real `AXTextField` / subrole `AXSearchField` at `{{33, 803}, {336, 38}}`, `AXValue: "Search"`. The two tools disagree about the same screen.
  - Fails **silently** — an empty `children` array is indistinguishable from a legitimately empty container, so an agent concludes the element does not exist.
  - The server's own tool instructions direct agents to `ui_describe_all` when they don't know what's on screen, so this undermines the documented navigation path.
  - Label-based fallback does not help here: the field's `AXLabel` is `null` (the word "Search" is its `AXValue`), so `ui_find` / `ui_tap {label}` have nothing to match. Worse, `ui_find "Search"` resolves to the *Settings menu row* at y=692 — a different element — so an agent can tap the wrong thing and not notice.
  - **Reproduced in a second app (Contacts).** Same shape: `Toolbar` at `{{0, 788}, {402, 86}}` with `"children": []`, while `ui_describe_point(170, 822)` returns an `AXSearchField` at `{{33, 803}, {276, 38}}`. The visible "+" (add contact) button in that same toolbar is likewise absent from the tree. So this is systematic, not a Settings quirk — the bottom toolbar's contents are consistently missing.
  - **Unresolved:** not yet known whether the omission originates in this server's tree handling or in idb's `accessibility_info` response. Needs a source-level look. The fact that it is specifically the bottom `Toolbar` group in both apps is the strongest available clue.
- [x] **#29** *(closed by #40 — same fix)* **Far worse case of #22: an entire screen can come back empty.** In Contacts, with the search field focused and "Kate" typed (results visibly on screen), `ui_describe_all` returns the *whole app* as two childless groups:
  ```
  Group "Search results" {{0, 0}, {402, 874}}  children: []
  Group "Toolbar"        {{0, 788}, {402, 86}} children: []
  ```
  Everything visible — the "Top Name Matches" header, the "Kate Bell" row, the search field, the clear/cancel buttons — is absent. Meanwhile `ui_describe_point(100, 130)` cleanly returns `AXStaticText` "Kate Bell" at `{{2, 100}, {384, 60}}`.
  - Whatever causes #22 is not limited to toolbars: any container can come back childless, and here it swallowed the entire content area. Severity is higher than #22 as originally written.
  - **The error message actively misleads.** `ui_tap {label: "Kate Bell"}` fails with *"No element found whose label contains 'Kate Bell'. Use ui_describe_all to see what is on screen."* — but `ui_describe_all` shows nothing either. The recovery advice leads into a dead end, and an agent following it would reasonably conclude the app is empty or broken.
  - Suggests the bug may relate to freshly-presented / transient UI (a search-results overlay that has just appeared), rather than to a specific control type. Worth testing whether a delay or a re-query returns a populated tree.
- [x] **#23** *(closed in 2.0.2 — the fallback matches AXValue)* Consider whether `ui_find` should match on `AXValue` as well as `AXLabel`, or at least report when an element matched by value was skipped. Related to #22 — several real controls carry their visible text in `AXValue` with a null `AXLabel`.

## TESTING_TOOLS.md defects

> **All of the below are fixed.** First pass 2026-08-12: Part 1 re-based onto Contacts, the search-results swipe removed, Part 2 retargeted. Finished 2026-08-13, when `testapp/` replaced the system apps entirely — a fixture with no first-run wizards, no background search index, and every control present twice (plain hierarchy and system chrome), which is what made the flaky steps deterministic. Kept here as a record of what was wrong.

- [x] **#24** "Wait ~10 seconds for the simulator to fully boot" (steps #1, #20, #23) is wrong — observed ~40s on this machine. **Fixed by #18**: `start_simulator` now blocks until the simulator answers, so the waits were deleted rather than re-timed.
- [x] **#25** Step #7 says to tap "the search field" in Settings, which is ambiguous: Settings has both a search text field in the bottom toolbar and a "Search" settings row. **Fixed**: the fixture's controls are uniquely named.
- [x] **#26** Step #26 is a manual step ("Hardware > Rotate Left") that an agent cannot perform. **Documented as human-in-the-loop** — [TESTING_TOOLS.md:254](TESTING_TOOLS.md:254) says outright that no MCP client can perform it. The other resolution, a rotation tool, is still open as #26 under 2.0.3 candidates.
- [x] **#27** Steps #16/#17 have no fixture. **Fixed**: `testapp/` ships one, built by `testapp/build.sh`, installed at step #7 and launched at step #8.
- [x] **#28** `ui_find` is not covered anywhere in TESTING_TOOLS.md. **Fixed**: steps #11 and #12 cover both cases that matter — a control in the plain hierarchy, and one inside the toolbar that the default tree omits.
- [x] **#30** Steps #9–#11 are flaky by construction. #9 asserts that searching "General" in Settings shows "filtered search results", but Settings search depends on a background index that is not built on a freshly-created simulator — observed **No Results for "General"** on a sim a few minutes old. #10 then swipes "to scroll the results" and #11 asserts the list scrolled, both of which are unverifiable against an empty state. Retarget the swipe at something reliably scrollable (the Settings root list, or the home screen) instead of search results.
  - Aside worth knowing: tapping the Settings search field suggests "Apps", "Developer" etc., yet searching for those also returns nothing until the index builds. The suggestions are not backed by the same index.
- [x] **#31** Step #7 does not account for the first-run **QuickPath keyboard overlay** ("Speed up your typing by sliding your finger…" + Continue), which covers the keyboard on a fresh simulator. It turned out to be harmless — `ui_type` still delivered text and the overlay dismissed itself — but the step's stated expectation ("the keyboard appears") does not match what a tester actually sees.
- [x] **#32** Step #17 says `launch_app` output "includes PID". It does not — actual output is `App com.apple.mobileslideshow launched successfully`. Either the message regressed or the doc was written against an older version.
- [x] **#33** Part 2 assumes Photos opens straight into its browsing UI, but on a fresh simulator it opens a **"What's New in Photos"** onboarding screen with a Continue button. Step #25 ("Screenshot shows the Photos app in portrait") passes only in the most literal sense, and step #29's suggested targets ("a tab bar button like 'Albums' or 'For You'") do not exist on that screen — and may no longer match this iOS version's Photos layout even after dismissal. Part 2 needs re-basing on a current, wizard-free app; **Contacts** worked well for Part 1 and supports landscape.

- [x] **#34** *(closed by #39/#40 — the labelled tab-bar element resolves)* Further instances of #22/#29 in Photos (landscape), and the sharpest evidence yet of what the bug is:
  - `Tab Bar` group `{{0, 338}, {874, 64}}` → `"children": []`, hiding the Library/Collections tabs.
  - `Nav bar` group `{{0, 24}, {874, 54}}` → `"children": []`, hiding the title and the `...` overflow button.
  - **`ui_find(label: "Collections")` returned "No element found" for an element whose `AXLabel` is literally `"Collections"`** — `ui_describe_point(205, 360)` returns it as `AXRadioButton` / `AXTabButton`, `AXUniqueId: "CollectionsTab"`, `AXLabel: "Collections"`. So the defect is not about elements lacking labels; the tree walk simply never descends into these containers. Any label-based navigation silently fails for anything inside one.
  - Pattern so far: the affected containers are the system chrome groups — `Toolbar`, `Tab Bar`, `Nav bar` — plus freshly-presented views (#29). A plausible shared cause is that these are hosted in separate UI scenes/windows that the tree walk does not recurse into.

## Root cause of #22 / #29 / #34 — investigated 2026-08-12

**Diagnosis: the elements are missing a parent→child edge in Apple's AX translation graph. They are not hidden, not truncated, and not dropped by idb or by us.**

Evidence, all gathered by probing the companion's `accessibility_info` directly (bypassing the MCP) on the Photos Library screen:

| Question | Answer | Evidence |
|---|---|---|
| Is the tree truncated? | **No** | `format: COMPLETE` reports `truncated=false`, `modal=null`, `backend="ax"`. `FBAXTranslationRequest.swift:351` — the AX path "walks the live element tree with no depth or node" bound. `FBAXReadLimits` (50/3000) applies only to the axbridge/XCUI backends. |
| Is it the `depth` gotcha from DESIGN.md §5c? | **No** | Already handled: `MARKER_DEFAULT_DEPTH = 50` in [client.ts:70](src/idb/client.ts:70). Explicit `depth: 50` still fails. |
| Is idb dropping the children? | **No** | `axChildren()` is a straight pass-through to Apple's `accessibilityChildren()` ([FBAXPlatformElement.swift:106](vendor/idb/FBSimulatorControl/Commands/FBAXPlatformElement.swift:106)), and the recursion in `FBAXNodeSerializer` applies no bound. |
| Does asking the container directly help? | **No** | `accessibility_info(point: <tab bar>, format: NESTED)` — which returns an element *with its whole subtree* — returns `Group "Tab Bar"` with `kids=0`. The children are unreachable from any entry point. |
| Is it a regression from our newer companion? | **No** | The **2022 brew companion 1.1.8** returns a byte-identical tree on the same simulator and screen: same 8 children, same childless `Tab Bar`, same hit-test results. |
| Is Apple deliberately hiding it? | **No** | The elements are *fully* exposed via hit-test, with labels **and** stable automation identifiers — `RadioButton "Library"` `uid=LibraryTab`, `"Collections"` `uid=CollectionsTab`, `"Search"` `uid=SearchTab`, `Button "Sort and Filter"` `uid=sortFilterButton` — all in the **same pid** as the app. Nothing is obfuscated or withheld; there is simply no edge from the container to them. |

What the whole-screen read actually returns for Photos Library — 9 nodes, `maxDepth=1`:

```
Application "Photos" pid=62065 kids=8
  Group ""         {0,62  402x54} kids=0   <- nav bar: title, "6 Photos", Sort and Filter, Select all missing
  Image "Photo" x6 {...}          kids=0
  Group "Tab Bar"  {0,791 402x83} kids=0   <- Library / Collections / Search all missing
```

Hit-testing that same screen finds every one of the missing controls, same pid, fully labelled. So the tree is not a view of a simpler screen — it is a graph with edges missing.

- [x] **#35** *(superseded by #39 — the AXBridge fallback shipped instead of a grid hit-test, and is cheaper)* Mitigation available now: **fall back to a grid hit-test when a marker query misses.** idb already does exactly this for *other* processes (`discoverRemoteElements` in `FBAXTranslationRequest.swift`, grid-stepped `translator.object(at:)`), but it skips `hitPid == frontmostPid`, so it never covers this same-pid case — and the option is not on the wire anyway. Doing it client-side in `findByLabel` would make `ui_find` / `ui_tap {label}` work for tab bars, nav bars and toolbars. Cost is one RPC per probed point, so step coarsely and only on miss.
  - A coverage-grid subtlety to avoid repeating: the childless container *claims* its whole frame, so any "skip points already covered" optimisation would skip exactly the region that needs probing.
- [x] **#36** *(closed — companion bumped to da0f89a, AXBridge starts)* The real fix is the **AXBRIDGE backend**, which walks the app's real view hierarchy (DESIGN.md §5c: 280 nodes / 43 labelled, vs 14 / 14 for AX). **It currently cannot start in our build**: every request fails with `axbridge could not resolve the frontmost application's pid`. `Resources/SimulatorFrameworkBridge` *is* present in the cached distribution, so it is not the packaging gap DESIGN.md warned about. Setting `ApplicationAccessibilityEnabled` and relaunching the app — the remedy the error itself prescribes — did **not** help, nor did posting `com.apple.accessibility.cache.ax` / `.app.ax`. Unresolved; needs the guest-side service investigated.
- [x] **#36a** *(closed — the bump landed)* **Upstream has already fixed the #36 blocker — 2 days after our pinned sha.** Checked 2026-08-12; our submodule is at `7c90442`, upstream `main` is `da0f89a`, **140 commits ahead**.
  - **`39025e9` "Resolve the frontmost application, not the owner of the centre pixel"** (Aug 11) is exactly our failure. The old code hit-tested the screen centre and took whatever owned that pixel; it now asks the window server which application is frontmost. The commit names our case outright: *"Nothing at the anchor and the read fails outright, though the frontmost application is perfectly nameable. A screen mid-transition, **an app whose accessibility tree is not up yet**, or a layout whose centre falls between elements all produce a read that could have succeeded."* Applies to the `AXBRIDGE` and `AXBRIDGE_PERSISTENT` gRPC backends. `--frontmost-method center-point` keeps the old behaviour.
  - **`e0ad2bf` "Recommend ApplicationAccessibilityEnabled only where it is the cause"** explains the wild goose chase: that remediation was appended to unrelated failures, and upstream notes *"its being wrong two times in three is what taught people to skip it on the one where it is right."* We followed it; it was never our cause.
  - **`49a4514` / `9392228`** raise the guest's failure kind and reason as typed errors, so the specific `failureReason` stops being flattened into one generic string — which was going to be step 2 of the guest-side investigation.
  - Also in those 140 commits: tap/scroll/set-value **writes** over axbridge, element frames over axbridge, and frame-coverage reporting on every backend.
  - **Toolchain is unchanged**, so the bump is low-risk: `IDBAPI.swiftinterface` pins Swift 6.3.3 at both our sha and upstream HEAD, `.xcode-version` says 26.6, and Xcode 26.6 / Swift 6.3.3 is what is installed.
  - **Next step:** bump the submodule to `da0f89a` (or anything ≥ `39025e9`), rebuild the companion (~20–30 min), re-run the probe. If AXBRIDGE then resolves the frontmost app, #22/#29/#34 are fixed by switching `ui_describe_all` / `ui_find` to that backend.
- [x] **#36c RESOLVED.** `companion.lock.json` now pins `da0f89a`, committed by CI. Release `companion-da0f89a-xcode26.6` is published; the tarball downloads, its sha256 matches the lock exactly (`bb10bd54…`), and it contains `Resources/SimulatorFrameworkBridge` — without which a downloaded companion loses AXBridge silently and everything above stops working. Users without a local build now get the fix.
- [ ] **#48** `npm run verify:download` cannot verify the download on a machine that has built the companion locally. `resolveOnce` prefers `vendor/idb/Build/Distribution` over the lock, so the script resolves to the local build, never fetches the URL, and then fails its own "cached under its content hash" assertion — reporting VERIFICATION FAILED for a lock that is perfectly correct. The one machine most likely to run the check is the one where it cannot work. Either have the script set `IOS_SIMULATOR_MCP_COMPANION_PATH= ` and temporarily ignore the local build, or teach it to skip that assertion and say why.
- [x] **#36c-orig** ~~`companion.lock.json` goes stale the moment the submodule is bumped.~~ [companionBinary.ts:170](src/idb/companionBinary.ts:170) prefers a locally built companion over the download, and its comment justifies that with *"It is the same sha, so this is not a compatibility compromise"* — which stops being true after a bump. With the submodule at `da0f89a` and the lock still pinning the old build, a developer who has built locally and a user who has not are running **different companions**, and only the former gets the fix. Regenerate and republish the lock (and update that comment) once the axbridge fix is confirmed.
- [ ] **#36b** **Upstream issue [facebook/idb#892](https://github.com/facebook/idb/issues/892) "Searchbar is missing from UI description"** — open since 2025-10-24, no replies. Same symptom, independently reported: a `.searchable` bar in a nav bar, and the posted JSON shows `role_description: "Nav bar"` with `"children": []`, exactly like ours.
  - **This refines the conclusion in the table above.** The reporter shows the field *is* visible in Apple's own **Accessibility Inspector**. So the element is present in Apple's accessibility hierarchy — it is specifically the `AXPTranslator` parent→child traversal idb uses that fails to surface it, not the hierarchy itself. Still not deliberate concealment and still not idb discarding it, but more tractable than "Apple will not give it to us": a different traversal (axbridge) should reach it.
  - Worth adding our findings to #892 once axbridge is confirmed — it is the same bug and currently has no response.
- [ ] **#37** Not a bug, but worth documenting: when a **system modal** is up (e.g. the notifications permission alert), the frontmost application *is the alert's process*, so `ui_describe_all` correctly returns only the alert's tree (pid 59695) and the app underneath vanishes entirely. That tree is fully populated. Agents should expect the app to disappear from the tree while a permission dialog is showing, rather than read it as the tree bug.
- [x] **#38** *(closed in 2.0.2 — normaliseForMatch)* `ui_find` / `ui_tap {label}` do exact substring matching, so **typographic characters bite**: the permission button is labelled `Don’t Allow` with U+2019, and an ASCII `Don't Allow` finds nothing. Consider normalising curly quotes/apostrophes and dashes on both sides of the comparison. Fixed in TESTING_TOOLS.md; the tool behaviour is unchanged.

## CONFIRMED FIX — submodule bumped and companion rebuilt, 2026-08-12

Submodule moved `7c90442` → `da0f89a` (includes `39025e9`). `./build.sh generate-proto` then `npm run build:companion`: **BUILD SUCCEEDED, zero patches**, on Xcode 26.6 / Swift 6.3.3. Distribution assembled with `Resources/SimulatorFrameworkBridge`. Verified by spawning the new companion directly against a booted simulator (Photos, Library tab, portrait) — no MCP restart needed to test.

**AXBRIDGE now works, and it sees everything the AX backend cannot:**

| read | bytes | ms | nodes | depth | "Collections" |
|---|---|---|---|---|---|
| `AX` NESTED (what `ui_describe_all` sends today) | 3 763 | 63 | 9 | 1 | **ABSENT** |
| `AXBRIDGE` COMPLETE, full | 23 459 | 311 | 80 | 18 | **FOUND** `{113,795 96x54}` |
| `AXBRIDGE` COMPLETE, `keys:[AXLabel,AXFrame]` | 7 561 | 304 | — | — | FOUND |
| `AXBRIDGE` NESTED, `keys:[AXLabel,AXFrame]` | **6 378** | 298 | — | — | FOUND |

Marker lookups over AXBRIDGE — every control that `ui_find` could not previously see:

```
Collections      OK  410B 303ms      Sort and Filter  OK  382B 287ms
Library          OK  464B 294ms      Select           OK  391B 289ms
Search           OK  338B 292ms      ZZZnope          clean "found no element" error
```

The frames match the hit-test results exactly, so the coordinates are directly usable.

### Benchmarked properly, 5 runs each, Photos Library portrait (warm figures)

**Earlier figures in this file were wrong and are corrected here.** The "~60ms" quoted for `ui_find` was a *describe-all*, not a marker query; and "+70%" for describe-all only holds for a two-key read.

| operation | AX | AXBRIDGE | AXBRIDGE_PERSISTENT |
|---|---|---|---|
| marker hit (element AX can see) | **15 ms** / 352 B | 304 ms / 325 B | 304 ms / 325 B |
| marker miss (element AX cannot see) | 40 ms / **wrong answer** | **304 ms / correct** | 301 ms / correct |
| describe-all, full | 49 ms / 3 763 B | 307 ms / 28 379 B | 302 ms / 28 379 B |
| describe-all, `keys[AXLabel,AXFrame]` | — | — | 299 ms / 6 378 B |
| describe-all, `keys[6]` | — | — | 305 ms / 11 641 B |
| describe-all, `keys[8]` | — | — | 307 ms / 13 961 B |
| point read (`ui_describe_point`) | **8 ms** / 447 B | — | 242 ms / 397 B |

Two results that change the plan:

- **`AXBRIDGE_PERSISTENT` buys nothing.** Identical to `AXBRIDGE` on every measurement — the ~300 ms is per-read work, not per-connection setup, so there is no warm-up to amortise. Do not reach for it expecting a speedup.
- **`ui_describe_point` must stay on AX.** 8 ms vs 242 ms — 30× faster — *and* it already resolves the elements the tree walk misses, because it hit-tests. Switching it would be a pure 30× regression for no gain.

- [x] **#39 IMPLEMENTED** in `findByLabel` ([index.ts:100](src/index.ts:100)) — AX first, AXBRIDGE only on miss, and any AXBridge failure degrades to "not found" rather than surfacing an axbridge error (which matters while `companion.lock.json` still ships a companion that cannot start the backend — see #36c). Builds clean.
  - **Verified end-to-end, clean.** On a settled Photos Library screen (both wizards dismissed), `ui_find "Collections"` now returns the real tab-bar button — `AXUniqueId: "CollectionsTab"`, frame `{112.67, 795, 95.67, 54}` — where it previously returned "No element found", and `ui_tap {label: "Collections"}` navigated to the Collections view. The exact case that started this investigation.
  - Test-harness lesson worth keeping: scripted setup against Photos is unreliable because the What's New sheet and the notifications alert race, and substring matching produces false positives while they are up (`"Photo"` matches *"Photos" Would Like to Send You Notifications*; `"Collections"` matches the wizard's own body text). Assert on the frontmost application, not on a label.
- [ ] **#43** **The ~285 ms AXBridge cost is a per-call guest process spawn, and cannot be amortised from our side.** Measured on a settled screen, medians over 6 runs: AX hit **13 ms**; AX miss 41–69 ms; AXBRIDGE **291 ms on a hit and 289 ms on a miss** — flat, so it is fixed overhead rather than tree-walking work. `AXBRIDGE_PERSISTENT` is no better (279–282 ms).
  - **Why persistent does not persist:** `uiAutomation(backend:)` constructs a **fresh transport per call** ([FBUIAutomation.swift:248](vendor/idb/FBSimulatorControl/Commands/FBUIAutomation.swift:248)), so `FBAXBridgePersistentTransport`'s "spawn the guest once (`accessibility serve <socket>`)" is once per gRPC request. Nothing the client can set changes this.
  - The earlier "470 ms" was load noise from a concurrent build; steady state is **~330 ms for a miss** (41 + 289) and ~360 ms for an AXBridge hit.
  - Upstream fix would be to cache the transport per simulator, which would drop the fallback to roughly a socket round-trip. Deferred with #42 — no upstream patching for now.
- [x] **#44 DECIDED: leave the fallback automatic and unconditional.** Rationale: the tools are driven by an agent that knows only what the tool descriptions say, so the default must be the one most likely to give a correct answer; ~300 ms is an acceptable price for that. No flag, no per-tool asymmetry, nothing for the caller to get wrong.
  - Consequence handled: `SERVER_INSTRUCTIONS` claimed `ui_find` was "safe to poll while waiting for a screen", which is no longer true at ~330 ms a miss. Replaced with an accurate note that also warns about the trap that actually bites a naive agent — `ui_describe_all` omitting whole containers, so "not in the tree" does not mean "not on screen".
- [x] **#44-orig** *(superseded — kept as the record behind #44)* ~~Decide where the miss cost is acceptable.~~ The only regression is the *absent-label* case: 41 ms → ~330 ms. That matters because the server's own tool description advertises `ui_find` as cheap enough "to poll while waiting for a screen" — polling is exactly the absent case, so a poll loop is now ~8x more expensive. An AX hit is unchanged at 13 ms, and an AXBridge hit was previously impossible, so neither of those regressed. Options:
  - leave it (simple; polling gets slower),
  - add `deep?: boolean` so a caller polling can opt out — but the default then decides whether the original bug is back,
  - or fall back automatically for `ui_tap` (where a miss blocks the agent) and make it opt-in for `ui_find` (where "absent" is a normal answer).
- [x] **#45** *(closed in 2.0.2 — canonicalise)* Backend shape difference worth knowing: an AXBridge match returns `role: "Button"`, `traits: null`, `role_description: null`, where the AX backend returns `role: "AXRadioButton"`, populated `traits` and `role_description` for the same element. Callers keying off `role`/`traits` will see different values depending on which backend answered.
- [x] **#39-orig** *(superseded — kept as the record behind #39)* **`ui_find` / `ui_tap {label}`: try AX first, fall back to AXBRIDGE on miss** — *not* the blanket switch previously written here. A blanket switch costs 15 ms → 304 ms (**20×**) on every lookup that already worked. The fallback keeps the common case at 15 ms and pays ~344 ms (40 ms miss + 304 ms) only where the answer is currently *wrong*:
  - AX-visible element: 15 ms, unchanged.
  - AX-invisible element: ~344 ms and correct, versus 40 ms and "No element found".
  - Residual risk to note in the code: if AX returns a *different* element that also substring-matches, the fallback never runs and the wrong element is tapped. Substring matching makes that plausible (`"Search"` matched two different things during testing).
- [x] **#40 IMPLEMENTED — and it costs almost nothing.** New `describeScreen()` ([index.ts](src/index.ts)) serves `ui_describe_all` from AXBRIDGE with a restricted key set, then prunes client-side. Measured like-for-like on the Photos Library screen:

  | | bytes | nodes | depth | complete |
  |---|---|---|---|---|
  | AX (previous) | 3 763 | 9 | 1 | **no** |
  | AXBRIDGE + keys + pruned | **3 906** | **25** | 3 | **yes** |

  **+4% payload for 2.8x the nodes and a tree that is actually complete** — the client-side pruning paid for essentially the whole AXBridge overhead. ~350 ms. Verified against a screenshot taken in the same moment: tree and screen agree exactly, and `Collections`, `Library`, `Search`, `Select` and `Sort and Filter` are all present where they were previously absent.

  Three things made it cheap:
  - **`keys`** — dropped `pid`, `help`, `title`, `subrole`, `content_required`, `custom_actions`, `role_description`, `traits`, and crucially `AXFrame`, which is the same rectangle as `frame` rendered as a string. Every node was carrying both.
  - **Client-side pruning** (`pruneTree`) — idb's own `.interactable` rule, reimplemented here because #42 is not reachable over gRPC: keep an element with a label, a value, an actionable type, or a *non-container* identifier; hoist a dropped node's kept descendants so nothing is orphaned.
  - **Dropping null/empty fields** — a screen's worth of `"AXValue": null` is pure noise.

  An identifier alone deliberately does not rescue a generic container: UIKit gives its internal layout groups identifiers too, and on the photo grid that was a five-deep `PX*-Group` chain between the scroll view and the images. Excluding `Any`/`Group`/`Other`/`Unknown` took the tree from depth 7 to depth 3.

  Internal callers (`detectOrientation`, `getScreenDimensions`, `ui_view`) deliberately still use the cheap AX `describeAll` — they only read `elements[0].frame`, and making them pay ~300 ms for a rectangle they already had would be a pointless regression.

  Falls back to the AX read if AXBridge cannot start, so a companion older than the pinned one still works (see #36c).
- [ ] **#46** One observation worth watching, not yet explained: on a run where the What's New sheet had just been dismissed, its elements (`"What's New in Photos"`, `Continue`) were still present in the AXBridge tree alongside the Collections content. A later clean run showed no such residue and matched its screenshot exactly, so this looks like a transient during sheet teardown rather than AXBridge reporting invisible views — but it is one observation either way. If agents start tapping controls that are not on screen, start here.
- [x] **#40-orig** *(superseded — kept as the record behind #40)* **`ui_describe_all`: AXBRIDGE + `keys`, behind a flag.** The honest cost is bigger than first stated — a realistic key set is **3–3.7× today's payload**, not +70%:
  - `keys[AXLabel,AXFrame]` → 6 378 B (1.7×), but too thin for the current tool output.
  - `keys[6]` (`+AXUniqueId, role, type, enabled`) → 11 641 B (3.1×).
  - `keys[8]` (`+traits, AXValue`) → 13 961 B (3.7×) — closest to what `src/index.ts` consumes today.
  - Full tree → 28 379 B (7.5×). Never the default.
  - `keys` is a strict allowlist and an unrecognised key is a hard `INVALID_ARGUMENT`, so the set must be derived from real usage in `src/index.ts`, not guessed.
  - Suggested shape: keep AX as the default, and expose the rich read as an explicit opt-in — either an env flag or a `deep: true` parameter — so an agent reaches for it when the cheap tree does not contain the target.
- [ ] **#42** **The optimisation we actually want is not on the wire: `FBAccessibilityElementFilter.interactable`.** It keeps only elements with a label, an identifier, or an actionable role, drops unlabelled structural containers, and in nested output hoists a dropped container's matching descendants ([FBAccessibilityRequestOptions.swift:42](vendor/idb/FBControlCore/Commands/FBAccessibilityRequestOptions.swift:42)). That is precisely the filter that would make an AXBRIDGE tree cheap enough to be the default.
  - **It is CLI-only.** `AccessibilityInfoRequestTranslation.options(from:)` builds `FBAccessibilityRequestOptions` without `filter:`, so gRPC always gets `.all`, and `AccessibilityInfoRequest` has no `filter` field — confirmed at `da0f89a`.
  - Rough estimate of the win: 23 of 80 nodes on the test screen carried a label, so `.interactable` plausibly keeps ~30 and could bring a `keys[8]` read from ~14 KB toward ~5 KB. **Not measured** — it cannot be measured without the field existing.
  - Fix is small: add `filter` to the proto and pass it through in `options(from:)`. Worth an upstream PR; per DESIGN.md's "fork only once you accumulate a patch", this would be the first real candidate.
  - `profile` and `collect_frame_coverage` *were* added to the proto in this bump — so our generated client needs `npm run gen:proto` to see any new field.
- [ ] **#41** With AXBRIDGE available, revisit the `isDegenerateTree` / companion-restart workaround in `describeAll` ([index.ts:83](src/index.ts:83)) and the 0x0-frame heuristic. `COMPLETE` reports `truncated` and `modal` as explicit fields, so the MCP can read a fact instead of inferring one from a degenerate frame.

## Architecture — revisit the single-file rule (discussed 2026-08-12, deferred)

- [x] **#47 DONE 2026-08-14.** Extracted to `src/ax/tree.ts` and `src/ax/orientation.ts`, tested with `node:test` (`npm test` — 62 assertions, ~90ms, no new dependencies), wired into CI and the publish workflow, and documented in CLAUDE.md and CONTRIBUTING.md. No change to the tool surface.
  - **Both modules are dependency-free on purpose**, including on each other. That is what lets `node --test` run the TypeScript directly with nothing built first, and it is the rule that keeps the split from spreading: anything wanting a companion, a simulator or the filesystem stays in `src/index.ts`.
  - **Found and removed a duplicate implementation.** `detectOrientation` carried its own copy of the logical→portrait rotation arithmetic, algebraically identical to `transformPointToPortrait` but written out separately, so the detector and the tap path could have disagreed after any edit to either. It now calls the shared function. Also deleted `matchableText`, which was dead.
  - **The tests were checked against deliberate mutations**, not just run: letting a bare identifier rescue an anonymous container (#40's rule, the one that survived two simulator boots) and swapping the `landscape_left` transform each produced failures — 8 across both, including `pruneTree` catching the `isInteresting` change transitively.
  - Tests are `test/*.test.mts` and need Node ≥ 22.6 to run TypeScript directly; the published package still supports Node 18. They are not in `tsconfig.json`, so they are never emitted or packed — `tsconfig.test.json` type-checks them.
  - **Verified live as well**, since unit tests cannot prove the wiring. Against `testapp/` on an iPhone 17 Pro: `ui_find "Plain Button"` 61ms (marker path), `ui_find "Toolbar Button"` 313ms returning `{"AXUniqueId":"ToolbarButton","frame":{"x":33,"y":803,…}}` (the AXBridge fallback through `matchInTree`, the case #39 exists for), and `ui_tap {label: "Toolbar Button"}` then reading back `status: tapped Toolbar Button` — so the fallback's frame produced a tap that landed on the real control. `detect_rotation` returned `portrait` in 123ms on a second run. Not exercised live: the value-only match (`Toolbar Search`), which the unit tests cover.
- [x] **#47-orig** *(superseded — kept as the record behind #47)* **Extract the pure logic out of `src/index.ts` and put tests on it.** Not a general "split the architecture" — a narrow move, ~200 lines, with no change to the tool surface.
  - **Why the original rule has expired:** CLAUDE.md mandates one file, and the strongest reason was keeping merges from the original project cheap. That reason is gone — this is a standalone project, not a tracking fork, and there is nothing to merge from. `src/index.ts` is also two-thirds ours by line count. The rule now has to justify itself on its own merits rather than on merge convenience.
  - **What still argues for one file:** whole-surface comprehension in a single read (though ~25 k tokens now, no longer free), no import graph for a small server, and the rule's value as a guard against churn. These are real but weaker than they were.
  - **The concrete cost, hit during this session:** there is **no test script and no test framework** in the project. `pruneTree`, `isInteresting`, `transformPointToPortrait`, `isDegenerateTree`, `centreOf` and the orientation math are pure functions with real logic (keep/drop rules, descendant hoisting, coordinate mapping), all module-private in a file that starts a server on import. Verifying the #40 pruning rules took **four simulator boots at ~3 minutes each**, and a too-lenient identifier rule survived the first two. Unit tests would have caught it in milliseconds.
  - **Suggested shape:** move those into `src/ax/tree.ts` (or similar) and test with **`node:test`** — built in, zero new dependencies, which keeps faith with the project's minimal-dependency principle.
  - **Explicitly not proposed:** splitting the 16 tool registrations into per-tool modules. They are repetitive, they benefit from sitting together, and that split would be churn for its own sake.

## Upstream may soon publish companions itself — watch this

- [ ] **#49** `da0f89a` — the very sha we pinned — is **"Add a tag-triggered release workflow"**, landed 2026-08-12. Pushing a `v*` tag to `facebook/idb` now builds the full distribution on `macos-26`, packages `idb-companion.universal.tar.gz` + sha256, cuts a **prerelease** for human promotion, and prints the `url`/`sha256` lines for bumping the `idb-companion` homebrew formula.
  - **Changes nothing today.** It fires only on `v*` tags, and the newest tag is still **v1.1.8 (2022)** — the workflow has never run.
  - **If Meta resumes tagging, this deletes our biggest standing cost.** Their tarball is the same `Build/Distribution` layout we produce, so consuming it is a drop-in: point `companion.lock.json` at their release URL and sha256, and delete our `build-companion.yml` entirely. DESIGN.md's one unresolved objection to Option B — "you own a companion build nobody upstream tests" — goes away.
  - **But it would pin us to their tags, not arbitrary shas.** The fix this whole investigation needed (`39025e9`) landed one day before HEAD and is untagged; on a tags-only diet we would still be waiting. Likely shape: consume upstream releases by default, keep the local build path for when a fix has not been tagged yet.
  - Their release is a **prerelease**, so anything consuming it automatically has to opt into prereleases or wait for promotion.
- [ ] **#50** **Upstream's release artifact is misnamed: `idb-companion.universal.tar.gz` is arm64-only.** `build.sh` hardcodes `ARCHS=arm64` unconditionally in `common_settings` ([build.sh:276](vendor/idb/build.sh:276)) with the comment "build arm64 only (no Intel/x86_64 slices)", and `./build.sh build all` is exactly what `release.yml` runs. Verified against our own build of the same script: `lipo -archs` reports `arm64` for both `idb_companion` and `Resources/SimulatorFrameworkBridge`. Anyone on an Intel Mac who installs that tarball — or the homebrew formula it feeds — gets a binary that cannot run. Worth an upstream issue; it also means their release would not close our own Intel gap.

## Shipped 2026-08-12 — and what the release taught

2.0.0 published, could not start, deprecated within the hour; 2.0.1 fixes it.
`@bufbuild/protobuf` is imported at runtime by the generated gRPC client and was
never declared as a dependency — in the repository it resolved through
`ts-proto`, a devDependency.

- [x] **#51** **Verification that never leaves the repository proves nothing about the package.** Everything passed before 2.0.0 shipped: it compiled, `npm pack` listed exactly the right ten files, the server ran from the working tree, and the *published companion* was verified end to end against a real simulator — downloaded from a clean cache, hash checked, driving Photos. The one thing never done was `npm install` the package into an empty directory and start it, which is the only environment where a missing dependency is missing. Checking package *contents* is not checking the package.
  - Fixed for this class of bug: `publish.yml` now packs, installs into a temp directory and asks for an MCP `initialize` before publishing.
  - The general lesson is broader than dependencies, and it is the same one as #47: the tests that would have caught this cost seconds, and the manual verification that did not catch it cost an afternoon of simulator boots.
- [x] **#52** Nothing verifies the repository state on push — no test job, no build check on PRs. **Fixed**: [ci.yml](.github/workflows/ci.yml) runs `typecheck` and the packed-install smoke test on every push and pull request, on Ubuntu, since neither check needs a simulator.

## 2.0.2 — done 2026-08-13

- [x] **#18/#19 boot race.** `start_simulator` now polls an accessibility read until the simulator answers before returning, and says how long it waited. Verified: 33s wait, then `ui_view` succeeded on the first call with no wait of the caller's own. `attach_simulator` does the same, since "Booted" is reported well before the bridge answers. The `No translation object` error is rewritten to say the simulator is probably still booting, instead of blaming a fullscreen dialog.
- [x] **#38 typography.** `normaliseForMatch` folds curly quotes, apostrophes, dashes and non-breaking spaces before comparing. Verified: `ui_tap {label: "Don't Allow"}` with an ASCII apostrophe now taps iOS's `Don’t Allow`.
- [x] **#23 AXValue.** The fallback matches an element's visible text as well as its label, so search fields — null label, text in `AXValue` — are nameable. **Implemented but not verified**: no value-only element was on the test screen. Contacts' search field is the known case; worth a targeted run.
- [x] **#45 one shape everywhere.** `canonicalise` reduces every element to the same six fields, client-side. Necessary because `keys` is honoured for point and whole-screen reads but **ignored for marker queries** — `ui_find` returned 16 fields where `ui_describe_point` returned 6, for the same element. Verified: both now draw from one set.

## 2.0.3 — done 2026-08-13

- [x] **#54 The boot wedge.** ~1 in 4 fresh simulators came up fully rendered and tap-responsive with accessibility permanently dead. Cure found and verified: restart `com.apple.CoreSimulator.bridge` in the guest. Now automatic, with verbose logging and a bug-report prompt if it ever fails. **Cause still unknown** — full write-up, including the two hypotheses asserted before testing and both wrong, in [BOOT_BUG.md](BOOT_BUG.md).
- [x] **#55 `start_simulator` bounded to 55s.** The 180s wait outlasted the MCP client, so the call was cancelled and the caller got nothing — no UDID, no session, no idea a simulator existed. Also gates on `simctl bootstatus` (capped at 30s) instead of a fixed sleep, and fires recovery on remaining budget rather than elapsed age, so it is always attempted and always has room to work.
- [x] **#58 DONE 2026-08-15.** `ui_describe_point` now answers in the tree's vocabulary, so both tools name an element the same thing. `reconcileType` in [src/ax/tree.ts](src/ax/tree.ts), unit tested; `ui_describe_point` asks for `subrole` as evidence and never returns it.
  - **Surveyed rather than guessed.** The fixture gained a search bar, switch, slider, stepper and segmented control, because a `UIButton` is called `Button` by both backends and could not show the problem. Every element in the tree was then looked up again by point and the two answers compared. **Comparing by frame matters**: a first pass compared by position alone and produced 14 "disagreements", most of which were the point read resolving a *different* element (the `StaticText` inside a button hit-tests to the button). Keyed on identity, five were real:

    | element | tree | point | point `subrole` |
    |---|---|---|---|
    | search field | `SearchField` | `TextField` | `AXSearchField` |
    | switch | `Switch` | `CheckBox` | `AXSwitch` |
    | segment ×2 | `Button` | `RadioButton` | `AXTabButton` |
    | nav bar title | `StaticText` | `Heading` | *none* |

  - **The fix this entry originally proposed does not work.** `type` alone cannot be mapped in either direction: the point read calls a plain field and a search field both `TextField`, so promoting `TextField` would promote every field on the screen, and it is *more* specific than the tree for headings. The subrole is what makes it a function — `AXSearchField` appears on the search field and nothing else. Neither did the other suggestion: serving point reads from the tree's backend is 8ms → 242ms, a 30× regression for a rectangle.
  - **Verified:** 17 elements matched by frame across both tools, previously 5 disagreements, now **0**, with no `subrole` in any output.
  - Cost paid knowingly: `Heading` is flattened to `StaticText`, a real distinction the point read knows and the tree does not. Two tools disagreeing about one element is worse than both being slightly coarse.

- [x] **#58-orig The canonical shape unified the fields but not their values.** The Contacts search field comes back as `"type": "SearchField"` from `ui_describe_all` and `"type": "TextField"` from `ui_describe_point` — same element, same six keys, different value, because the two reads are served by different accessibility backends (axbridge vs the AX legacy path). `canonicalise` was the fix for #45 and only got half the problem: it guarantees which keys are present, not that a backend-dependent value agrees across tools. An agent that branches on `type` will behave differently depending on which tool it happened to use. Either map the values to one vocabulary, or serve `ui_describe_point` from the same backend as the tree.
- [x] **#56 DONE 2026-08-14.** Recovery moved into the accessibility reads themselves — `withAccessibilityRecovery` wraps the whole-screen read, the marker lookup and the point read, so every tool built on them is cured by one path instead of `ui_describe_all` and `ui_view` each having their own. `ui_describe_all` now re-reads and serves the screen after a recovery rather than throwing an error that tells the caller to retry.
  - **Two gates, both unit tested** in [src/ax/recovery.ts](src/ax/recovery.ts): never for a simulator that has not yet served a usable read (that one is booting, and `waitUntilDriveable` owns it with its own budget), and not more than once a minute per simulator (a wedged sim under an agent fails every few hundred ms, and restarting under each failure leaves the bridge permanently mid-restart). Concurrent failures share one in-flight attempt.
  - **Found while verifying: `no translation object` is ambiguous, and taking it at face value was a bug in the first version of this change.** idb raises it both for a dead bridge and for a point read that found nothing — so `ui_describe_point` on empty space would have ordered a bridge restart, once a minute, forever. `describePoint` now separates them by asking for the whole screen, which has no such ambiguity, and returns `No accessibility element at (x, y)` instead. Verified: 36ms, no restart.
  - **The cure's timing was wrong too, twice over.** A fixed 4s settle then one probe declared failure on a bridge that answered 1.6s later; it now polls for up to 20s. And the first read after a restart can still fail while the next succeeds, so the caller's read is retried a few times rather than once.
  - **What is not verified: a genuine mid-session wedge being cured.** There is no known way to induce one — `launchctl stop` on a healthy bridge is not it (launchd brings it back, the next read waits ~700ms and succeeds), and the real fault is a bridge that is running and not translating. The mechanism was observed end to end during development (restart ordered → `recovered 11s after restarting` → read retried), but on a fault that turned out to be the empty-point case. Recorded in TESTING_SERVER.md as something to check when one is met, not as a scripted step.
- [ ] **#57 Report the `remediationRequired` gap upstream.** idb's own cure is gated behind a predicate that excludes the case it would fix. Probably best filed against the 0x0-tree symptom, where the analysis applies most cleanly. See BOOT_BUG.md.

## 2.0.3 candidates

- [x] **#26 DONE 2026-08-14 — `rotate` shipped.** Takes the four names, rotates over `HIDEvent.orientation`, waits out the animation, then **detects the orientation and reports what it found rather than what was asked for**. That last part is not politeness: it caught a real bug in this very tool during its first run, and it is what a caller needs when an app declines an orientation.
  - **idb's `HIDOrientationType` uses UIKit's *interface* vocabulary; ours names the device.** The first mapping was name-for-name, and the fixture exposed it immediately: `rotate landscape_left` produced `device=landscapeRight interface=landscapeLeft` — the mirror — and the tool answered *"asked for landscape_left, the interface is landscape_right"*. `HID_ORIENTATION` now crosses the two landscapes deliberately. Retested after the fix: all four requests land on the right device orientation, and a tap at (776.5, 46) from the resulting landscape tree hit `Nav Button`.
  - **Upside down behaves exactly as documented below.** `rotate upside_down` on an iPhone moves the device (`device=portraitUpsideDown`) while the interface stays put, and the tool says so, names the Face ID cause, and points at iPad.
  - **TESTING_TOOLS.md Part 2 is now agent-drivable end to end** — step #26 was the only manual step in the file.
  - Also fixed while here: CLAUDE.md's tool list still advertised `get_booted_sim_id` and `open_simulator`, which this fork does not have.

- [x] **#26-orig rotation tool — naming settled 2026-08-14, tool not built.** `HIDOrientation` is in the proto with all four orientations, wired into the `HIDEvent` oneof, and already in our generated client, so the tool itself is small. The blocker was what the names mean, and that is now answered.
  - **We match the Simulator's own vocabulary, in both of its menus.** Measured against a human driving the menu, with a tap by coordinate each time to prove the transform and not just the label:

    | menu action | `detect_rotation` | tap from that tree |
    |---|---|---|
    | Device > Rotate Left | `landscape_left` | (776.5, 46) → `tapped Nav Button` |
    | Device > Rotate Right ×2 | `landscape_right` | (162.5, 352) → `tapped Toolbar Button` |
    | Device > Orientation > Landscape Left | `landscape_left` | (776.5, 46) → `tapped Nav Button` |
    | Device > Orientation > Landscape Right | `landscape_right` | (162.5, 352) → `tapped Toolbar Button` |

  - **The earlier "our name is inverted relative to Apple's" was comparing against the wrong enum.** Apple ships two, deliberately crossed, and says so in `UIOrientation.h` (iPhoneSimulator26.5 SDK): `UIDeviceOrientationLandscapeLeft` is "home button on the right", and *"Note that UIInterfaceOrientationLandscapeLeft is equal to UIDeviceOrientationLandscapeRight (and vice versa). This is because rotating the device to the left requires rotating the content to the right."* We use the **device** vocabulary, which is also what the Simulator's menus use. Nothing needs renaming.
  - **Confirmed live**, not just from the header: `testapp` now displays both of the app's own answers (`OrientationLabel`), and they were read back at every position.

    | app: `device` | app: `interface` | `detect_rotation` | tap from that tree |
    |---|---|---|---|
    | `portrait` | `portrait` | `portrait` | Plain Button ✓ |
    | `landscapeLeft` | `landscapeRight` | `landscape_left` | Nav Button ✓ |
    | `landscapeRight` | `landscapeLeft` | `landscape_right` | Toolbar Button ✓ |
    | `portraitUpsideDown` | `landscapeRight` | `landscape_left` | Nav Button ✓ |

  - **The exact rule, which the last row is the proof of: we report the orientation the *interface* is in, named in Apple's *device* vocabulary.** In that row the device is upside down while the interface is landscape, and we say `landscape_left` — following the interface, which is right, because the coordinate space follows the interface and not the device. Any `rotate` tool must say this plainly: our word names the interface, in the vocabulary the Simulator's menus use.
  - **`upside_down` is unreachable on a Face ID iPhone.** `Device > Orientation > Portrait Upside Down` does move the device — the app reports `device=portraitUpsideDown` — but iOS never gives the app an upside-down interface, even after `UIInterfaceOrientationPortraitUpsideDown` was added to the fixture's `Info.plist` specifically to test this. The interface stays wherever it was (`landscapeRight` above; `portrait` after a relaunch). So a `rotate(upside_down)` on an iPhone would look broken while behaving correctly, and `detect_rotation` would keep reporting the interface. iPad is where that fourth case can actually be exercised — untested.
  - **Both landscape trees are byte-identical in geometry** (root `874x402`, same frames) — the only thing distinguishing them is the probe. Worth remembering before anyone tries to infer orientation from the frame.
  - `transformPointToPortrait` keys off these names, so this was worth settling before the tool existed rather than after.
- [x] **#53 DONE 2026-08-15 — investigated, does not reproduce, no change needed.** The tools are consistent; what was seen was almost certainly the screen changing between two reads, not a read flipping on one screen.
  - **Made reproducible first.** `testapp` gained the two kinds of modal, because they are not the same thing and only one of them changes the frontmost process: `Show In-App Modal` (a `UIAlertController`, this app's own process) and `Ask Permission` (the notification alert, drawn by another process). The original sighting was Photos' What's New sheet with a permission prompt racing it, which is exactly the setup that could not be held still.
  - **Every measurement is deterministic**, on current code:

    | state | probe | result |
    |---|---|---|
    | no modal | `ui_find` ×40 | 40 hit |
    | in-app modal, settled | `ui_find` ×60, incl. controls *underneath* | 60 hit |
    | system alert, settled | `ui_find` ×20 on the alert's text | 20 hit |
    | system alert, settled | `ui_find` ×40 on the app beneath | 40 miss |
    | in-app modal | `ui_find`/`ui_tap` alternating ×15 | 30/30 agree |
    | system alert | `ui_find`/`ui_tap` alternating ×12, three labels | 72/72 agree |
    | system alert | `ui_describe_all` ×10 | same tree owner every time |

  - **Two real behaviours can look like the reported one**, and neither is a lookup flipping:
    - **A system alert replaces the app in the tree** (#37). Reads taken either side of one appearing or being dismissed see genuinely different screens. With Photos' sheet *and* a permission prompt in play, consecutive calls could straddle that boundary repeatedly.
    - **A tap issued during a presentation animation may not land**, and the next read then correctly reports the state that did not change. Measured: dismiss taps fired immediately after presenting failed in 2 of 3 rounds; with a 1s settle, 4 of 4 rounds dismissed cleanly and the label vanished immediately. The tree was right every time — the tap was the unreliable part.
  - **Not chased:** whether 2.0.2's code could genuinely flip. Reproducing a ghost from a version we no longer ship, in a scenario (Photos mid-wizard, prompt racing) that could not be held still then either, is worth less than the fixture that now makes both modal kinds reproducible on demand.
  - **Deliberately not documented in the tool descriptions.** The tap-mid-animation race was produced by a shell loop firing calls back to back over HTTP; an agent goes through an MCP round trip and a model turn between calls, which is orders of magnitude slower than the window. Advice it cannot act on would cost tokens in every session for a race it cannot hit — the tool descriptions are read on every connection, so anything in them has to earn its place.

## Verified working

- [x] **Landscape coordinate transformation is correct.** With the device rotated left, `detect_rotation` returned `landscape_left`, and coordinates taken from landscape space tapped their intended targets: Library tab at (87.5, 360) switched to Library, Collections tab at (192.5, 360) switched back, and the nav bar `...` at (751, 46) opened the overflow menu. Round-tripped, so not a coincidence of an already-selected tab.

## Coverage achieved in the 2026-08-12 run

Passed: `start_simulator`, `destroy_simulator` (both owned and detach paths), `attach_simulator`, `ui_describe_all` (with #22/#29/#34 caveats), `ui_describe_point`, `ui_tap` (coordinates **and** label), `ui_type`, `ui_swipe`, `ui_view`, `screenshot` (119KB PNG, 1206x2622), `record_video` + `stop_recording` (5.6MB file), `launch_app`, `detect_rotation` (`landscape_left`, after a human performed the rotation).

`ui_find` exercised but **failed** on a validly-labelled element — see #34.

Never exercised: `install_app` (#27, no fixture).
