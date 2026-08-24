/**
 * Fake-client tests for the orientation half of `Simulator`
 * (SIMGADGET_PLAN.md step 4): `rotate`, `detectOrientation`, and the three
 * lifetimes of state the spec's coordinate rules ask for — logical
 * dimensions that any read refreshes and a rotation invalidates, portrait point
 * dimensions cached forever, and a chirality hint only a probe or a rotation
 * may write.
 *
 * This layer owns **wiring**. The arithmetic — the crossed device→HID map, the
 * portrait transform and its inverse, `reconcileHint`'s table — is proven in
 * `orientation.test.mts` at microsecond cost and is not re-proven through a
 * method here. What only this layer can show is that the calls go out in the
 * right order (the settle *before* the read, or the tree still reports the
 * geometry we just left), that a declined rotation is reported rather than
 * thrown, and that each piece of state is refreshed by exactly the calls the
 * rules say refresh it.
 *
 * No test waits out the 1.5s settle: it runs on `deps.clock` through
 * `deps.sleep`, and a test that took a second and a half to prove a sequence
 * would be paying real time for a fact a fake clock establishes for nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Simulator } from "../src/simulator.ts";
import { OrientationType } from "../src/idb/client.ts";
import { createFakeDeps, type FakeDeps } from "./fakes/deps.ts";
import {
  FakeIdbClient,
  createFakeIdbClient,
  screenTree,
  targetDescription,
  type FakeIdbOptions,
} from "./fakes/idb.ts";

const UDID = "UDID";

/** The settle `rotate` waits out, as `deps.calls.sleep` records it. */
const SETTLE_MS = 1_500;

interface Harness {
  sim: Simulator;
  deps: FakeDeps;
  client: FakeIdbClient;
}

function harness(options: FakeIdbOptions = {}): Harness {
  const client = createFakeIdbClient(options);
  const deps = createFakeDeps({ client });
  // Answered before: every test here is about a simulator that is up, not one
  // that is booting, and an unanswered udid would divert the reads into the
  // recovery ladder that `reading.test.mts` already owns.
  deps.recovery.markAnswered(UDID);
  return { sim: new Simulator(UDID, "iPhone", deps), deps, client };
}

const screenReads = (client: FakeIdbClient) =>
  client.calls.filter((call) => call.kind === "screen").length;

const pointReads = (client: FakeIdbClient) =>
  client.calls.filter((call) => call.kind === "point").map((call) => call.point);

// A landscape screen with one uniquely-labelled control to probe with, and the
// two portrait-space positions its centre maps to under the two candidates. The
// numbers are worked out from the geometry, not read off the implementation:
// centre (730, 40) on an 874x402 screen goes to (40, 144) under landscape_right
// and (362, 730) under landscape_left.
const LANDSCAPE_W = 874;
const LANDSCAPE_H = 402;
const PROBE = {
  AXLabel: "Done",
  type: "Button",
  frame: { x: 700, y: 20, width: 60, height: 40 },
};
const UNDER_LANDSCAPE_RIGHT = { x: 40, y: 144 };
const UNDER_LANDSCAPE_LEFT = { x: 362, y: 730 };

// ---- rotate ---------------------------------------------------------------

