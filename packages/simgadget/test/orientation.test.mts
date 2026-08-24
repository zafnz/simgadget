import test from "node:test";
import assert from "node:assert/strict";

import type { Orientation } from "../src/ax/orientation.ts";
import {
  candidateOrientations,
  getEffectiveOrientation,
  reconcileHint,
  transformPointToPortrait,
} from "../src/ax/orientation.ts";
import { OrientationType } from "../src/idb/client.ts";
import { HID_ORIENTATION } from "../src/simulator.ts";

/** The four real orientations, in the vocabulary the library speaks. */
const ALL = [
  "portrait",
  "upside_down",
  "landscape_left",
  "landscape_right",
] as const;

// An iPhone 17 Pro on its side, in logical coordinates: this is what
// describe_all reports and what a caller's coordinates are in. Portrait space —
// what the companion accepts — is the same screen 402 wide by 874 tall.
const W = 874;
const H = 402;

test("getEffectiveOrientation", async (t) => {
  await t.test("a detected orientation is used as given", () => {
    for (const o of ["portrait", "upside_down", "landscape_left", "landscape_right"] as const) {
      assert.equal(getEffectiveOrientation(o, W, H), o);
    }
  });

  // "auto" can only read the shape of the screen, which is why detect_rotation
  // exists: it cannot tell left from right, or portrait from upside down.
  await t.test("auto guesses from the shape of the screen", () => {
    assert.equal(getEffectiveOrientation("auto", 874, 402), "landscape_right");
    assert.equal(getEffectiveOrientation("auto", 402, 874), "portrait");
  });

  await t.test("a square screen is treated as portrait", () => {
    assert.equal(getEffectiveOrientation("auto", 500, 500), "portrait");
  });
});

test("transformPointToPortrait", async (t) => {
  await t.test("portrait and auto pass the point straight through", () => {
    assert.deepEqual(transformPointToPortrait(10, 20, "portrait", 402, 874), { x: 10, y: 20 });
    assert.deepEqual(transformPointToPortrait(10, 20, "auto", 402, 874), { x: 10, y: 20 });
  });

  await t.test("upside down reflects both axes", () => {
    assert.deepEqual(transformPointToPortrait(10, 20, "upside_down", 402, 874), {
      x: 392,
      y: 854,
    });
  });

  await t.test("the landscapes rotate opposite ways", () => {
    // Same logical point, one quarter turn apart.
    assert.deepEqual(transformPointToPortrait(100, 50, "landscape_right", W, H), {
      x: 50,
      y: 774,
    });
    assert.deepEqual(transformPointToPortrait(100, 50, "landscape_left", W, H), {
      x: 352,
      y: 100,
    });
  });

  // The property that matters more than any single point: a rotation maps the
  // screen onto the screen. If a transform ever sent a corner outside portrait
  // space, taps near that edge would land off-screen or on the wrong control.
  await t.test("every corner of the screen lands on a corner of portrait space", () => {
    const corners = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: 0, y: H },
      { x: W, y: H },
    ];

    for (const orientation of ["landscape_left", "landscape_right"] as const) {
      const mapped = corners.map((c) =>
        transformPointToPortrait(c.x, c.y, orientation, W, H)
      );
      // Portrait space is H wide and W tall — the logical dimensions swapped.
      assert.deepEqual(
        new Set(mapped.map((p) => `${p.x},${p.y}`)),
        new Set([`0,0`, `${H},0`, `0,${W}`, `${H},${W}`]),
        `${orientation} should map the four corners onto the four corners`
      );
    }
  });

  await t.test("the centre of the screen stays the centre", () => {
    for (const orientation of [
      "portrait",
      "upside_down",
      "landscape_left",
      "landscape_right",
    ] as const) {
      const centre = transformPointToPortrait(W / 2, H / 2, orientation, W, H);
      const expected =
        orientation === "portrait" || orientation === "upside_down"
          ? { x: W / 2, y: H / 2 }
          : { x: H / 2, y: W / 2 };
      assert.deepEqual(centre, expected, `${orientation} moved the centre`);
    }
  });

  // detect_rotation reads a label back from the point it computed, so a
  // transform that is not injective would make two orientations answer alike.
  await t.test("distinct points stay distinct", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: W, y: H },
    ];
    for (const orientation of [
      "portrait",
      "upside_down",
      "landscape_left",
      "landscape_right",
    ] as const) {
      const mapped = points.map((p) =>
        JSON.stringify(transformPointToPortrait(p.x, p.y, orientation, W, H))
      );
      assert.equal(new Set(mapped).size, points.length, `${orientation} collapsed two points`);
    }
  });
});

