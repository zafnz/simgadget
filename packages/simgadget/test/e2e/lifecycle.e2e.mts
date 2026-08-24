/**
 * The handle's whole life, against a real simulator: created, booted, listed,
 * adopted by a second handle, deleted, and dead afterwards.
 *
 * This is the half of the e2e suite that never launches an app. It exists
 * because everything the unit tests know about `createSimulator`,
 * `attachSimulator` and `delete()` they know from a fake that answers instantly
 * and always agrees with itself. Only a real `simctl` can say whether the boot
 * ladder's five measured constants are still enough, whether a udid this
 * library created is a udid `listSimulators()` reports, and whether a deleted
 * simulator produces `SimulatorNotFoundError` rather than a gRPC timeout thirty
 * seconds later — the spec's "a clear error, never a gRPC timeout".
 *
 * Its own process, and its own simulator. `node --test` gives each file a
 * process, and a booted simulator cannot cross that boundary; two boots (~80s)
 * was weighed and approved (SIMGADGET_PLAN.md, "Open items" 3) against a
 * shared-udid runner script.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  attachSimulator,
  createSimulator,
  listSimulators,
  SimulatorNotFoundError,
  type Simulator,
} from "../../src/index.ts";
import { deleteQuietly, simctlDevices, unavailable, useCachedCompanion } from "./support.mts";

useCachedCompanion();

const SKIP = unavailable();

/** Named so `xcrun simctl list devices | grep -i simgadget` finds anything this
 * suite leaked. Nothing else on the machine answers to it. */
const DEVICE_NAME = "simgadget-e2e-lifecycle";

/** A syntactically valid udid that no simulator has. Used to check that an
 * attach to nothing fails the same way a stale handle does. */
const ABSENT_UDID = "DEADBEEF-0000-0000-0000-000000000000";

