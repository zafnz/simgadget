/**
 * Fake-client tests for the reading half of `Simulator` (SIMGADGET_PLAN.md
 * step 3): the cure ladder, the typed errors the wedge produces, and the order
 * each lookup tries its paths in.
 *
 * This layer owns **wiring**, not rules. The pruning, matching and
 * remote-frame rules are already proven in `tree.test.mts` at microsecond cost;
 * re-proving them through a method here would be slower, vaguer and would fail
 * for two reasons at once. What only this layer can prove is that the right
 * calls go out, in the right order, and that a failure arrives as the right
 * typed error — so that is all it asserts.
 *
 * No test waits out real time: the recovery cooldown and the post-recovery read
 * delays run on `deps.clock` (`FakeClock`) through `deps.sleep`/`deps.now`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Simulator } from "../src/simulator.ts";
import {
  AccessibilityUnreadableError,
  SimulatorNotAnsweringError,
} from "../src/errors.ts";
import { Backend, Format, SearchableKey } from "../src/idb/client.ts";
import { createFakeDeps, type FakeDeps } from "./fakes/deps.ts";
import {
  FakeIdbClient,
  createFakeIdbClient,
  degenerateTree,
  inOrder,
  markerIn,
  screenTree,
  wedgeError,
  type FakeIdbOptions,
} from "./fakes/idb.ts";

const UDID = "UDID";

/** The `simctl` call the bridge restart makes; the string a test looks for to
 * know whether the guest-side cure was ordered. */
const BRIDGE_RESTART = `run:xcrun simctl spawn ${UDID} launchctl stop com.apple.CoreSimulator.bridge`;

interface Harness {
  sim: Simulator;
  deps: FakeDeps;
  client: FakeIdbClient;
}

function harness(options: FakeIdbOptions = {}, answered = false): Harness {
  const client = createFakeIdbClient(options);
  const deps = createFakeDeps({ client });
  if (answered) deps.recovery.markAnswered(UDID);
  return { sim: new Simulator(UDID, "iPhone", deps), deps, client };
}

const bridgeRestarts = (deps: FakeDeps) =>
  deps.calls.order.filter((entry) => entry === BRIDGE_RESTART).length;

// ---- the cure ladder ------------------------------------------------------

test("describeAll's cure ladder", async (t) => {
  await t.test("stops at the first usable tree, curing nothing", async () => {
    const { sim, deps } = harness({ screen: () => screenTree(390, 844) }, true);

    assert.deepEqual(await sim.screenSize(), { width: 390, height: 844 });
    assert.deepEqual(deps.calls.shutdownCompanion, []);
    assert.equal(bridgeRestarts(deps), 0);
  });

  await t.test("restarts our companion first, and stops there if that cured it", async () => {
    const { sim, deps } = harness(
      { screen: inOrder(degenerateTree(), screenTree(390, 844)) },
      true
    );

    assert.deepEqual(await sim.screenSize(), { width: 390, height: 844 });
    assert.deepEqual(deps.calls.shutdownCompanion, [UDID]);
    // The guest-side cure is the expensive one and was not needed.
    assert.equal(bridgeRestarts(deps), 0);
  });

  await t.test(
    "restarts the guest bridge only after the companion restart failed, in that order",
    async () => {
      const { sim, deps } = harness(
        {
          // read, read-after-companion-restart, the recovery probe, the read
          // after it.
          screen: inOrder(
            degenerateTree(),
            degenerateTree(),
            screenTree(390, 844),
            screenTree(390, 844)
          ),
        },
        true
      );

      assert.deepEqual(await sim.screenSize(), { width: 390, height: 844 });

      const firstRead = deps.calls.order.indexOf(`withClient:${UDID}`);
      const companionRestart = deps.calls.order.indexOf(`shutdownCompanion:${UDID}`);
      const bridgeRestart = deps.calls.order.indexOf(BRIDGE_RESTART);

      assert.ok(firstRead !== -1 && companionRestart !== -1 && bridgeRestart !== -1);
      assert.ok(
        firstRead < companionRestart && companionRestart < bridgeRestart,
        `expected read -> companion restart -> bridge restart, got ${deps.calls.order.join(", ")}`
      );
    }
  );

  await t.test("a never-answered simulator does not get its bridge restarted", async () => {
    // Every read degenerate and every point read empty: the shape of a
    // simulator that is still coming up. The gate is what keeps the boot
    // ladder's own budgeted recovery from being fought over.
    const { sim, deps } = harness({ screen: () => degenerateTree() }, false);

    await assert.rejects(sim.screenSize(), (error: unknown) => {
      assert.ok(error instanceof AccessibilityUnreadableError);
      assert.equal(error.verdict, "booting");
      return true;
    });
    assert.equal(bridgeRestarts(deps), 0);
    // The cheap cure is not gated and was still tried.
    assert.deepEqual(deps.calls.shutdownCompanion, [UDID]);
  });

  await t.test("the same simulator, once it has answered, does get one", async () => {
    const { sim, deps } = harness({ screen: () => degenerateTree() }, true);

    await assert.rejects(sim.screenSize(), (error: unknown) => error instanceof AccessibilityUnreadableError);
    assert.ok(bridgeRestarts(deps) > 0);
  });
});