test("Simulator.rotate", async (t) => {
  await t.test("sends the crossed HID orientation for the device name", async () => {
    const { sim, client } = harness({ screen: () => screenTree(390, 844) });

    await sim.rotate("landscape_left");

    // Device left is interface right. `orientation.test.mts` owns the whole
    // table; this asserts the method actually goes through it.
    assert.deepEqual(client.orientations, [OrientationType.LANDSCAPE_RIGHT]);
  });

  await t.test("settles, through deps.sleep, before reading anything back", async () => {
    const { sim, deps, client } = harness({ screen: () => screenTree(390, 844) });

    await sim.rotate("portrait");

    // The tree reports the old geometry until the animation finishes, so a read
    // before the settle answers with the orientation we just left.
    const sequence = deps.calls.order.filter(
      (entry) => entry.startsWith("client:") || entry.startsWith("sleep:")
    );
    assert.deepEqual(sequence.slice(0, 3), [
      "client:setOrientation",
      `sleep:${SETTLE_MS}`,
      "client:accessibilityInfo",
    ]);
    // Through the seam, so no test — and no host with its own scheduler — waits
    // 1.5s of wall clock for it.
    assert.deepEqual(deps.calls.sleep, [SETTLE_MS]);
    assert.equal(deps.clock.now(), SETTLE_MS);
    assert.ok(screenReads(client) > 0, "nothing was read back at all");
  });

  await t.test("reports what the interface adopted when it declines the request", async () => {
    // No Face ID iPhone ever adopts upside-down portrait. The screen after the
    // settle is the one it was already in, and reporting the *request* back as
    // though it had been obeyed is what would leave every later coordinate
    // wrong.
    const { sim } = harness({ screen: () => screenTree(390, 844) });

    assert.deepEqual(await sim.rotate("upside_down"), {
      requested: "upside_down",
      adopted: "portrait",
    });
  });

  await t.test("a declined orientation is an answer, not an error", async () => {
    const { sim } = harness({ screen: () => screenTree(390, 844) });

    // Deliberately not `assert.rejects`: the whole design rule is that the
    // disagreement is data the caller acts on.
    const result = await sim.rotate("upside_down");
    assert.notEqual(result.adopted, result.requested);
  });

  await t.test("probing settles which landscape was adopted", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(LANDSCAPE_W, LANDSCAPE_H, [PROBE]),
      // The control answers at the position landscape_left predicts and nowhere
      // else, which is the only evidence that distinguishes the two: their
      // geometry is identical.
      point: (x, y) =>
        x === UNDER_LANDSCAPE_LEFT.x && y === UNDER_LANDSCAPE_LEFT.y ? PROBE : null,
    });

    const result = await sim.rotate("landscape_left");

    assert.deepEqual(result, { requested: "landscape_left", adopted: "landscape_left" });
    // Both candidates were asked, in the order `candidateOrientations` gives
    // them — an element answering at both is ambiguous and must be discarded,
    // which is only knowable by asking both.
    assert.deepEqual(pointReads(client), [UNDER_LANDSCAPE_RIGHT, UNDER_LANDSCAPE_LEFT]);
  });

  await t.test("falls back to the shape of the screen when nothing settles it", async () => {
    // A screen with no uniquely-labelled control to probe: the aspect is all
    // that is knowable, and the commoner of the two candidates is the answer.
    const { sim, client } = harness({
      screen: () =>
        screenTree(LANDSCAPE_W, LANDSCAPE_H, [
          { ...PROBE },
          { ...PROBE, frame: { x: 100, y: 20, width: 60, height: 40 } },
        ]),
    });

    const result = await sim.rotate("landscape_left");

    assert.equal(result.adopted, "landscape_right");
    // A repeated label can answer yes to both probes, so it is never worth a
    // point read.
    assert.deepEqual(pointReads(client), []);
  });

  await t.test("an orientation no companion has an event for sends nothing", async () => {
    // `Orientation` is an open union, so this type-checks and has to be handled
    // at runtime.
    const { sim, deps, client } = harness({ screen: () => screenTree(390, 844) });

    await assert.rejects(sim.rotate("sideways"), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match((error as Error).message, /sideways/);
      return true;
    });

    assert.deepEqual(client.orientations, []);
    assert.deepEqual(deps.calls.sleep, [], "it settled for a rotation it never sent");
  });
});

// ---- detectOrientation ----------------------------------------------------

test("Simulator.detectOrientation", async (t) => {
  await t.test("probes, and the answer steers the next coordinate transform", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(LANDSCAPE_W, LANDSCAPE_H, [PROBE]),
      point: (x, y) =>
        x === UNDER_LANDSCAPE_LEFT.x && y === UNDER_LANDSCAPE_LEFT.y ? PROBE : null,
    });

    assert.equal(await sim.detectOrientation(), "landscape_left");

    // The hint is not an ornament: a later read at the control's logical centre
    // has to arrive at the companion in the same portrait position the probe
    // just proved.
    await sim.describePoint(730, 40);
    assert.deepEqual(pointReads(client).at(-1), UNDER_LANDSCAPE_LEFT);
  });

  await t.test("degrades to portrait rather than failing when the screen cannot be read", async () => {
    // Detection runs on the way to something else — a rotate the caller asked
    // for — so an error about the probe would replace an answer that is merely
    // imprecise with no answer at all.
    const { sim } = harness({
      screen: () => {
        throw new Error("boom");
      },
    });

    assert.equal(await sim.detectOrientation(), "portrait");
  });
});

// ---- the coordinate rules' three lifetimes -------------------------------

