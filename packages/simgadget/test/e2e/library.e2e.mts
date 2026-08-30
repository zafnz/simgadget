/**
 * The whole API, in order, against the `testapp/` fixture on a real simulator —
 * the library-level analogue of TESTING_TOOLS.md, which drives the same fixture
 * through the MCP tools by hand.
 *
 * Every case here is one an in-process fake cannot answer, because the thing
 * being checked belongs to iOS, to `idb_companion`, or to the geometry between
 * them: whether the AXBridge read really does see inside a toolbar, whether a
 * marker query really is a substring, whether the action API really does refuse
 * an element it cannot reach, whether a coordinate read off a *landscape* tree
 * really lands where it was aimed. The unit suite proves the library calls the
 * right things in the right order; this proves the right things were the right
 * things.
 *
 * **The order is the specification.** Cases share one simulator and one running
 * app, and several depend on what the one before left on screen — the status
 * label, the scroll position, the interface orientation. The rotations in
 * particular have to run in the order written: iOS leaves the interface where
 * it was when it refuses an orientation, so `upside_down`'s answer is only
 * assertable because the rotate back to portrait ran first.
 *
 * **Assertions are on data, never on prose.** Nothing here matches an error
 * message; every failure is checked by `code` and payload, and every success by
 * something the app itself reports — its status label, a field's value, a
 * frame that moved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createSimulator,
  ElementDisabledError,
  TapObstructedError,
  ToggleGestureError,
  UntypeableTextError,
  type AXElement,
  type Simulator,
} from "../../src/index.ts";
import {
  deleteQuietly,
  ensureFixtureBuilt,
  FIXTURE_APP,
  FIXTURE_BUNDLE_ID,
  unavailable,
  useCachedCompanion,
  waitFor,
  waitUntilGone,
} from "./support.mts";

useCachedCompanion();

const SKIP = unavailable();

const DEVICE_NAME = "simgadget-e2e-library";

/** Flattens a pruned tree so a case can ask "is this element anywhere on
 * screen" without caring which container iOS put it in — which is exactly the
 * thing that moves between iOS releases. */