// ---- an empty read is JSON null -------------------------------------------

test("an empty read is JSON null and never becomes a one-element tree", async () => {
  // If `null` became `[null]` this would read as a usable tree and be returned
  // as a success, with a root that has no frame at all.
  const { sim } = harness({ screen: () => null }, true);

  await assert.rejects(sim.screenSize(), (error: unknown) => error instanceof AccessibilityUnreadableError);
});

// ---- the degenerate-tree verdicts -----------------------------------------

test("a degenerate tree that survives both cures", async (t) => {
  await t.test('verdict "booting" when point reads do not answer either', async () => {
    const { sim } = harness({ screen: () => degenerateTree() }, true);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.ok(error instanceof AccessibilityUnreadableError);
      assert.equal(error.code, "accessibility-unreadable");
      assert.equal(error.verdict, "booting");
      return true;
    });
  });

  await t.test('verdict "unrecoverable" when point reads answer but the tree stays empty', async () => {
    const { sim } = harness(
      {
        screen: () => degenerateTree(),
        point: () => ({ AXLabel: "Anything", frame: { x: 0, y: 0, width: 10, height: 10 } }),
      },
      true
    );

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.ok(error instanceof AccessibilityUnreadableError);
      assert.equal(error.verdict, "unrecoverable");
      return true;
    });
  });

  await t.test("the message names no MCP tool and no URL", async () => {
    const { sim } = harness({ screen: () => degenerateTree() }, true);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.doesNotMatch((error as Error).message, /ui_|https?:\/\//);
      return true;
    });
  });
});

// ---- the wedge, as a typed error ------------------------------------------

test("a wedged bridge", async (t) => {
  await t.test("throws SimulatorNotAnsweringError with recoveryTried: true after a cure that did not help", async () => {
    const { sim, deps } = harness({ screen: () => { throw wedgeError(); } }, true);

    await assert.rejects(sim.screenSize(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotAnsweringError);
      assert.equal(error.code, "not-answering");
      assert.equal(error.recoveryTried, true);
      // idb's own wording never escapes the library (design rule 2).
      assert.doesNotMatch((error as Error).message, /translation object/i);
      return true;
    });
    assert.ok(bridgeRestarts(deps) > 0);
  });

  await t.test("the cooldown suppresses a second attempt and reports recoveryTried: false", async () => {
    const { sim, deps } = harness({ screen: () => { throw wedgeError(); } }, true);
    // An attempt a moment ago, on the fake clock: inside the 60s cooldown.
    deps.recovery.setLastRecoveryAt(UDID, deps.clock.now());

    await assert.rejects(sim.screenSize(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotAnsweringError);
      assert.equal(error.recoveryTried, false);
      return true;
    });
    assert.equal(bridgeRestarts(deps), 0);
  });

  await t.test("past the cooldown, it tries again", async () => {
    const { sim, deps } = harness({ screen: () => { throw wedgeError(); } }, true);
    deps.recovery.setLastRecoveryAt(UDID, deps.clock.now());
    deps.clock.advance(60_000);

    await assert.rejects(sim.screenSize(), (error: unknown) => error instanceof SimulatorNotAnsweringError);
    assert.ok(bridgeRestarts(deps) > 0);
  });

  await t.test("a never-answered simulator is reported, never restarted", async () => {
    const { sim, deps } = harness({ screen: () => { throw wedgeError(); } }, false);

    await assert.rejects(sim.screenSize(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotAnsweringError);
      assert.equal(error.recoveryTried, false);
      return true;
    });
    assert.equal(bridgeRestarts(deps), 0);
  });

  await t.test(
    "a cure that works is followed by more than one attempt at the caller's read",
    async () => {
      // Measured on a real restarted bridge: the recovery probe succeeded, the
      // read straight after it failed with the same wedge error, and the next
      // call 21ms later worked. One retry would hand back a failure the cure
      // had already fixed.
      const { sim, deps } = harness(
        {
          screen: inOrder(
            wedgeError(), // the caller's read
            screenTree(390, 844), // the recovery probe: the bridge is back
            wedgeError(), // ...but not reliably, yet
            screenTree(390, 844) // the retry that works
          ),
        },
        true
      );

      assert.deepEqual(await sim.screenSize(), { width: 390, height: 844 });
      assert.equal(bridgeRestarts(deps), 1);
    }
  );

  await t.test("a non-wedge failure during the retries is returned immediately", async () => {
    const boom = new Error("companion channel closed");
    const { sim, client } = harness(
      {
        screen: inOrder(wedgeError(), screenTree(390, 844), boom, screenTree(390, 844)),
      },
      true
    );

    await assert.rejects(sim.screenSize(), (error: unknown) => error === boom);
    // Four reads: the caller's, the probe, the retry that failed, and no more.
    assert.equal(client.calls.filter((c) => c.kind === "screen").length, 3);
  });
});