test("candidateOrientations", async (t) => {
  await t.test("offers the two the screen shape cannot tell apart", () => {
    assert.deepEqual(candidateOrientations(true), ["landscape_right", "landscape_left"]);
    assert.deepEqual(candidateOrientations(false), ["portrait", "upside_down"]);
  });

  // detect_rotation returns the first candidate when probing settles nothing,
  // so this order has to agree with what "auto" would have guessed.
  await t.test("the first candidate is what auto would have said", () => {
    const shapes: { isLandscape: boolean; w: number; h: number }[] = [
      { isLandscape: true, w: 874, h: 402 },
      { isLandscape: false, w: 402, h: 874 },
    ];
    for (const { isLandscape, w, h } of shapes) {
      const fallback: Orientation = candidateOrientations(isLandscape)[0];
      assert.equal(fallback, getEffectiveOrientation("auto", w, h));
    }
  });
});

// A rotation maps the screen onto the screen, so `transformPointToPortrait` has
// to be invertible — but nothing in the library ever inverts it, which is
// exactly why a mistake in one direction is invisible. The inverse is written
// out here, from the geometry rather than from the implementation, and the
// round trip is the property that catches a transposed term the corner and
// centre cases above would both survive.
function fromPortrait(
  x: number,
  y: number,
  orientation: Orientation,
  screenW: number,
  screenH: number
): { x: number; y: number } {
  switch (orientation) {
    case "portrait":
    case "auto":
      return { x, y };
    case "landscape_right":
      return { x: screenW - y, y: x };
    case "landscape_left":
      return { x: y, y: screenH - x };
    case "upside_down":
      return { x: screenW - x, y: screenH - y };
  }
}

test("logical → portrait → logical is the identity", async (t) => {
  const shapes = [
    { name: "portrait-shaped screen", w: 402, h: 874 },
    { name: "landscape-shaped screen", w: 874, h: 402 },
  ];
  // Corners, edges and a couple of interior points — the places a sign error
  // hides.
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 200, y: 300 },
    { x: 137, y: 42 },
  ];

  for (const { name, w, h } of shapes) {
    await t.test(name, () => {
      for (const orientation of [...ALL, "auto"] as const) {
        for (const point of [...points, { x: w, y: h }]) {
          const portrait = transformPointToPortrait(point.x, point.y, orientation, w, h);
          assert.deepEqual(
            fromPortrait(portrait.x, portrait.y, orientation, w, h),
            point,
            `${orientation} did not round-trip (${point.x}, ${point.y}) on ${w}x${h}`
          );
        }
      }
    });
  }
});

