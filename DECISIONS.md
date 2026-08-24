# Resolved implementation decisions — SimGadget library phase

Read alongside `SIMGADGET.md` (authoritative spec) and `SIMGADGET_PLAN.md` (plan).
Everything here has already been settled — by the spec, by the plan's "Open items
— all resolved", or by the repository owner during this session. **Do not
relitigate any of it.** If you believe one of these is wrong, stop and say so in
your report rather than implementing something else.

## Settled by the owner this session

1. **`boot()` always opens Simulator.app.** `Simulator.boot()` and
   `createSimulator({boot: true})` run `run("open", ["-a", "Simulator.app"])`,
   exactly as today's `start_simulator` does. `createSimulator({boot: false})`
   does not. No new option on `CreateOptions` — the signature stays frozen.
   Reason: `simctl boot` alone leaves no window, and the MCP server may only use
   the public API, so if the library does not do this nobody can.

2. **Open unions are spelled `| (string & {})`, not `| string`.** Applies to
   `Orientation` and `SimulatorState`. Written as the spec has it, the trailing
   `| string` collapses the union and `rotate("portriat")` type-checks. `(string
   & {})` keeps the four literals in autocomplete and in error messages while
   still accepting any string. Runtime behaviour is identical.

## Types and where they live

3. **Two orientation types, deliberately.**
   - `packages/simgadget/src/ax/orientation.ts` keeps its existing
     `Orientation`, which **includes `"auto"`**. That file and its test move
     unchanged; treat it as the *hint* vocabulary. Alias it at use sites as
     `OrientationHint` for readability — do not rename the export.
   - The **public** `Orientation` (four literals + `(string & {})`, no `"auto"`)
     is a distinct type declared with the other public types. `"auto"` must
     never cross the API boundary: `getEffectiveOrientation` resolves it at
     every boundary.