// ---- describeScreen -------------------------------------------------------

test("describeScreen", async (t) => {
  await t.test("asks AXBridge for the rich key set, and reports the root's rectangle", async () => {
    const { sim, client } = harness(
      {
        screen: (backend) =>
          backend === Backend.AXBRIDGE
            ? screenTree(390, 844, [{ AXLabel: "Toolbar Button", type: "Button" }])
            : screenTree(390, 844),
      },
      true
    );

    const read = await sim.describeScreen();

    assert.deepEqual(read.screen, { width: 390, height: 844 });
    // The toolbar control only the AXBridge backend can see survived the prune.
    assert.deepEqual(read.elements[0]?.children, [
      { AXLabel: "Toolbar Button", type: "Button" },
    ]);
    const first = client.calls.find((c) => c.kind === "screen");
    assert.equal(first?.backend, Backend.AXBRIDGE);
    assert.deepEqual(first?.keys, ["AXLabel", "frame", "AXValue", "AXUniqueId", "type", "enabled"]);
  });

  await t.test("falls back to the default backend when AXBridge cannot start", async () => {
    // A companion older than the pinned one cannot start AXBridge; an
    // incomplete tree beats no tree.
    const { sim, client } = harness(
      {
        screen: (backend) => {
          if (backend === Backend.AXBRIDGE) throw new Error("axbridge unavailable");
          return screenTree(390, 844);
        },
      },
      true
    );

    const read = await sim.describeScreen();

    assert.deepEqual(read.screen, { width: 390, height: 844 });
    const backends = client.calls.filter((c) => c.kind === "screen").map((c) => c.backend);
    assert.deepEqual(backends, [Backend.AXBRIDGE, undefined]);
  });
});

// ---- findByLabel / findByIdentifier ---------------------------------------

const PLAIN_BUTTON = {
  AXLabel: "Plain Button",
  AXUniqueId: "PlainButton",
  type: "Button",
  frame: { x: 10, y: 20, width: 100, height: 40 },
};

test("findByLabel's ladder", async (t) => {
  await t.test("stops at the marker query when it hits", async () => {
    const { sim, client } = harness({ marker: markerIn([PLAIN_BUTTON]) }, true);

    assert.deepEqual(await sim.findByLabel("Plain Button"), PLAIN_BUTTON);
    assert.deepEqual(
      client.calls.map((c) => c.kind),
      ["marker"]
    );
    assert.equal(client.calls[0].matchKey, SearchableKey.LABEL);
  });

  await t.test("tries the identifier next, and only then the tree", async () => {
    const { sim, client } = harness(
      {
        // Nothing matches by label; the identifier query answers.
        marker: (value, matchKey) =>
          matchKey === SearchableKey.UNIQUE_ID ? markerIn([PLAIN_BUTTON])(value, matchKey) : null,
      },
      true
    );

    assert.deepEqual(await sim.findByLabel("PlainButton"), PLAIN_BUTTON);
    assert.deepEqual(
      client.calls.map((c) => [c.kind, c.matchKey]),
      [
        ["marker", SearchableKey.LABEL],
        ["marker", SearchableKey.UNIQUE_ID],
      ]
    );
  });

  await t.test("falls through to the AXBridge tree walk when both markers miss", async () => {
    const { sim, client } = harness(
      { screen: () => screenTree(390, 844, [{ AXLabel: "Toolbar Switch", type: "Switch" }]) },
      true
    );

    assert.deepEqual(await sim.findByLabel("Toolbar Switch"), {
      AXLabel: "Toolbar Switch",
      type: "Switch",
    });
    assert.deepEqual(
      client.calls.map((c) => [c.kind, c.matchKey]),
      [
        ["marker", SearchableKey.LABEL],
        ["marker", SearchableKey.UNIQUE_ID],
        ["screen", undefined],
      ]
    );
  });

  await t.test('"found no element" is absence, not a failure', async () => {
    const { sim } = harness({ screen: () => screenTree(390, 844) }, true);

    assert.equal(await sim.findByLabel("Nothing Like This"), null);
    assert.equal(await sim.findByIdentifier("NoSuchId"), null);
  });

  await t.test("a screen that cannot be read is still 'not found', not an error", async () => {
    // The tree fallback is best-effort: an error about a backend the caller
    // never asked for is a worse answer than the honest "no".
    const { sim } = harness({ screen: () => { throw wedgeError(); } }, true);

    assert.equal(await sim.findByLabel("Anything"), null);
  });
});