describe("simgadget lifecycle against a real simulator", { skip: SKIP }, () => {
  let sim: Simulator;
  let udid: string;
  /** The second handle on the same simulator — an *attach*, so it never owned
   * the device and must never be the thing that deletes it. */
  let attached: Simulator;
  let deleted = false;

  before(async () => {
    sim = await createSimulator({ deviceType: "iPhone", name: DEVICE_NAME });
    udid = sim.udid;
  });

  after(async () => {
    if (!udid) return;
    if (!deleted) {
      try {
        await sim.delete();
        deleted = true;
      } catch {
        // Fall through to the backstop: a test that failed midway can leave a
        // handle that refuses to do anything, and the simulator still has to go.
      }
    }
    await deleteQuietly(udid);
  });

  it("creates a simulator that is booted and answering", () => {
    // `ready` is the whole point of the boot ladder: `createSimulator` does not
    // return until the simulator has served a real accessibility read, so a
    // caller's next call needs no polling of its own. It is also the one thing
    // `createSimulator` will not throw over — the simulator exists either way,
    // and throwing would discard the handle and the udid with it.
    assert.equal(sim.lastBoot?.ready, true, "the boot ladder gave up before the simulator answered");
    assert.ok(sim.lastBoot!.waitedMs > 0);
    assert.match(udid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    assert.equal(sim.name, DEVICE_NAME);
  });

  it("reports its simctl state", async () => {
    assert.equal(await sim.state(), "Booted");
  });

  it("appears in listSimulators() with the device type it was asked for", async () => {
    const listed = (await listSimulators()).find((s) => s.udid === udid);

    assert.ok(listed, "listSimulators() did not report a simulator this library just created");
    assert.equal(listed.name, DEVICE_NAME);
    assert.equal(listed.state, "Booted");
    // `deviceType: "iPhone"` is a substring match against simctl's list, first
    // hit wins, and simctl lists newest first — so this pins that the keyword
    // reached simctl at all, not which iPhone came back.
    assert.match(listed.deviceTypeIdentifier, /SimDeviceType\.iPhone/);
    assert.match(listed.runtimeIdentifier, /SimRuntime\.iOS-/);

    // The handle knows the same device type, and knows it by *name* as well —
    // which is the half `listSimulators()` cannot answer and the MCP's
    // start_simulator reply is built from. Against the real simctl, so this
    // also pins that what we kept is what simctl actually said.
    assert.equal(sim.deviceType?.identifier, listed.deviceTypeIdentifier);
    assert.match(sim.deviceType!.name, /iPhone/);
  });

  it("gives a second, working handle for the same udid", async () => {
    attached = await attachSimulator(udid);

    assert.equal(attached.udid, udid);
    assert.equal(attached.name, DEVICE_NAME);
    // An attach does not boot and does not probe, so `lastBoot` is undefined —
    // the handle has not booted anything and must not claim to have.
    assert.equal(attached.lastBoot, undefined);

    // "Working" means it drives the simulator, not merely that it constructed:
    // the same screen, read through its own companion connection.
    assert.deepEqual(await attached.screenSize(), await sim.screenSize());
  });

  it("refuses to attach to a udid that does not exist", async () => {
    await assert.rejects(attachSimulator(ABSENT_UDID), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError);
      assert.equal(error.code, "simulator-not-found");
      assert.equal(error.udid, ABSENT_UDID);
      return true;
    });
  });

  it("deletes the simulator", async () => {
    await sim.delete();
    deleted = true;
  });

  it("makes every method on the deleted handle throw SimulatorNotFoundError", async () => {
    // Every public method, driven from one table, because the guard is
    // per-method: one that forgets `assertNotDeleted` would otherwise reach
    // simctl or the companion for a udid that no longer exists, and the answer
    // to that is a thirty-second gRPC timeout rather than an error.
    const calls: [string, () => Promise<unknown>][] = [
      ["state", () => sim.state()],
      ["boot", () => sim.boot()],
      ["showWindow", () => sim.showWindow()],
      ["waitReady", () => sim.waitReady()],
      ["shutdown", () => sim.shutdown()],
      ["delete", () => sim.delete()],
      ["installApp", () => sim.installApp("/nonexistent.app")],
      ["launchApp", () => sim.launchApp("com.example.nope")],
      ["describeScreen", () => sim.describeScreen()],
      ["screenSize", () => sim.screenSize()],
      ["findByLabel", () => sim.findByLabel("anything")],
      ["findByIdentifier", () => sim.findByIdentifier("anything")],
      ["describePoint", () => sim.describePoint(10, 10)],
      ["rotate", () => sim.rotate("portrait")],
      ["detectOrientation", () => sim.detectOrientation()],
      ["tap", () => sim.tap({ x: 10, y: 10 })],
      ["typeText", () => sim.typeText("x")],
      ["swipe", () => sim.swipe({ x: 10, y: 10 }, { x: 20, y: 20 })],
      ["pressButton", () => sim.pressButton("home")],
      ["screenshot", () => sim.screenshot()],
      ["startRecording", () => sim.startRecording("/tmp/simgadget-e2e-never.mp4")],
      ["stopRecording", () => sim.stopRecording()],
      ["restartBridge", () => sim.restartBridge()],
      ["releaseCompanion", () => sim.releaseCompanion()],
    ];

    for (const [name, call] of calls) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(
          error instanceof SimulatorNotFoundError,
          `${name}() threw ${(error as Error)?.constructor?.name} rather than SimulatorNotFoundError`
        );
        assert.equal(error.udid, udid, `${name}()'s error named the wrong udid`);
        return true;
      });
    }
  });

  it("turns an externally deleted simulator into the same error on the other handle", async () => {
    // The attached handle never called `delete()`, so its staleness flag is
    // clear and nothing local knows the device has gone. This is the *other*
    // half of the rule: a handle whose simulator was deleted underneath it says
    // so in the same words as one that deleted it itself.
    //
    // Both routes out of the handle are checked, because they fail in
    // different places and only one of them used to be mapped. `state()` goes
    // through simctl, which answers "Invalid device". A read spawns a
    // companion, which cannot resolve a target that no longer exists and exits
    // — and that came back as `companion-start-failed`, which is true about the
    // companion and says nothing about why. Whichever method a caller happens
    // to reach for, the answer has to be the same one.
    const stale: [string, () => Promise<unknown>][] = [
      ["state", () => attached.state()],
      ["describeScreen", () => attached.describeScreen()],
      // The one that could answer instead of throwing: `findByLabel`'s tree
      // fallback returns `null` when the screen cannot be read, which is the
      // right answer about a label and the wrong one about a simulator.
      ["findByLabel", () => attached.findByLabel("anything")],
    ];

    for (const [name, call] of stale) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(
          error instanceof SimulatorNotFoundError,
          `${name}() threw ${(error as Error)?.constructor?.name} rather than SimulatorNotFoundError`
        );
        assert.equal(error.udid, udid, `${name}()'s error named the wrong udid`);
        return true;
      });
    }
  });

  it("is gone as far as simctl is concerned", async () => {
    const devices = await simctlDevices();
    assert.equal(
      devices.find((d) => d.udid === udid),
      undefined,
      "delete() reported success but simctl still lists the simulator"
    );
  });
});
