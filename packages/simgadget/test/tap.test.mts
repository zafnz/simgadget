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
  toggleState,
  type TapGesture,
  type TapVerb,
} from "../src/ax/tap.ts";
import type { AXElement } from "../src/ax/tree.ts";

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