test("findByIdentifier asks by identifier and canonicalises the hit", async () => {
  const { sim, client } = harness(
    {
      marker: markerIn([{ ...PLAIN_BUTTON, children: [{ AXLabel: "a kilobyte of descendants" }] }]),
    },
    true
  );

  // The subtree a match arrives with is dropped: a match inside an app drags
  // ten kilobytes of descendants along with it otherwise.
  assert.deepEqual(await sim.findByIdentifier("PlainButton"), PLAIN_BUTTON);
  assert.deepEqual(
    client.calls.map((c) => c.matchKey),
    [SearchableKey.UNIQUE_ID]
  );
});

// ---- describePoint --------------------------------------------------------

test("describePoint", async (t) => {
  await t.test("uses a LEGACY point read with the point key set", async () => {
    const { sim, client } = harness({ point: () => PLAIN_BUTTON }, true);

    await sim.describePoint(60, 40);

    const call = client.calls.find((c) => c.kind === "point");
    assert.deepEqual(call?.point, { x: 60, y: 40 });
    // NESTED would return the element's whole subtree instead of the single
    // element callers expect.
    assert.equal(call?.format, Format.LEGACY);
    assert.ok(call?.keys?.includes("subrole"));
  });

  await t.test("an empty point is null, and the bridge is left alone", async () => {
    // idb raises the wedge error for a point with nothing on it too. The
    // disambiguation — ask for the whole screen, which has no such ambiguity —
    // is what stops a caller tapping an empty patch from having their
    // simulator's bridge restarted underneath them.
    const { sim, deps } = harness({ screen: () => screenTree(390, 844) }, true);

    assert.equal(await sim.describePoint(200, 400), null);
    assert.equal(bridgeRestarts(deps), 0);
  });

  await t.test("a genuine wedge still throws", async () => {
    const { sim } = harness({ screen: () => { throw wedgeError(); } }, true);

    await assert.rejects(
      sim.describePoint(200, 400),
      (error: unknown) => error instanceof SimulatorNotAnsweringError
    );
  });

  await t.test("reconciles the point backend's vocabulary with the tree's", async () => {
    const { sim } = harness(
      {
        point: () => ({
          AXLabel: "Search",
          type: "TextField",
          subrole: "AXSearchField",
          frame: { x: 0, y: 0, width: 100, height: 40 },
        }),
      },
      true
    );

    const element = await sim.describePoint(50, 20);

    assert.equal(element?.type, "SearchField");
    // `subrole` is evidence, not output.
    assert.equal("subrole" in element!, false);
  });

  await t.test("replaces a remote-hosted frame, never the identity", async () => {
    const hosted = {
      AXLabel: "Autofill",
      AXUniqueId: "AutofillButton",
      type: "Button",
      // The point read's own answer: right element, frame measured from the
      // hosting window rather than the screen.
      frame: { x: 20, y: 24, width: 200, height: 44 },
    };
    const { sim } = harness(
      {
        point: () => ({ ...hosted }),
        screen: () =>
          screenTree(390, 844, [
            { ...hosted, frame: { x: 20, y: 500, width: 200, height: 44 } },
          ]),
      },
      true
    );

    const element = await sim.describePoint(120, 522);

    assert.deepEqual(element, {
      ...hosted,
      frame: { x: 20, y: 500, width: 200, height: 44 },
    });
  });

  await t.test("a screen read that fails leaves the point read's own answer standing", async () => {
    const hosted = {
      AXLabel: "Autofill",
      type: "Button",
      frame: { x: 20, y: 24, width: 200, height: 44 },
    };
    const { sim } = harness(
      { point: () => ({ ...hosted }), screen: () => { throw new Error("boom"); } },
      true
    );

    assert.deepEqual(await sim.describePoint(120, 522), hosted);
  });
});

// ---- screenSize -----------------------------------------------------------

test("screenSize is the cheap unpruned read", async () => {
  const { sim, client } = harness(
    { screen: () => screenTree(844, 390, [{ AXLabel: "Something", type: "Button" }]) },
    true
  );

  assert.deepEqual(await sim.screenSize(), { width: 844, height: 390 });
  const call = client.calls[0];
  // No AXBridge, no key restriction: this is the ~13ms read, not the ~350ms one.
  assert.equal(call.backend, undefined);
  assert.equal(call.keys, undefined);
});
