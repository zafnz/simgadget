/**
 * Pure tests for the tap rules (`src/ax/tap.ts`).
 *
 * These are the decisions that are wrong in ways a type checker cannot see and
 * a simulator boot is expensive to see: whether a control is operated or
 * touched, how long the touch is held, what a toggle's raw value says. Each one
 * traces to a tap that once did the wrong thing and reported success, so each
 * one is checked as a table rather than by example.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_TAP_HOLD_SECONDS,
  decideTapVerb,
  holdSeconds,
  hitTestReaches,
  toggleState,
  type TapGesture,
  type TapVerb,
} from "../src/ax/tap.ts";
import { sameElement, type AXElement } from "../src/ax/tree.ts";

/** A switch as the tree reports one: a role `isToggle` accepts, and a value. */
const SWITCH: AXElement = {
  AXLabel: "Plain Switch",
  type: "Switch",
  AXValue: "0",
  frame: { x: 20, y: 300, width: 282, height: 31 },
};

/** The same control as a *point* read names it; the backends disagree and a
 * caller can hand the library either. */
const CHECKBOX: AXElement = { ...SWITCH, type: "CheckBox" };

const BUTTON: AXElement = {
  AXLabel: "Plain Button",
  type: "Button",
  frame: { x: 20, y: 100, width: 350, height: 44 },
};

test("holdSeconds", async (t) => {
  await t.test("is a floor, not a default", () => {
    const cases: [number | undefined, number][] = [
      // Nothing asked for: the floor is what makes an ordinary tap land.
      [undefined, MIN_TAP_HOLD_SECONDS],
      // An instantaneous touch actuates about half the time, so a caller
      // asking for one gets the floor anyway — the distinction they care about
      // is tap versus long press.
      [0, MIN_TAP_HOLD_SECONDS],
      [0.05, MIN_TAP_HOLD_SECONDS],
      [MIN_TAP_HOLD_SECONDS, MIN_TAP_HOLD_SECONDS],
      // Above the floor the caller's own number survives untouched, including
      // past UIKit's 0.5s long-press threshold, which is the whole point of
      // being able to ask.
      [0.3, 0.3],
      [2, 2],
    ];
    for (const [requested, expected] of cases) {
      assert.equal(holdSeconds(requested), expected, `holdSeconds(${requested})`);
    }
  });

  await t.test("treats a non-finite duration as none at all", () => {
    // `Math.max(NaN, 0.1)` is NaN, which would reach the companion as a hold of
    // nothing — the exact failure the floor exists to prevent.
    for (const bad of [NaN, Number.POSITIVE_INFINITY * 0]) {
      assert.equal(holdSeconds(bad), MIN_TAP_HOLD_SECONDS, `holdSeconds(${bad})`);
    }
    assert.equal(holdSeconds(Number.POSITIVE_INFINITY), MIN_TAP_HOLD_SECONDS);
  });
});

test("decideTapVerb", async (t) => {
  const cases: [string, AXElement, TapGesture, TapVerb][] = [
    // An ordinary control is touched, whatever gesture was asked for.
    ["a button, plain tap", BUTTON, {}, "touch"],
    ["a button, held", BUTTON, { durationSeconds: 1 }, "touch"],
    ["a button, double-tapped", BUTTON, { count: 2 }, "touch"],

    // Disabled is decided first and for every gesture: a disabled control
    // receives the touch and ignores it, so the symptom is indistinguishable
    // from a mis-aimed tap.
    ["a disabled button", { ...BUTTON, enabled: false }, {}, "element-disabled"],
    [
      "a disabled toggle, plain tap",
      { ...SWITCH, enabled: false },
      {},
      "element-disabled",
    ],
    [
      "a disabled toggle, held",
      { ...SWITCH, enabled: false },
      { durationSeconds: 1 },
      "element-disabled",
    ],

    // A plain tap on a toggle is an activation: its frame spans the row, so
    // its centre is not the control, measured 0/6 and 0/8.
    ["a switch, plain tap", SWITCH, {}, "activation"],
    ["a switch, count: 1 spelled out", SWITCH, { count: 1 }, "activation"],
    ["a point read's checkbox", CHECKBOX, {}, "activation"],

    // A hold or a multi-tap can only be a real touch, so it is refused rather
    // than delivered to a coordinate that cannot work.
    ["a switch, held", SWITCH, { durationSeconds: 1 }, "toggle-needs-plain-tap"],
    // Including a duration below the floor: asking for a duration at all is
    // what makes it a hold, not the number chosen.
    [
      "a switch, held for less than the floor",
      SWITCH,
      { durationSeconds: 0.01 },
      "toggle-needs-plain-tap",
    ],
    ["a switch, double-tapped", SWITCH, { count: 2 }, "toggle-needs-plain-tap"],

    // `isToggle` wants a value as well as a role — a button is pressed, a
    // toggle is switched, and only the second has a state to read back.
    ["a switch-typed element with no value", { ...SWITCH, AXValue: undefined }, {}, "touch"],
  ];

  for (const [name, element, gesture, expected] of cases) {
    await t.test(`${name} -> ${expected}`, () => {
      assert.equal(decideTapVerb(element, gesture), expected);
    });
  }

  await t.test("defaults to a plain tap when given no gesture at all", () => {
    assert.equal(decideTapVerb(SWITCH), "activation");
    assert.equal(decideTapVerb(BUTTON), "touch");
  });
});

