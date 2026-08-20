/**
 * Fake-client tests for the acting half of `Simulator` (SIMGADGET_PLAN.md
 * step 5): `tap`, `typeText`, `swipe`, `pressButton`.
 *
 * This layer owns **wiring**. Which verb an element deserves, how long a touch
 * is held and how a raw toggle value reads are settled in `tap.test.mts` at
 * microsecond cost and are not re-proven through a method here. What only this
 * layer can show is that the calls go out in the right order, that the ones
 * that must not go out did not, and that a refusal arrives as the right typed
 * error carrying the right payload — because every branch in `tap()` exists
 * because a tap once silently did the wrong thing and reported success.
 *
 * The assertions are on *what reached the companion*: an empty `client.taps` is
 * the only thing that can prove a refusal happened before any event went out,
 * and `deps.calls.withClientExclusive` is the only thing that can prove a
 * double-tap took one lock rather than two.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Simulator } from "../src/simulator.ts";
import { frameContains, type AXElement } from "../src/ax/tree.ts";
import { MIN_TAP_HOLD_SECONDS } from "../src/ax/tap.ts";
import {
  ElementDisabledError,
  ElementNotFoundError,
  SimGadgetError,
  TapObstructedError,
  ToggleGestureError,
  UntypeableTextError,
} from "../src/errors.ts";
import { Button, SearchableKey } from "../src/idb/client.ts";
import { createFakeDeps, type FakeDeps } from "./fakes/deps.ts";
import {
  FakeIdbClient,
  createFakeIdbClient,
  markerIn,
  noElementError,
  screenTree,
  type FakeIdbOptions,
} from "./fakes/idb.ts";

const UDID = "UDID";

interface Harness {
  sim: Simulator;
  deps: FakeDeps;
  client: FakeIdbClient;
}

function harness(options: FakeIdbOptions = {}): Harness {
  const client = createFakeIdbClient(options);
  const deps = createFakeDeps({ client });
  // Answered before: every test here is about a simulator that is up, and an
  // unanswered udid would divert the reads into the recovery ladder that
  // `reading.test.mts` already owns.
  deps.recovery.markAnswered(UDID);
  return { sim: new Simulator(UDID, "iPhone", deps), deps, client };
}

/** Runs `fn` and returns the error it threw, failing if it did not throw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

/**
 * A point read that answers with whatever is drawn at that point, which is what
 * contract check 5 pins the real one doing. Later entries win, so a test can
 * lay an obstruction over an element the way a toolbar lies over a stepper.
 */
const hitTest =
  (...elements: AXElement[]) =>
  (x: number, y: number): AXElement | null => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const frame = elements[i].frame;
      if (frame && frameContains(frame, x, y)) return elements[i];
    }
    return null;
  };

const BUTTON: AXElement = {
  AXLabel: "Plain Button",
  type: "Button",
  frame: { x: 20, y: 100, width: 350, height: 44 },
};
/** Its centre, in the logical space a caller reads off the tree. */
const BUTTON_CENTRE = { x: 195, y: 122 };

const SWITCH: AXElement = {
  AXLabel: "Plain Switch",
  AXUniqueId: "PlainSwitch",
  type: "Switch",
  AXValue: "0",
  frame: { x: 20, y: 300, width: 282, height: 31 },
};

const markerCalls = (client: FakeIdbClient, matchKey: SearchableKey) =>
  client.calls.filter((call) => call.kind === "marker" && call.matchKey === matchKey);

// ---- tap by coordinate ----------------------------------------------------

test("tap({x, y})", async (t) => {
  await t.test("resolves nothing and hit-tests nothing", async () => {
    // Coordinates are the caller saying where, and are taken at their word:
    // there is no element to verify against, and a lookup would only invent
    // one. The only read is the screen rectangle the transform needs.
    const { sim, client } = harness({ screen: () => screenTree(390, 844) });

    const result = await sim.tap({ x: 100, y: 200 });

    assert.deepEqual(result, {
      acted: "touch",
      x: 100,
      y: 200,
      count: 1,
      durationSeconds: MIN_TAP_HOLD_SECONDS,
    });
    assert.equal("element" in result, false, "a coordinate tap resolved nothing to report");
    assert.deepEqual(
      client.calls.map((call) => call.kind),
      ["screen"]
    );
    assert.deepEqual(client.taps, [{ x: 100, y: 200, duration: MIN_TAP_HOLD_SECONDS }]);
  });

  await t.test("still transforms into the space the companion accepts", async () => {
    // Taken at their word about *where*, not about which coordinate space the
    // companion wants: input is portrait-space whatever the interface is doing.
    const { sim, client } = harness({ screen: () => screenTree(874, 402) });

    const result = await sim.tap({ x: 700, y: 200 });

    // landscape_right, derived from the shape: (x, y) -> (y, screenW - x).
    assert.deepEqual(client.taps, [{ x: 200, y: 174, duration: MIN_TAP_HOLD_SECONDS }]);
    // Reported back in the caller's own space, not the one we sent.
    assert.deepEqual({ x: result.acted === "touch" && result.x, y: result.acted === "touch" && result.y }, {
      x: 700,
      y: 200,
    });
  });

  await t.test("holds for the caller's duration when it is above the floor", async () => {
    const { sim, client } = harness({ screen: () => screenTree(390, 844) });

    await sim.tap({ x: 10, y: 10 }, { durationSeconds: 1.5 });

    assert.deepEqual(client.taps, [{ x: 10, y: 10, duration: 1.5 }]);
  });
});