4. **`AXElement`.** `ax/tree.ts`'s internal type carries `[key: string]:
   unknown` and stays as it is. The **public** `AXElement` is the closed type
   from the spec. The conversion point is `canonicalise`. Until the public type
   lands (plan step 8), import the internal one and leave a comment saying so.

## Handle state — three lifetimes, per the spec's coordinate contract

5. **`screenDims: {width, height} | null`** — *logical* dimensions from the most
   recent describe's root frame. This is the port of today's `SimSession.screenDims`.
   Refreshed by any describe; invalidated (set to null) by `rotate()` and
   `detectOrientation()`. Per handle.

6. **`portraitPoints: {width, height} | null`** — the *portrait* point dimensions,
   sourced from the companion's `describe()` call
   (`TargetDescription.screenDimensions.widthPoints` / `.heightPoints`).
   **Cached forever**: a udid's device type is fixed at creation, so these are a
   property of the model. This is the one deliberate piece of new code in this
   phase (plan "Open items" #2, spec "Portrait point dimensions come from
   `describe`"); contract check #9 is its gate. It answers from target metadata
   while the bridge is still silent, so it is available before the simulator is
   driveable — which the accessibility-read source never was.

7. **`orientationHint: OrientationHint`** — starts `"auto"`; set authoritatively
   by `rotate()` and `detectOrientation()`. Per handle. Two handles on one udid
   each carry their own; that hazard is documented in the spec's coordinate
   contract and is deliberate.

8. **The aspect refresh is a pure function.** The contract says the orientation
   *aspect* is re-derived free on every describe while *chirality* rides on the
   hint. Implement that as one pure, tested function, e.g.

   ```ts
   /** A describe that contradicts the hint's aspect retires it; one that agrees
    * leaves it alone, because a describe cannot tell the two landscapes apart. */
   export function reconcileHint(hint: OrientationHint, isLandscape: boolean): OrientationHint
   ```

   Returns `"auto"` when a non-auto hint's aspect disagrees with what was just
   observed (so `getEffectiveOrientation` re-derives from shape), and the hint
   unchanged otherwise. Call it wherever a describe yields a root frame.

9. **Recovery state is udid-keyed, never per-handle** (spec Decisions register,
   plan open item #1). `hasAnsweredAccessibility`, the cooldown timestamp and the
   in-flight dedup live in an internal registry keyed by udid, reached through
   the handle, read through the deps seam so a fake clock drives the cooldown,
   and cleared by `delete()` (today's `forgetSimulator`).

## Method-level decisions

10. **`describePoint(x, y)` is public and takes LOGICAL coordinates.** It
    transforms to portrait space internally (today that transform lives in the
    `ui_describe_point` tool body, index.ts:2110–2129) and performs the
    remote-hosted frame correction (index.ts:2139–2152) — `isRemotelyHosted`,
    then `locateInTree` over a `describeScreen`, replacing the *frame* only,
    never the identity. It returns `null` for an empty point (deliberate change
    #3) and still throws for a genuine wedge.

    The **internal** point read that takes portrait coordinates (today's
    `describePoint`, index.ts:305) stays private: `detectOrientation`'s probes
    and `tap`'s hit-test both need the untransformed, uncorrected form.

11. **`screenSize()`** is the cheap (~13ms) unpruned read: root frame → logical
    `{width, height}`, refreshing `screenDims` and reconciling the hint. It
    replaces public access to the raw tree.

12. **`startRecording(path)` / `screenshot({path})` resolve relative paths with
    `path.resolve()`** against the process cwd, and nothing more. The
    `~/Downloads` and `DEFAULT_OUTPUT_DIR` behaviour is host policy and stays in
    the server.

13. **simctl "Invalid device"-shaped failures map to `SimulatorNotFoundError`**
    at the deps boundary, as does a companion that cannot resolve a vanished
    udid. A stale handle (after `delete()`) throws the same before touching
    simctl at all. The spec's rule is "a clear error, never a gRPC timeout".

14. **`pressButton`** maps `"home" | "lock" | "side-button" | "siri" |
    "apple-pay"` onto `HIDEvent_HIDButtonType` (`HOME`, `LOCK`, `SIDE_BUTTON`,
    `SIRI`, `APPLE_PAY`), exported from `idb/client.ts` as `Button`.

15. **`swipe` and the library's defaults.** The library passes `delta` and
    `duration` through as given; the client already substitutes 0 for
    `undefined`. The zod defaults (`duration: "1"`, `delta: 1`) are the
    *server's* and stay there.

## Settled after step 1, from what it taught

16. **Every relative import inside `src/` carries a `.ts` extension.** Write
    `from "./ax/tree.ts"`. `tsconfig.json` sets
    `"rewriteRelativeImportExtensions": true`, so the build emits `./ax/tree.js`
    and the published JavaScript is correct.

    The reason is that `node --test` runs the sources directly: a `src/` file
    with ESM syntax is loaded as ESM, and ESM resolution never guesses an
    extension, so `from "./client"` does not resolve and the file cannot be
    unit-tested at all. The existing `ax/` tests never hit this because that
    directory is deliberately dependency-free. The alternative — a bespoke
    module-resolution hook under `test/` — was implemented, reviewed and
    removed in favour of the compiler flag.

    A `.ts` specifier does survive into the emitted `.d.ts`. That is harmless
    and was verified: TypeScript maps `./x.ts` to `./x.d.ts`, and a consumer
    typechecks under `node16`, `bundler` and `node10` alike. Do not "fix" it.

17. **Tests need `--experimental-transform-types`**, already in the package's
    `test` and `test:e2e` scripts. Node's strip-only mode cannot handle the
    `enum`s in the generated proto code or the parameter property in
    `idb/client.ts`. Do not work around this by editing either file.

18. **`waitUntilDriveable` no longer marks the simulator as having answered,
    and step 3 must restore that.** The original (`index.ts:1137`) called
    `markAccessibilityAnswered(udid)` the moment a real frame came back, with
    the comment "from here on, a failed read is a regression rather than a
    wait". `lifecycle.ts` dropped it because the udid-keyed recovery registry
    does not exist yet. **This is load-bearing**: `shouldRecover` refuses to
    restart a bridge for a simulator that has never answered, so without this
    call no simulator is ever eligible for recovery and the wedge cure is dead
    code. Step 3 owns the registry and owes it this wiring.

19. **`companions.close`/`reopen`/`shutdown` belong in the deps seam.**
    `lifecycle.ts` currently calls `companions.reopen(udid)` directly, which
    means a unit test mutates the real process-global companion registry and
    cannot observe the call. Step 2b needs to observe exactly this (`delete()`
    must close the companion *before* any simctl call), so step 2b adds
    `closeCompanion` / `reopenCompanion` / `shutdownCompanion` to
    `SimulatorDeps` and moves `lifecycle.ts`'s two direct calls onto it.

20. **`Simulator._recordBoot` is a placeholder to be removed in step 2b.** It
    exists only because `lifecycle.ts` had to set `lastBoot` after
    construction. Once `boot()` exists it should own the whole sequence
    (`simctl boot` → `open -a Simulator.app` → `waitUntilDriveable` → record),
    and `createSimulatorWith` should call `handle.boot({budgetMs})` instead of
    duplicating it. An underscore-prefixed method otherwise ships on the
    public type.

21. **The recovery registry is a process-level singleton, and tests must not
    share it.** `internal/registry.ts` exports `recoveryRegistry`, which is
    right for production — two handles on one udid must share one recovery
    attempt. It is wrong for tests, where one case's `markAnswered` would leak
    into the next and quietly decide whether recovery is even eligible. Step 3
    puts the registry on `SimulatorDeps` (defaulting to the singleton in
    `realDeps`) so a fake supplies a fresh one per test, the same way
    `now()` supplies a fake clock.

22. **Step 3 leaves the coordinate transform as a named seam.** `describePoint`
    is public and takes *logical* coordinates, but the transform needs the
    orientation hint, which step 4 owns. Step 3 funnels it through one private
    method — `toPortrait(x, y)` — which is the identity for now, with a comment
    saying step 4 replaces it. That is correct rather than merely incomplete for
    a portrait device, and it keeps step 4's job to one call site instead of
    five. Same for the root-frame bookkeeping: every describe that yields a root
    frame calls one private `noteRootFrame(frame)`, which caches the logical
    dimensions in step 3 and additionally reconciles the orientation hint (item
    8) in step 4.

23. **After step 3, `readPoint` returns `AXElement | null`.** An empty point is
    `null`, where the old code threw. Step 4's `detectOrientation` probes must
    read `?.AXLabel`, not `.AXLabel`, and treat `null` as "no match at this
    position" — which is exactly what the probe wants anyway.

24. **Open question for the e2e run and step 10: is a `UNIQUE_ID` marker match
    exact or substring?** Nothing pins it. `findByIdentifier` is documented as
    exact (index.ts:172) and the plan's step-9 e2e asserts exact, but the
    companion's marker path is substring for `LABEL` (contract check 1) and no
    check covers `UNIQUE_ID`. The fake currently generalises substring to both,
    which is the one place it claims more than a check verifies — a tether-rule
    exception, flagged rather than hidden. It matters: `findByLabel` falls back
    to an identifier lookup, so if `UNIQUE_ID` matched by substring a label
    lookup could silently resolve a partial identifier, and `tap`'s toggle
    read-back depends on the identifier being exact. **Step 10 adds a contract
    check for it, and the e2e settles it against the real binary.**

25. **The library has no verbose logging, deliberately.** The server's four
    `vlog` lines around recovery are gone; `SIMGADGET_VERBOSE` is server-only
    per the spec's config table, and the facts those lines carried now live in
    `ReadyResult.recoveryTried` and `SimulatorNotAnsweringError.recoveryTried`.
    Consequence for the docs step: BOOT_BUG.md's "verbose mode logs it" is
    wrong for a library user and needs a line saying where to look instead.

26. **Step 10 owes contract checks for two unpinned beliefs, not one.**
    - `UNIQUE_ID` marker matching: exact or substring (item 24).
    - **`accessibility_action` reports an element it cannot reach with "found no
      element".** Check 7 pins that wording for a marker *read*; nothing pins it
      for the *action* API, and `tap({label})`'s fall-back-to-a-real-touch on a
      toolbar switch depends on it entirely. It is the wording the server has
      matched in production since the toggle path was written, so this is
      recording a belief rather than doubting it — but an unpinned belief is
      exactly what the tether rule exists to catch.

27. **`ax/` modules may now import each other.** `ax/tap.ts` imports
    `ax/tree.ts` for `isToggle`. CLAUDE.md's current wording forbids this
    ("dependency-free, including on each other"), but its own stated
    justification is running under `node --test` with nothing to build, which
    `.ts` specifiers plus `rewriteRelativeImportExtensions` deliver regardless.
    The property that actually matters, and still holds, is **no companion, no
    simulator, no filesystem, no clock** — purity, not isolation. The CLAUDE.md
    rewrite in the docs step must restate the rule that way rather than leave a
    prohibition the code no longer obeys.

## Standing rules for every agent

- **Never change the public API without asking. No exceptions.** The surface is
  still being built, so it is not immutable — but every change to it is the
  repository owner's call, not an implementing agent's, and not the
  orchestrator's. That covers a signature, a return shape, a new or removed
  method or option, an error's code or payload, and the export list. If your
  work would be better with a different API, **stop and say so in your report,
  with the reason** — do not make the change and mention it afterwards, and do
  not quietly write around the awkwardness either, because working around it
  hides the finding. A test you cannot write from the public surface is an API
  finding worth surfacing, not a reason to import an internal.

- ~~**Never edit anything under the repo-root `src/`.**~~ **Spent 2026-08-23,
  at step 3.6.** It was the frozen legacy server, still built and run by
  `scripts/imsmd.sh`, guarded by `scripts/check-frozen-legacy.mjs`. All three
  are deleted: the server, the check and its manifest. Kept here because the
  rule shaped the work recorded below it — a reader meeting a reference to the
  freeze check further down should know it no longer exists rather than go
  looking for it.
- **Never start, stop or signal a server.** A daemon is running on port 8008
  from this checkout and it is not yours. Do not `pkill`, do not `kill`, do not
  probe other ports.
- **Never touch a simulator you did not create.** `F60E4D69-DBB4-4054-B262-81370DFAB00C`
  (`whisky-autofill_iphone-16-pro`) belongs to that daemon. If you need a
  simulator, create your own and delete it when you are done, including on
  failure.
- **Code is copied, at least in spirit, rather than reinvented.** Nearly every
  line being moved is the way it is because a simulator boot was spent finding
  out that the obvious version is wrong. Port the comments too — they are the
  evidence, and they are why the constants are what they are.
- **Comments explain why, never what.** Match
  `packages/simgadget/src/ax/tree.ts` and
  `packages/simgadget/src/idb/companionManager.ts` for register. (Paths updated
  2026-08-24: these were `src/ax/` and `src/idb/` when this was written, and the
  files moved to the library at step 2. The instruction is unchanged.) Do not add comments that restate
  the code.
- Verify with `npm run typecheck -w simgadget` and `npm test -w simgadget` from
  the repo root. Both green before you report.
- Do not commit. Report what you did, the exact command output, and any
  judgement call the spec did not settle.