test("toggleState", async (t) => {
  await t.test("reads iOS's own spelling of a switch's state", () => {
    // iOS reports the state as the *string* "1", but a point read has been seen
    // to answer with the number, so both are accepted.
    const cases: [unknown, string][] = [
      ["1", "on"],
      [1, "on"],
      ["0", "off"],
      [0, "off"],
    ];
    for (const [value, expected] of cases) {
      assert.equal(toggleState(value), expected, `toggleState(${JSON.stringify(value)})`);
    }
  });

  await t.test("passes anything else through rather than guessing", () => {
    // A stepper's "3", a segmented control's selected title, an absent value:
    // none of these is a switch position, and rendering them as "off" would be
    // a confident lie.
    assert.equal(toggleState("3"), "3");
    assert.equal(toggleState("Celsius"), "Celsius");
    assert.equal(toggleState(undefined), "undefined");
    assert.equal(toggleState(null), "null");
  });
});

// ---- hitTestReaches --------------------------------------------------------

test("hitTestReaches", async (t) => {
  const target: AXElement = {
    AXLabel: "Plain Switch",
    AXUniqueId: "PlainSwitch",
    type: "Switch",
    AXValue: "0",
    frame: { x: 61, y: 745, width: 282, height: 28 },
  };

  await t.test("an empty point does not reach anything", () => {
    // The commoner of the two failures, and the one that has no obstruction to
    // name: an element scrolled past the bottom of the screen keeps a perfectly
    // correct frame whose centre belongs to nothing.
    assert.equal(hitTestReaches(target, null), false);
  });

  await t.test("the element itself reaches it", () => {
    assert.equal(hitTestReaches(target, target), true);
  });

  await t.test("a different element at the point does not", () => {
    // #105's case, measured: a switch under the toolbar hit-tests to the
    // toolbar's own control, and activating it operated that instead.
    const toolbarSwitch: AXElement = {
      AXLabel: "Toolbar Switch",
      AXUniqueId: "ToolbarSwitch",
      type: "Switch",
      AXValue: "0",
      frame: { x: 169, y: 808, width: 63, height: 28 },
    };
    assert.equal(hitTestReaches(target, toolbarSwitch), false);
  });

  await t.test("a child of the element still reaches it", () => {
    // The `StaticText` inside a button is what a point read returns for the
    // button, and refusing that would refuse every labelled button on screen.
    const inner: AXElement = {
      AXLabel: "Plain Switch",
      type: "StaticText",
      frame: { x: 73, y: 750, width: 106, height: 18 },
    };
    assert.equal(hitTestReaches(target, inner), true);
  });

  await t.test("the same control read twice reaches it, whatever the read named it", () => {
    // The two elements come from different reads — a lookup by label and a
    // hit-test by point — so identity is not available and the unique id is
    // what carries across.
    const byPoint: AXElement = {
      AXUniqueId: "PlainSwitch",
      type: "Switch",
      frame: { x: 61, y: 745, width: 282, height: 28 },
    };
    assert.equal(hitTestReaches(target, byPoint), true);
  });
});

test("hitTestReaches is stricter than sameElement about containment", async (t) => {
  // The fixture geometry that defeated the first version of this gate, kept as
  // numbers because that is what made it wrong: `sameElement` accepts frame
  // containment either way round, so the covering toolbar button compared equal
  // to the switch it was covering and a covered activation went through.
  const coveredSwitch: AXElement = {
    AXLabel: "Covered Switch",
    AXUniqueId: "CoveredSwitch",
    type: "Switch",
    AXValue: "0",
    frame: { x: 40, y: 808, width: 63, height: 28 },
  };
  const toolbarButton: AXElement = {
    AXLabel: "Toolbar Button",
    AXUniqueId: "ToolbarButton",
    type: "Button",
    frame: { x: 6.666666666666661, y: 803, width: 138.99999999999997, height: 38 },
  };

  await t.test("a control that encloses the target has not reached it", () => {
    assert.equal(sameElement(coveredSwitch, toolbarButton), true, "the looser rule accepts it");
    assert.equal(hitTestReaches(coveredSwitch, toolbarButton), false, "this one must not");
  });

  await t.test("and the enclosing direction that does count still counts", () => {
    // Same two frames, opposite roles: aiming at the button and landing on
    // something inside it is a hit.
    const inner: AXElement = {
      type: "StaticText",
      frame: { x: 40, y: 808, width: 63, height: 28 },
    };
    assert.equal(hitTestReaches(toolbarButton, inner), true);
  });
});