// ---- tap by label: the order is the specification --------------------------

test("tap({label})", async (t) => {
  await t.test("resolves, hit-tests and reports the element it acted on", async () => {
    const { sim, client, deps } = harness({
      screen: () => screenTree(390, 844, [BUTTON]),
      marker: markerIn([BUTTON]),
      point: hitTest(BUTTON),
    });

    const result = await sim.tap({ label: "Plain Button" });

    assert.deepEqual(result, {
      acted: "touch",
      x: BUTTON_CENTRE.x,
      y: BUTTON_CENTRE.y,
      count: 1,
      durationSeconds: MIN_TAP_HOLD_SECONDS,
      element: BUTTON,
    });
    assert.deepEqual(client.taps, [
      { ...BUTTON_CENTRE, duration: MIN_TAP_HOLD_SECONDS },
    ]);
    // The touch is exclusive; the reads before it are not.
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);
  });

  await t.test("a label nothing matches throws ElementNotFoundError", async () => {
    const { sim, client } = harness({ screen: () => screenTree(390, 844) });

    const error = await caught(() => sim.tap({ label: "Nowhere" }));

    assert.ok(error instanceof ElementNotFoundError);
    assert.equal(error.query, "Nowhere");
    assert.deepEqual(client.taps, []);
  });

  await t.test("a disabled control is refused before anything is probed", async () => {
    // Free, and it forecloses a whole category of confusion: a disabled control
    // receives the touch and ignores it, so "the tap did nothing" looks
    // identical to a mis-aimed tap.
    const disabled = { ...BUTTON, AXLabel: "Disabled Button", enabled: false };
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [disabled]),
      marker: markerIn([disabled]),
      point: hitTest(disabled),
    });

    const error = await caught(() => sim.tap({ label: "Disabled Button" }));

    assert.ok(error instanceof ElementDisabledError);
    assert.equal(error.element.AXLabel, "Disabled Button");
    assert.deepEqual(client.taps, []);
    assert.equal(
      client.calls.filter((call) => call.kind === "point").length,
      0,
      "the refusal costs nothing, so nothing was probed"
    );
  });

  await t.test("an element with no usable frame is refused, not aimed at", async () => {
    const frameless = { AXLabel: "Ghost", type: "Button" };
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [frameless]),
      marker: markerIn([frameless]),
    });

    const error = await caught(() => sim.tap({ label: "Ghost" }));

    assert.ok(error instanceof SimGadgetError);
    assert.equal(error.code, "element-unusable-frame");
    assert.deepEqual(client.taps, []);
  });

  await t.test("count: 2 sends two taps inside one exclusive lock", async () => {
    // Interleaving another caller's input with a multi-tap would turn a
    // double-tap into two unrelated single taps, so both touches must happen
    // inside the same lock — not merely both happen.
    const { sim, client, deps } = harness({
      screen: () => screenTree(390, 844, [BUTTON]),
      marker: markerIn([BUTTON]),
      point: hitTest(BUTTON),
    });

    const result = await sim.tap({ label: "Plain Button" }, { count: 2 });

    assert.equal(result.acted === "touch" && result.count, 2);
    assert.deepEqual(client.taps, [
      { ...BUTTON_CENTRE, duration: MIN_TAP_HOLD_SECONDS },
      { ...BUTTON_CENTRE, duration: MIN_TAP_HOLD_SECONDS },
    ]);
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);

    const lock = deps.calls.order.indexOf(`withClient:${UDID} exclusive`);
    assert.deepEqual(deps.calls.order.slice(lock), [
      `withClient:${UDID} exclusive`,
      "client:tap",
      "sleep:50",
      "client:tap",
    ]);
  });
});