function flatten(elements: AXElement[]): AXElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function centre(frame: { x: number; y: number; width: number; height: number }) {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

describe("simgadget against the testapp fixture", { skip: SKIP }, () => {
  let sim: Simulator;
  let udid = "";
  let scratch = "";
  /** Portrait logical screen, read once the app is up. Every coordinate
   * assertion below is expressed against it rather than against a device the
   * suite happens to have been run on. */
  let portrait: { width: number; height: number };

  /** The app's own account of the last thing that happened to it. The fixture
   * routes every action through one status label precisely so a toolbar tap can
   * be confirmed without reading the toolbar. */
  async function status(): Promise<string> {
    const label = await sim.findByLabel("status:");
    assert.ok(label, "the fixture's status label is not on screen");
    return String(label.AXLabel);
  }

  /**
   * Asserts that `label` really is covered right now, and answers with what is
   * on top of it.
   *
   * The point of #107: two cases below need a control the toolbar covers, and
   * both used to *assume* one — so when 7c80498 added a row above them and
   * everything shifted 50pt, they failed as "the toggle did not take" and "the
   * refusal named nothing", which read as library bugs rather than layout ones.
   * Checking the precondition separately means the next such shift fails here,
   * saying the fixture moved, instead of over there saying the library broke.
   *
   * The fixture now pins `CoveredSwitch` and `CoveredButton` to the view's
   * bottom edge rather than putting them in the scrolling stack, so being
   * covered is a property of those two controls that no future row can change.
   */
  async function coveredBy(label: string): Promise<AXElement> {
    const element = await sim.findByLabel(label);
    assert.ok(element, `the fixture has no "${label}"`);
    const frame = element.frame;
    assert.ok(frame, `"${label}" has no frame`);

    const at = centre(frame);
    const onTop = await sim.describePoint(at.x, at.y);
    assert.ok(
      onTop,
      `"${label}" is meant to be covered, but its centre (${at.x}, ${at.y}) is empty — ` +
        `the fixture's covered controls have moved`
    );
    assert.notEqual(
      onTop.AXUniqueId,
      element.AXUniqueId,
      `"${label}" is meant to be covered, but its own centre resolves to itself`
    );
    return onTop;
  }

  /** Waits for the fixture to be frontmost. An app launch is asynchronous in a
   * way nothing in the library can observe, so this is the one thing worth
   * waiting for; no assertion under test is ever retried. */
  async function waitForFixture(): Promise<void> {
    await waitFor("the fixture to reach the foreground", () =>
      sim.findByIdentifier("PlainButton")
    );
  }

  before(async () => {
    await ensureFixtureBuilt();
    scratch = mkdtempSync(path.join(os.tmpdir(), "simgadget-e2e-"));
    sim = await createSimulator({ deviceType: "iPhone", name: DEVICE_NAME });
    udid = sim.udid;
    assert.equal(sim.lastBoot?.ready, true, "the simulator never became driveable");
  });

  after(async () => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (!udid) return;
    try {
      await sim.delete();
    } catch {
      // A failing case can leave a handle that refuses to work; the simulator
      // still has to go.
    }
    await deleteQuietly(udid);
  });

  // ---- install and launch --------------------------------------------------

  it("installs and launches the fixture", async () => {
    await sim.installApp(FIXTURE_APP);
    const launched = await sim.launchApp(FIXTURE_BUNDLE_ID, { terminateRunning: true });
    await waitForFixture();

    assert.equal(await status(), "status: ready");

    // The pid a successful launch actually reports. This assertion is here
    // because its absence is how `pid` stayed null for every launch that ever
    // succeeded: simctl answers `com.example.mcptestapp: 18900`, and the parse
    // was anchored at the start of a line beginning with the bundle id, so it
    // could never match. Nothing asserted on the value, so nothing noticed.
    assert.equal(typeof launched.pid, "number");
    assert.ok(launched.pid! > 0, `expected a real pid, got ${launched.pid}`);
  });

  // ---- reading -------------------------------------------------------------

  it("reads a screen that includes the contents of system chrome", async () => {
    const read = await sim.describeScreen();
    portrait = read.screen;

    assert.ok(portrait.width > 0 && portrait.height > 0);
    assert.ok(
      portrait.height > portrait.width,
      `expected a portrait screen, got ${portrait.width}x${portrait.height}`
    );
    assert.deepEqual(read.elements[0]?.frame, {
      x: 0,
      y: 0,
      width: portrait.width,
      height: portrait.height,
    });

    // The point of the case. Apple's AX translation graph has no parent→child
    // edge into a nav bar or a toolbar, so the default backend's tree stops at
    // the container: every one of these is on screen, labelled and tappable, and
    // absent from the cheap read. Their presence here is the AXBridge path
    // working, and it is what every lookup that falls back depends on.
    const ids = new Set(flatten(read.elements).map((e) => e.AXUniqueId));
    for (const id of ["NavButton", "ToolbarButton", "ToolbarSwitch", "ToolbarField"]) {
      assert.ok(ids.has(id), `${id} is missing from the tree — the AXBridge read has regressed`);
    }
    // ...and the plain hierarchy, which is what would still be there if it had.
    for (const id of ["PlainField", "PlainButton", "DisabledButton", "StatusLabel"]) {
      assert.ok(ids.has(id), `${id} is missing from the tree`);
    }
  });

  it("resolves a plain control on the cheap marker path", async () => {
    const button = await sim.findByLabel("Plain Button");

    assert.ok(button);
    assert.equal(button.AXUniqueId, "PlainButton");
    assert.equal(button.AXLabel, "Plain Button");
    assert.equal(button.type, "Button");
    assert.ok(button.frame && button.frame.width > 0 && button.frame.height > 0);
    // The marker query is `findByLabel`'s first step and `findByIdentifier`'s
    // only one, so this element being reachable by identifier is what says the
    // lookup above ended there rather than paying for the ~300ms tree read.
    assert.ok(await sim.findByIdentifier("PlainButton"));
  });

  it("reaches a control inside the toolbar, which only the tree walk can see", async () => {
    const toggle = await sim.findByLabel("Toolbar Switch");

    assert.ok(toggle, "the toolbar's switch could not be resolved by name at all");
    assert.equal(toggle.AXUniqueId, "ToolbarSwitch");
    assert.equal(toggle.AXLabel, "Toolbar Switch");
    // In the toolbar, i.e. the bottom band of the screen: this is a control the
    // plain hierarchy does not contain.
    assert.ok(toggle.frame && toggle.frame.y > portrait.height * 0.8);

    // Deliberately **not** asserted: which of `findByLabel`'s two paths served
    // that, or the `type` that would say. Measured over a run of forty
    // consecutive reads on one screen: for the first few after launch the
    // default backend does answer a marker query for this element (`CheckBox`,
    // its own word for a switch), and thereafter it stops, leaving the AXBridge
    // tree walk to answer it (`Switch`). The transition happened once and stuck.
    // Whatever drives it, "the default backend cannot see toolbar contents" is
    // true eventually rather than immediately, and an assertion on the path is
    // an assertion on that timing.

    // The proof that the AXBridge tree walk is what reached in, rather than a
    // marker query that happened to work: this element has *no* AXLabel to
    // marker-match, and its identifier ("ToolbarField") does not contain the
    // string being asked for, so neither of `findByLabel`'s two marker steps can
    // return it. Only the tree read can, and only because AXBridge sees inside
    // the toolbar.
    const field = await sim.findByLabel("Toolbar Search");
    assert.ok(field);
    assert.equal(field.AXUniqueId, "ToolbarField");
    assert.equal(field.AXLabel, undefined);
    assert.equal(field.AXValue, "Toolbar Search");
  });

  it("resolves by accessibility identifier, exactly, where a label is a substring", async () => {
    const field = await sim.findByIdentifier("PlainField");

    assert.ok(field);
    assert.equal(field.AXUniqueId, "PlainField");
    assert.equal(field.AXLabel, "Plain Field");
    assert.equal(field.AXValue, "Type here");
    assert.equal(field.type, "TextField");

    // The asymmetry between the two lookups, and the case that has to run on a
    // device: **the companion matches an identifier by substring**, exactly as
    // it matches a label — its own refusal says "found no element whose
    // AXUniqueId contains" — so every one of these returns a hit over the wire
    // and `findByIdentifier` is what discards it. A fake cannot show that,
    // because a fake that generalised substring to both keys would agree with a
    // library that had no filter at all.
    //
    // Cut every way, so an anchored match is ruled out along with a substring
    // one. `tap`'s toggle read-back is what depends on it: it re-reads by
    // identifier precisely because a label drifts, and the fixture's own status
    // line reads "Settings Switch = on" after a toggle.
    for (const near of ["PlainButto", "lainButton", "lainButto", "Plain", "Button"]) {
      assert.equal(
        await sim.findByIdentifier(near),
        null,
        `findByIdentifier(${JSON.stringify(near)}) resolved something — identifier matching is substring again`
      );
    }
    assert.equal((await sim.findByIdentifier("PlainButton"))?.AXUniqueId, "PlainButton");

    // ...while a *label* stays a substring, which is what every agent-facing
    // description of this library promises and what makes a partial name usable.
    for (const near of ["Plain Butto", "lain Button", "lain Butto"]) {
      assert.equal(
        (await sim.findByLabel(near))?.AXUniqueId,
        "PlainButton",
        `findByLabel(${JSON.stringify(near)}) missed — label matching has become exact`
      );
    }

    // Every path names this element the same thing, which is the whole point
    // of `canonicalise` and was not true until this suite found otherwise.
    // iOS's default backend, which serves the marker query, calls a UISwitch a
    // `CheckBox`; the tree calls it a `Switch`. `findByIdentifier` reported the
    // former and `describeScreen`/`describePoint` the latter, so an agent
    // branching on `type` behaved differently depending on which lookup
    // happened to answer. The marker path now runs `reconcileType` too.
    const byId = await sim.findByIdentifier("PlainSwitch");
    assert.equal(byId?.type, "Switch");
    const inTree = flatten((await sim.describeScreen()).elements).find(
      (e) => e.AXUniqueId === "PlainSwitch"
    );
    assert.equal(inTree?.type, "Switch");
  });

  it("matches on visible text where an element has no label", async () => {
    // A search field publishes no AXLabel and carries its visible text in
    // AXValue, which is the case the tree fallback's value matching exists for
    // — it is unnameable to a marker query.
    const searchBar = await sim.findByLabel("Search Bar");

    assert.ok(searchBar);
    assert.equal(searchBar.AXLabel, undefined);
    assert.equal(searchBar.AXValue, "Search Bar");
    assert.equal(searchBar.type, "SearchField");
  });

  it("answers a miss with null rather than an error", async () => {
    // Absent is an answer (design rule 3). Both lookups pay the full ladder
    // before saying so, which is the expensive way to be sure.
    assert.equal(await sim.findByLabel("ZZZ nothing is called this"), null);
    assert.equal(await sim.findByIdentifier("ZZZNoSuchIdentifier"), null);
  });

  it("hit-tests a point and names what is there", async () => {
    const button = await sim.findByLabel("Plain Button");
    const at = centre(button!.frame!);

    const found = await sim.describePoint(at.x, at.y);

    assert.ok(found);
    assert.equal(found.AXUniqueId, "PlainButton");
    // The point read is served by a different backend with its own vocabulary;
    // `reconcileType` is what makes this the same word the tree used.
    assert.equal(found.type, "Button");
  });

  // ---- acting --------------------------------------------------------------

  it("taps a control by name, and the app agrees it was touched", async () => {
    const button = await sim.findByLabel("Plain Button");
    const expected = centre(button!.frame!);

    const result = await sim.tap({ label: "Plain Button" });

    assert.equal(result.acted, "touch");
    assert.equal(result.element?.AXUniqueId, "PlainButton");
    assert.equal(result.count, 1);
    // The 0.1s floor, which is the difference between a touch that actuates
    // 5 times in 12 and one that actuates 12 in 12.
    assert.equal(result.durationSeconds, 0.1);
    assert.deepEqual(
      { x: result.x, y: result.y },
      { x: Math.round(expected.x), y: Math.round(expected.y) }
    );

    assert.equal(await status(), "status: tapped Plain Button");
  });

  it("operates a toggle through accessibility and reads the state back", async () => {
    // #107: this needs `Plain Switch` to be *reachable*, which is a fact about
    // where the stack happens to end rather than anything this case controls.
    // When 7c80498 pushed it under the toolbar, the failure here said "the
    // toggle did not take" — true, and useless. Stating the precondition means
    // the next shift says what actually went wrong.
    const reachable = await sim.findByLabel("Plain Switch");
    assert.ok(reachable?.frame, "the fixture has no Plain Switch");
    const at = centre(reachable.frame);
    const onTop = await sim.describePoint(at.x, at.y);
    assert.equal(
      onTop?.AXUniqueId,
      "PlainSwitch",
      `Plain Switch is covered at (${at.x}, ${at.y}) — the fixture's layout has shifted, ` +
        `which is a fixture problem and not a library one (#107)`
    );

    const result = await sim.tap({ label: "Plain Switch" });

    assert.equal(result.acted, "activation");
    assert.equal(result.element.AXUniqueId, "PlainSwitch");
    assert.equal(result.before, "0");
    assert.equal(result.after, "1");
    assert.notEqual(result.after, result.before);
  });

  it("refuses to activate a toggle the toolbar covers, and touches nothing", async () => {
    // #105. Before the fix this answered that it had activated the switch, the
    // switch did not move, and the toolbar's *button* fired instead — the one
    // failure mode worse than doing nothing, because the caller is told to
    // scroll and try again while something else has already been pressed.
    //
    // An activation used to skip the hit-test on the grounds that AXPress
    // reaches controls a finger cannot. It does not: it reaches whatever is on
    // top.
    const onTop = await coveredBy("Covered Switch");
    assert.equal(onTop.AXUniqueId, "ToolbarButton", "the fixture pins it under the toolbar button");

    const before = await status();

    await assert.rejects(sim.tap({ label: "Covered Switch" }), (error: unknown) => {
      assert.ok(error instanceof TapObstructedError);
      assert.equal(error.code, "tap-obstructed");
      assert.equal(error.element.AXUniqueId, "CoveredSwitch");
      assert.equal(error.obstruction?.AXUniqueId, "ToolbarButton");
      return true;
    });

    // The whole point: the toolbar button is wired to the status line, so if
    // anything reached it this says so. "covered toggle = on" would mean the
    // switch itself was operated behind the refusal.
    assert.equal(await status(), before);

    const stillOff = await sim.findByIdentifier("CoveredSwitch");
    assert.equal(stillOff?.AXValue, "0", "the switch must not have moved either");
  });

  it("falls back to a real touch for a toggle the action API cannot reach", async () => {
    // `AccessibilityActionRequest` has no `backend` field where the read request
    // does, so a lookup can fall back to AXBridge and an activation cannot: this
    // switch is findable and not activatable. The fall-back to an ordinary touch
    // is what keeps it operable by name, and `acted` is how a caller can tell
    // which of the two mechanisms ran.
    //
    // Position in the run is load-bearing, per the finding recorded on the
    // toolbar lookup above: for the first moments after launch the default
    // backend — the only one an action can use — *can* still reach into the
    // toolbar, and an activation would succeed. By here it has stopped, which is
    // the steady state a caller meets. Do not move this case earlier.
    const result = await sim.tap({ label: "Toolbar Switch" });

    assert.equal(
      result.acted,
      "touch",
      "the action API reached a toolbar switch — welcome news, but the fallback is now untested"
    );
    assert.equal(result.element?.AXUniqueId, "ToolbarSwitch");
    assert.equal(await status(), "status: toolbar toggle = on");
  });

  it("refuses a disabled control instead of swallowing the touch", async () => {
    const before = await status();

    await assert.rejects(sim.tap({ label: "Disabled Button" }), (error: unknown) => {
      assert.ok(error instanceof ElementDisabledError);
      assert.equal(error.code, "element-disabled");
      assert.equal(error.element.AXUniqueId, "DisabledButton");
      assert.equal(error.element.enabled, false);
      return true;
    });

    // The fixture's disabled button is wired to an action on purpose: a status
    // line reading "disabled button fired" would mean something activated a
    // control iOS says is off, which is a far more interesting failure.
    assert.equal(await status(), before);
  });

  it("refuses a covered control and names what is in the way", async () => {
    // A frame can be exactly right and still not be tappable at its centre.
    // Before the hit-test existed, a tap by name on a control under the toolbar
    // focused the *toolbar's search field*, opened the keyboard, and answered
    // "Tapped successfully".
    //
    // #107: this used the stepper, which was under the toolbar only because of
    // how much sat above it — so 7c80498 moved it clean off the screen and the
    // refusal came back with no obstruction to name. `CoveredButton` is pinned
    // to the view's bottom edge instead, so it is covered by construction, and
    // what covers it is read rather than assumed.
    const onTop = await coveredBy("Covered Button");
    const before = await status();

    await assert.rejects(sim.tap({ label: "Covered Button" }), (error: unknown) => {
      assert.ok(error instanceof TapObstructedError);
      assert.equal(error.code, "tap-obstructed");
      assert.equal(error.element.AXUniqueId, "CoveredButton");
      assert.ok(error.obstruction, "the refusal did not say what was in the way");
      assert.equal(
        error.obstruction.AXUniqueId,
        onTop.AXUniqueId,
        "the refusal must name the element the point read found"
      );
      // Reported in the caller's own coordinate space, not the portrait pair
      // actually sent, and derived from the screen rather than from a number
      // that was true on one device.
      assert.ok(error.point.y > portrait.height * 0.8);
      return true;
    });

    // The fixture wires the covered button to the status line, so "covered
    // button fired" here would mean the refusal was issued after the touch.
    assert.equal(await status(), before);
  });

  it("refuses a multi-tap aimed at a toggle by name", async () => {
    // A toggle's frame spans its whole row, so its centre is the gap between
    // label and control and no coordinate the tree can offer will hit it. A
    // single tap is turned into an activation instead; a double-tap has no such
    // escape, so it is refused rather than aimed at the gap.
    await assert.rejects(
      sim.tap({ label: "Plain Switch" }, { count: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof ToggleGestureError);
        assert.equal(error.code, "toggle-needs-plain-tap");
        assert.equal(error.element.AXUniqueId, "PlainSwitch");
        assert.equal(error.gesture, "multi-tap");
        return true;
      }
    );
  });

  it("types into the focused field, and the app reads it back", async () => {
    await sim.tap({ label: "Plain Field" });
    await sim.typeText("hello");

    assert.equal((await sim.findByIdentifier("PlainField"))?.AXValue, "hello");
    assert.equal(await status(), 'status: Plain Field = "hello"');
  });

  it("refuses text the simulator's keyboard cannot produce, before anything goes out", async () => {
    await assert.rejects(sim.typeText("é"), (error: unknown) => {
      assert.ok(error instanceof UntypeableTextError);
      assert.equal(error.code, "untypeable-text");
      assert.deepEqual(error.characters, ["é"]);
      return true;
    });

    // The half of the promise only a real device can check: the field still
    // holds what the previous case typed, so no partial string was delivered.
    assert.equal((await sim.findByIdentifier("PlainField"))?.AXValue, "hello");

    // Return dismisses the keyboard, which would otherwise cover the controls
    // the cases below read positions from.
    await sim.typeText("\n");
  });

  it("swipes, and the tree moves with the content", async () => {
    const idOf = (elements: AXElement[], id: string) =>
      flatten(elements).find((e) => e.AXUniqueId === id);

    const before = idOf((await sim.describeScreen()).elements, "PlainButton");
    assert.ok(before?.frame);

    await sim.swipe(
      { x: portrait.width / 2, y: portrait.height * 0.6 },
      { x: portrait.width / 2, y: portrait.height * 0.3 },
      { delta: 10, durationSeconds: 0.3 }
    );

    const after = idOf((await sim.describeScreen()).elements, "PlainButton");
    assert.ok(after?.frame);
    assert.ok(
      after.frame.y < before.frame.y - 50,
      `the content did not scroll: PlainButton moved from y=${before.frame.y} to y=${after.frame.y}`
    );
  });

  it("presses HOME, and the app is no longer on screen", async () => {
    await sim.pressButton("home");

    // HOME is the only way to leave an app without launching another, and the
    // fixture disappearing from the tree is what says it worked.
    await waitUntilGone("the fixture to leave the foreground", () =>
      sim.findByIdentifier("PlainButton")
    );
  });

  // ---- orientation ---------------------------------------------------------

  it("rotates to landscape, and a coordinate read off the landscape tree lands", async () => {
    // Relaunched rather than resumed: the previous cases scrolled the content
    // and filled a field, and a case about coordinates should not also be a case
    // about where the last one left the scroll view.
    await sim.launchApp(FIXTURE_BUNDLE_ID, { terminateRunning: true });
    await waitForFixture();
    assert.equal(await status(), "status: ready");

    const rotated = await sim.rotate("landscape_left");

    assert.equal(rotated.requested, "landscape_left");
    assert.equal(rotated.adopted, "landscape_left");

    const read = await sim.describeScreen();
    assert.deepEqual(read.screen, { width: portrait.height, height: portrait.width });

    // The nav bar, because it never scrolls: a coordinate case should fail for
    // the coordinate rather than for the layout.
    const navButton = flatten(read.elements).find((e) => e.AXUniqueId === "NavButton");
    assert.ok(navButton?.frame);
    const at = centre(navButton.frame);

    // The real assertion of the whole orientation story: a coordinate taken
    // straight out of a landscape tree, handed straight back, reaching the
    // element it pointed at. Everything between the two — the crossed HID
    // orientation map, the portrait transform, the cached dimensions — is
    // invisible when it works and produces a plausible-looking tap somewhere
    // else when it does not.
    const result = await sim.tap({ x: at.x, y: at.y });
    assert.equal(result.acted, "touch");
    assert.deepEqual(
      { x: result.x, y: result.y },
      { x: Math.round(at.x), y: Math.round(at.y) }
    );
    assert.equal(await status(), "status: tapped Nav Button");

    const shot = await sim.screenshot({ resizeTo: "points" });
    assert.equal(shot.orientation, "landscape_left");
    assert.equal(shot.width, read.screen.width);
    assert.equal(shot.height, read.screen.height);
  });

  it("rotates back to portrait", async () => {
    const rotated = await sim.rotate("portrait");

    assert.equal(rotated.requested, "portrait");
    assert.equal(rotated.adopted, "portrait");
    assert.deepEqual((await sim.describeScreen()).screen, portrait);
  });

  it("reports the orientation an iPhone actually adopts when it declines one", async () => {
    // No Face ID iPhone adopts upside-down portrait whatever its Info.plist
    // says, and iOS leaves the interface where it was when it refuses — which
    // is why the rotate back to portrait above is what makes a specific
    // expected value assertable here at all.
    const rotated = await sim.rotate("upside_down");

    assert.equal(rotated.requested, "upside_down");
    assert.equal(rotated.adopted, "portrait");
  });

  // ---- capture -------------------------------------------------------------

  it("captures a screenshot in the coordinate space taps live in", async () => {
    const shot = await sim.screenshot({ resizeTo: "points" });

    assert.equal(shot.format, "png");
    assert.ok(shot.data.length > 0);
    // `resizeTo: "points"` means the image is directly comparable with anything
    // a describe reported — same numbers, same axes.
    assert.equal(shot.width, portrait.width);
    assert.equal(shot.height, portrait.height);
    assert.equal(shot.orientation, "portrait");
  });

  it("records a video and leaves a file behind", async () => {
    const output = path.join(scratch, "recording.mp4");

    await sim.startRecording(output);
    // Something for it to record. Two taps a moment apart, so the file has more
    // than a single frame in it.
    await sim.tap({ label: "Plain Button" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await sim.tap({ label: "Plain Button" });

    const stopped = await sim.stopRecording();

    assert.equal(stopped.path, output);
    // Non-empty is the whole assertion: SIGINT rather than SIGKILL is what lets
    // simctl finalize the container, and a killed recording leaves a file that
    // exists and is not a video.
    assert.ok(statSync(output).size > 0, "the recording is an empty file");
  });
});