test("cached logical dimensions", async (t) => {
  await t.test("an ordinary read refreshes them, and no second read is paid for", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844),
      point: () => ({ AXLabel: "Thing", frame: { x: 0, y: 0, width: 390, height: 100 } }),
    });

    await sim.describeScreen();
    const after = screenReads(client);

    await sim.describePoint(100, 50);

    assert.equal(
      screenReads(client),
      after,
      "the transform re-read a screen it had already been told the size of"
    );
  });

  await t.test("rotate invalidates them", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844),
      point: () => ({ AXLabel: "Thing", frame: { x: 0, y: 0, width: 390, height: 100 } }),
    });

    await sim.describeScreen();
    await sim.rotate("landscape_left");
    const afterRotate = screenReads(client);

    await sim.describePoint(100, 50);

    // A rotation swaps the logical dimensions; transforming with the pair from
    // before it would land every coordinate in the space the screen just left.
    assert.equal(screenReads(client), afterRotate + 1);
  });

  await t.test("detectOrientation invalidates them", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(390, 844),
      point: () => ({ AXLabel: "Thing", frame: { x: 0, y: 0, width: 390, height: 100 } }),
    });

    await sim.describeScreen();
    await sim.detectOrientation();
    const afterDetect = screenReads(client);

    await sim.describePoint(100, 50);

    assert.equal(screenReads(client), afterDetect + 1);
  });
});

/**
 * Reaches `portraitPointDimensions`, which is `protected` because the spec's
 * handle API does not include it — step 6's `screenshot({resizeTo: "points"})`
 * is its consumer. Subclassing is how a test gets at a seam that has no public
 * caller yet, and is cheaper than deferring the state's own tests to step 6.
 */
class PointDimensions extends Simulator {
  points(): Promise<{ width: number; height: number } | null> {
    return this.portraitPointDimensions();
  }
}

test("portrait point dimensions", async (t) => {
  await t.test("come from describe, in points, without an accessibility read", async () => {
    const client = createFakeIdbClient({ describe: () => targetDescription(390, 844) });
    const deps = createFakeDeps({ client });
    const sim = new PointDimensions(UDID, "iPhone", deps);

    assert.deepEqual(await sim.points(), { width: 390, height: 844 });
    // The reason this is new code rather than a port: `describe` answers from
    // target metadata, so the dimensions exist before the bridge does. The
    // accessibility root frame they used to come from never could.
    assert.equal(client.calls.length, 0);
  });

  await t.test("are fetched once and kept, because the device type cannot change", async () => {
    const client = createFakeIdbClient({ describe: () => targetDescription(390, 844) });
    const deps = createFakeDeps({ client });
    const sim = new PointDimensions(UDID, "iPhone", deps);

    const first = await sim.points();
    const second = await sim.points();

    assert.deepEqual(second, first);
    assert.equal(client.describes, 1);
  });

  await t.test("are null, not an error, when the companion omits them", async () => {
    const client = createFakeIdbClient({ describe: () => ({}) });
    const deps = createFakeDeps({ client });
    const sim = new PointDimensions(UDID, "iPhone", deps);

    assert.equal(await sim.points(), null);
  });
});

test("the orientation hint", async (t) => {
  await t.test("survives a read that agrees with it", async () => {
    const { sim, client } = harness({
      screen: () => screenTree(LANDSCAPE_W, LANDSCAPE_H, [PROBE]),
      point: (x, y) =>
        x === UNDER_LANDSCAPE_LEFT.x && y === UNDER_LANDSCAPE_LEFT.y ? PROBE : null,
    });

    await sim.detectOrientation();
    // A landscape read cannot tell the two landscapes apart, so it must not be
    // allowed to discard the chirality the probe above paid for.
    await sim.describeScreen();

    await sim.describePoint(730, 40);
    assert.deepEqual(pointReads(client).at(-1), UNDER_LANDSCAPE_LEFT);
  });

  await t.test("is retired by a read that contradicts its aspect", async () => {
    let landscape = true;
    const { sim, client } = harness({
      screen: () =>
        landscape
          ? screenTree(LANDSCAPE_W, LANDSCAPE_H, [PROBE])
          : screenTree(LANDSCAPE_H, LANDSCAPE_W),
      point: (x, y) =>
        x === UNDER_LANDSCAPE_LEFT.x && y === UNDER_LANDSCAPE_LEFT.y ? PROBE : null,
    });

    await sim.detectOrientation();

    // Something rotated the device back behind our back. The next read sees a
    // portrait-shaped screen, which proves the landscape hint stale even though
    // it cannot say which portrait.
    landscape = false;
    await sim.describeScreen();
    await sim.describePoint(100, 50);

    // Retired to "auto", so the shape of the screen decides: portrait, which
    // passes coordinates straight through.
    assert.deepEqual(pointReads(client).at(-1), { x: 100, y: 50 });
  });
});