// ---- tap by label: the hit-test -------------------------------------------

test("tap({label}) hit-test", async (t) => {
  // The fixture's stepper sits under the toolbar: tapping it by name focused
  // the toolbar's *search field*, opened the keyboard, and answered "Tapped
  // successfully". Every frame involved was correct, so no amount of tree work
  // would have caught it — only asking what is actually at the point.
  const STEPPER: AXElement = {
    AXLabel: "Plain Stepper, Increment",
    type: "Button",
    frame: { x: 100, y: 700, width: 100, height: 40 },
  };
  const SEARCH: AXElement = {
    AXLabel: "Search",
    type: "SearchField",
    frame: { x: 120, y: 690, width: 200, height: 60 },
  };

  await t.test("refuses, naming what is in the way and where it probed", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [STEPPER, SEARCH]),
      marker: markerIn([STEPPER, SEARCH]),
      point: hitTest(STEPPER, SEARCH),
    });

    const error = await caught(() => sim.tap({ label: "Plain Stepper, Increment" }));

    assert.ok(error instanceof TapObstructedError);
    assert.equal(error.element.AXLabel, "Plain Stepper, Increment");
    assert.equal(error.obstruction?.AXLabel, "Search");
    // Logical coordinates — the centre the caller could have computed
    // themselves, not the portrait pair that went to the companion.
    assert.deepEqual(error.point, { x: 150, y: 720 });
    assert.deepEqual(client.taps, [], "the wrong action is worse than none");
  });

  await t.test("reports a null obstruction when nothing is there at all", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [STEPPER]),
      marker: markerIn([STEPPER]),
      // Scrolled off screen: the frame is still in the tree, the point is empty.
      point: () => null,
    });

    const error = await caught(() => sim.tap({ label: "Plain Stepper, Increment" }));

    assert.ok(error instanceof TapObstructedError);
    assert.equal(error.obstruction, null);
    assert.deepEqual(client.taps, []);
  });
});

// ---- tap by label: toggles -------------------------------------------------