test("reconcileHint", async (t) => {
  // The table is the whole rule: a describe sees the aspect and nothing else,
  // so it may retire a hint it contradicts and must leave an agreeing one
  // alone. Chirality costs a probe to learn; a read that cannot see it must not
  // be allowed to throw it away.
  const cases: {
    hint: Orientation;
    isLandscape: boolean;
    expected: Orientation;
    why: string;
  }[] = [
    {
      hint: "auto",
      isLandscape: false,
      expected: "auto",
      why: "there is nothing to retire",
    },
    {
      hint: "auto",
      isLandscape: true,
      expected: "auto",
      why: "a shape is not a chirality, so auto stays auto",
    },
    {
      hint: "portrait",
      isLandscape: false,
      expected: "portrait",
      why: "agrees, and portrait is not upside_down",
    },
    {
      hint: "upside_down",
      isLandscape: false,
      expected: "upside_down",
      why: "agrees; the describe cannot tell it from portrait either way",
    },
    {
      hint: "landscape_left",
      isLandscape: true,
      expected: "landscape_left",
      why: "agrees, and the chirality a probe paid for survives",
    },
    {
      hint: "landscape_right",
      isLandscape: true,
      expected: "landscape_right",
      why: "agrees",
    },
    {
      hint: "portrait",
      isLandscape: true,
      expected: "auto",
      why: "something rotated the device behind our back",
    },
    {
      hint: "upside_down",
      isLandscape: true,
      expected: "auto",
      why: "contradicted",
    },
    {
      hint: "landscape_left",
      isLandscape: false,
      expected: "auto",
      why: "contradicted",
    },
    {
      hint: "landscape_right",
      isLandscape: false,
      expected: "auto",
      why: "contradicted",
    },
  ];

  for (const { hint, isLandscape, expected, why } of cases) {
    await t.test(`${hint} + ${isLandscape ? "landscape" : "portrait"} frame → ${expected}`, () => {
      assert.equal(reconcileHint(hint, isLandscape), expected, why);
    });
  }

  // The consequence that matters, spelled out: a retired hint is not a lost
  // one, because "auto" re-derives the aspect from the shape. What is lost is
  // only the half a describe could never have known.
  await t.test("a retired hint still yields the observed aspect", () => {
    const retired = reconcileHint("portrait", true);
    assert.equal(getEffectiveOrientation(retired, 874, 402), "landscape_right");
  });
});

test("HID_ORIENTATION", async (t) => {
  // **The landscapes are crossed on purpose.** Both enums spell the same four
  // words: ours names the *device*, as the Simulator's Device > Orientation
  // menu does, and idb's uses UIKit's *interface* vocabulary, where
  // `UIInterfaceOrientationLandscapeLeft` is `UIDeviceOrientationLandscapeRight`.
  // A name-for-name map was written first and the fixture caught it
  // immediately. This table exists so nobody "fixes" it back.
  const expected: Record<(typeof ALL)[number], OrientationType> = {
    portrait: OrientationType.PORTRAIT,
    upside_down: OrientationType.PORTRAIT_UPSIDE_DOWN,
    landscape_left: OrientationType.LANDSCAPE_RIGHT,
    landscape_right: OrientationType.LANDSCAPE_LEFT,
  };

  for (const orientation of ALL) {
    await t.test(`${orientation} sends ${OrientationType[expected[orientation]]}`, () => {
      assert.equal(HID_ORIENTATION[orientation], expected[orientation]);
    });
  }

  await t.test("the two landscapes are crossed, not name-for-name", () => {
    assert.notEqual(HID_ORIENTATION.landscape_left, OrientationType.LANDSCAPE_LEFT);
    assert.notEqual(HID_ORIENTATION.landscape_right, OrientationType.LANDSCAPE_RIGHT);
    assert.equal(HID_ORIENTATION.landscape_left, OrientationType.LANDSCAPE_RIGHT);
    assert.equal(HID_ORIENTATION.landscape_right, OrientationType.LANDSCAPE_LEFT);
  });

  await t.test("the two portraits are not, which is what makes the crossing a decision", () => {
    assert.equal(HID_ORIENTATION.portrait, OrientationType.PORTRAIT);
    assert.equal(HID_ORIENTATION.upside_down, OrientationType.PORTRAIT_UPSIDE_DOWN);
  });

  await t.test("every orientation maps somewhere, and no two share a value", () => {
    const values = ALL.map((o) => HID_ORIENTATION[o]);
    assert.equal(values.length, ALL.length);
    assert.equal(new Set(values).size, ALL.length);
  });
});