test("tap({label}) on a toggle", async (t) => {
  await t.test("activates by identifier and reads the state back by it", async () => {
    // A label is a substring and the screen has just changed: the fixture's own
    // status line reads "Plain Switch = on" after the toggle, so a second
    // lookup by label finds that sentence rather than the control and reads
    // back no value at all. That was a real bug, found and fixed.
    const STATUS: AXElement = {
      AXLabel: "Plain Switch = on",
      type: "StaticText",
      frame: { x: 20, y: 400, width: 282, height: 20 },
    };
    let value = "0";
    let activated = false;
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [SWITCH, STATUS]),
      marker: (marker, matchKey) => {
        const current = { ...SWITCH, AXValue: value };
        if (matchKey === SearchableKey.UNIQUE_ID) {
          return marker === "PlainSwitch" ? current : null;
        }
        // Before the toggle the switch is the first hit; afterwards the status
        // line the app just wrote outranks it.
        return markerIn(activated ? [STATUS, current] : [current, STATUS])(marker, matchKey);
      },
      // Contract check 6: the action operates the switch without a touch.
      activate: () => {
        activated = true;
        value = "1";
      },
    });

    const result = await sim.tap({ label: "Plain Switch" });

    assert.deepEqual(result, {
      acted: "activation",
      element: SWITCH,
      before: "0",
      after: "1",
    });
    assert.deepEqual(client.activations, [
      { marker: "PlainSwitch", matchKey: SearchableKey.UNIQUE_ID },
    ]);
    assert.deepEqual(client.taps, [], "a toggle is operated, never touched");
    // One label query — the original lookup. The read-back went by identifier,
    // which is what stops it finding the status line.
    assert.equal(markerCalls(client, SearchableKey.LABEL).length, 1);
  });

  await t.test("activates by label when the element has no identifier", async () => {
    const anonymous: AXElement = { ...SWITCH, AXUniqueId: undefined };
    let value = "0";
    const { sim, client, deps } = harness({
      screen: () => screenTree(390, 844, [anonymous]),
      marker: (marker, matchKey) =>
        matchKey === SearchableKey.LABEL
          ? markerIn([{ ...anonymous, AXValue: value }])(marker, matchKey)
          : null,
      activate: () => {
        value = "1";
      },
    });

    const result = await sim.tap({ label: "Plain Switch" });

    assert.deepEqual(client.activations, [
      { marker: "Plain Switch", matchKey: SearchableKey.LABEL },
    ]);
    assert.equal(result.acted === "activation" && result.after, "1");
    // The activation takes the lock for the same reason a touch does.
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);
  });

  await t.test("leaves `after` undefined when the state could not be read back", async () => {
    // The host must be able to say the state could not be confirmed rather than
    // claim success.
    let activated = false;
    const { sim } = harness({
      screen: () => screenTree(390, 844, [SWITCH]),
      marker: (marker, matchKey) =>
        activated ? null : markerIn([SWITCH])(marker, matchKey),
      activate: () => {
        activated = true;
      },
    });

    const result = await sim.tap({ label: "Plain Switch" });

    assert.equal(result.acted, "activation");
    assert.equal(result.acted === "activation" && result.before, "0");
    assert.equal(result.acted === "activation" && "after" in result && result.after, undefined);
  });

  await t.test(
    'a "found no element" from the action API falls back to a real touch',
    async () => {
      // `AccessibilityActionRequest` has no backend field, so anything only
      // AXBridge can see — a switch in a toolbar, or one inside a sheet drawn
      // by another process — is findable and not activatable. That is exactly
      // the case where a coordinate genuinely works, so the tap is handed back
      // rather than the call failing.
      const { sim, client } = harness({
        screen: () => screenTree(390, 844, [SWITCH]),
        marker: markerIn([SWITCH]),
        point: hitTest(SWITCH),
        activate: (marker) => {
          throw noElementError(marker);
        },
      });

      const result = await sim.tap({ label: "Plain Switch" });

      assert.equal(result.acted, "touch");
      assert.equal(result.acted === "touch" && result.element?.AXUniqueId, "PlainSwitch");
      assert.equal(client.activations.length, 1, "the activation was tried first");
      // The fallback is the ordinary path, hit-test and hold included.
      assert.deepEqual(client.taps, [{ x: 161, y: 316, duration: MIN_TAP_HOLD_SECONDS }]);
    }
  );

  await t.test("any other activation failure is the caller's answer", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [SWITCH]),
      marker: markerIn([SWITCH]),
      point: hitTest(SWITCH),
      activate: () => {
        throw new Error("companion channel closed");
      },
    });

    const error = await caught(() => sim.tap({ label: "Plain Switch" }));

    assert.match((error as Error).message, /companion channel closed/);
    assert.deepEqual(client.taps, [], "a failure is not quietly retried as a touch");
  });

  await t.test("a hold aimed at a toggle is refused, not delivered", async () => {
    // A real touch at a toggle's centre lands nowhere: the frame spans the row
    // and the control is off to one side. Measured doing exactly that,
    // silently, before this check existed.
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [SWITCH]),
      marker: markerIn([SWITCH]),
      point: hitTest(SWITCH),
    });

    const error = await caught(() =>
      sim.tap({ label: "Plain Switch" }, { durationSeconds: 1 })
    );

    assert.ok(error instanceof ToggleGestureError);
    assert.equal(error.gesture, "hold");
    assert.equal(error.element.AXUniqueId, "PlainSwitch");
    assert.deepEqual(client.taps, []);
    assert.deepEqual(client.activations, [], "a hold is not silently downgraded either");
  });

  await t.test("a sub-floor duration is still a hold, and still refused", async () => {
    // The caveat `TapOptions.durationSeconds` now carries, pinned where a
    // caller meets it. Below the floor the touch delivered would have been
    // byte-identical to the default one, so this refusal is the *asking*
    // being read, not the number -- and the doc said "passing less changes
    // nothing" while this threw, which is what TODO #84 was.
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [SWITCH]),
      marker: markerIn([SWITCH]),
      point: hitTest(SWITCH),
    });

    const error = await caught(() =>
      sim.tap({ label: "Plain Switch" }, { durationSeconds: MIN_TAP_HOLD_SECONDS / 2 })
    );

    assert.ok(error instanceof ToggleGestureError);
    assert.equal(error.gesture, "hold");
    assert.deepEqual(client.taps, []);
    assert.deepEqual(client.activations, [], "not downgraded to the activation either");
  });

  await t.test("a multi-tap aimed at a toggle is refused as a multi-tap", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844, [SWITCH]),
      marker: markerIn([SWITCH]),
      point: hitTest(SWITCH),
    });

    const error = await caught(() => sim.tap({ label: "Plain Switch" }, { count: 2 }));

    assert.ok(error instanceof ToggleGestureError);
    assert.equal(error.gesture, "multi-tap");
    assert.deepEqual(client.taps, []);
  });
});

// ---- typeText --------------------------------------------------------------

test("typeText", async (t) => {
  await t.test("types under the exclusive lock", async () => {
    // Exclusive, so another caller's taps cannot land mid-string.
    const { sim, client, deps } = harness();

    await sim.typeText("hello world");

    assert.deepEqual(client.typed, ["hello world"]);
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);
  });

  await t.test("refuses before any event goes out, listing distinct characters", async () => {
    // Never a half-typed string: an app cannot undo one, and the caller cannot
    // tell how far it got.
    const { sim, client, deps } = harness();

    const error = await caught(() => sim.typeText("héllo — wörld — ok"));

    assert.ok(error instanceof UntypeableTextError);
    assert.deepEqual(error.characters, ["é", "—", "ö"]);
    assert.deepEqual(client.typed, []);
    assert.deepEqual(deps.calls.withClient, [], "nothing reached the companion at all");
  });
});

// ---- swipe -----------------------------------------------------------------

test("swipe", async (t) => {
  await t.test("transforms both endpoints with the same orientation", async () => {
    // One stale endpoint is a gesture in a direction nobody asked for.
    const { sim, client, deps } = harness({ screen: () => screenTree(874, 402) });

    await sim.swipe({ x: 700, y: 200 }, { x: 100, y: 200 });

    // landscape_right, derived from the shape: (x, y) -> (y, screenW - x).
    assert.deepEqual(client.swipes, [
      {
        start: { x: 200, y: 174 },
        end: { x: 200, y: 774 },
        options: { delta: undefined, duration: undefined },
      },
    ]);
    assert.equal(
      client.calls.filter((call) => call.kind === "screen").length,
      1,
      "one reading of the coordinate space, shared by both endpoints"
    );
    // A swipe is a stream of events; another caller's input landing between
    // them scrambles the gesture.
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);
  });

  await t.test("passes delta and duration through as given", async () => {
    // The library substitutes nothing: the client already turns `undefined`
    // into 0, and the defaults a caller sees belong to whatever host is asking.
    const { sim, client } = harness({ screen: () => screenTree(390, 844) });

    await sim.swipe({ x: 10, y: 20 }, { x: 10, y: 400 }, { delta: 5, durationSeconds: 2 });

    assert.deepEqual(client.swipes, [
      {
        start: { x: 10, y: 20 },
        end: { x: 10, y: 400 },
        options: { delta: 5, duration: 2 },
      },
    ]);
  });
});

// ---- pressButton -----------------------------------------------------------

test("pressButton", async (t) => {
  await t.test("maps every name onto idb's button enum", async () => {
    const cases: [Parameters<Simulator["pressButton"]>[0], Button][] = [
      ["home", Button.HOME],
      ["lock", Button.LOCK],
      ["side-button", Button.SIDE_BUTTON],
      ["siri", Button.SIRI],
      ["apple-pay", Button.APPLE_PAY],
    ];
    for (const [name, expected] of cases) {
      const { sim, client } = harness();
      await sim.pressButton(name);
      assert.deepEqual(
        client.buttons,
        [{ button: expected, duration: undefined }],
        `pressButton(${name})`
      );
    }
  });

  await t.test("holds for a caller's duration, exclusively", async () => {
    const { sim, client, deps } = harness();

    await sim.pressButton("home", { durationSeconds: 2 });

    assert.deepEqual(client.buttons, [{ button: Button.HOME, duration: 2 }]);
    assert.deepEqual(deps.calls.withClientExclusive, [UDID]);
  });

  await t.test("rejects a name no companion has an event for", async () => {
    const { sim, client } = harness();

    await assert.rejects(
      () => sim.pressButton("volume-up" as "home"),
      (error: unknown) => error instanceof TypeError
    );
    assert.deepEqual(client.buttons, []);
  });
});

// ---- the stale handle ------------------------------------------------------

test("acting on a deleted handle", async (t) => {
  await t.test("throws before anything reaches the companion", async () => {
    const { sim, deps } = harness({ screen: () => screenTree(390, 844) });
    await sim.delete();
    const before = deps.calls.order.length;

    for (const act of [
      () => sim.tap({ x: 1, y: 1 }),
      () => sim.typeText("hi"),
      () => sim.swipe({ x: 1, y: 1 }, { x: 2, y: 2 }),
      () => sim.pressButton("home"),
    ]) {
      await assert.rejects(act, { code: "simulator-not-found" });
    }
    assert.equal(deps.calls.order.length, before, "no dep was touched");
  });
});
