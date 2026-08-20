import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Simulator } from "../src/simulator.ts";
import {
  BOOTSTATUS_CAP_MS,
  BOOT_SETTLE_MS,
  BRIDGE_RECOVERY_MIN_POLL_MS,
  RECOVERY_TAIL_MS,
} from "../src/lifecycle.ts";
import { CompanionStartError, SimGadgetError, SimulatorNotFoundError } from "../src/errors.ts";
import { createFakeDeps } from "./fakes/deps.ts";

/** This test file itself -- an absolute path guaranteed to exist, so
 * `installApp`'s existsSync check can be exercised without a fixture. Its
 * contents are never read; installApp only checks that something is there. */
const thisFile = fileURLToPath(import.meta.url);

/** A root-frame accessibility read the way idb answers it. */
function treeWithFrame(width: number, height: number) {
  return [{ frame: { x: 0, y: 0, width, height } }];
}

/** Wide enough that `shouldAttemptBootRecovery` fires and the wait still
 * times out honestly -- same derivation lifecycle.test.mts uses. */
const TIMEOUT_BUDGET_MS =
  BOOTSTATUS_CAP_MS + BOOT_SETTLE_MS + BRIDGE_RECOVERY_MIN_POLL_MS + RECOVERY_TAIL_MS;

// ---- state() ----------------------------------------------------------------

test("Simulator.state()", async (t) => {
  await t.test("reports simctl's state for this udid", async () => {
    const deps = createFakeDeps({
      run: () => ({
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              { udid: "UDID", name: "iPhone 16 Pro", state: "Booted", deviceTypeIdentifier: "x" },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const sim = new Simulator("UDID", "iPhone 16 Pro", deps);

    assert.equal(await sim.state(), "Booted");
  });

  await t.test("throws SimulatorNotFoundError when simctl no longer lists it", async () => {
    const deps = createFakeDeps({ run: () => ({ stdout: JSON.stringify({ devices: {} }), stderr: "" }) });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(
      sim.state(),
      (error: unknown) => error instanceof SimulatorNotFoundError
    );
  });
});

// ---- showWindow() -------------------------------------------------------

test("Simulator.showWindow()", async (t) => {
  await t.test("opens Simulator.app and does nothing else", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.showWindow();

    assert.deepEqual(deps.calls.run, [{ cmd: "open", args: ["-a", "Simulator.app"] }]);
    // The whole reason this exists rather than the MCP's resume path calling
    // `boot()`: no simctl, no companion, and above all no driveability wait,
    // whose settle is unconditional and costs eight seconds on a simulator
    // that is already up and answering.
    assert.deepEqual(deps.calls.withClient, []);
  });

  await t.test("is stale after delete(), like every other method", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);
    await sim.delete();
    deps.calls.run.length = 0;

    await assert.rejects(sim.showWindow(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError, `got ${(error as Error).name}`);
      return true;
    });
    assert.deepEqual(deps.calls.run, [], "refused before running anything");
  });
});

// ---- boot() -------------------------------------------------------------

test("Simulator.boot()", async (t) => {
  await t.test("boots, opens Simulator.app, and waits until driveable", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    const result = await sim.boot();

    assert.equal(result.ready, true);
    assert.equal(sim.lastBoot?.ready, true);
    assert.ok(deps.calls.run.some((c) => c.cmd === "xcrun" && c.args.includes("boot")));
    assert.ok(deps.calls.run.some((c) => c.cmd === "open" && c.args.includes("Simulator.app")));
  });

  await t.test("swallows 'already booted' and still performs the wait", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "boot") {
          throw new Error(
            "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, " +
              "code=164): Unable to boot device in current state: Booted"
          );
        }
        return { stdout: "", stderr: "" };
      },
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    const result = await sim.boot();

    assert.equal(result.ready, true);
    // The wait still ran -- a probe reached the fake companion -- and the
    // window still opened, despite the swallowed boot failure.
    assert.ok(deps.calls.withClient.includes("UDID"));
    assert.ok(deps.calls.run.some((c) => c.cmd === "open"));
  });

  await t.test("does not swallow an unrelated simctl boot failure", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "boot") throw new Error("Invalid device or device pair: UDID");
        return { stdout: "", stderr: "" };
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(
      sim.boot(),
      (error: unknown) => error instanceof SimulatorNotFoundError
    );
    // Never got as far as opening the window or waiting.
    assert.ok(!deps.calls.run.some((c) => c.cmd === "open"));
  });

  await t.test("times out honestly -- ready:false, never throws", async () => {
    const deps = createFakeDeps({
      client: {
        accessibilityInfo: async () => {
          throw new Error("fake: simulator not answering yet");
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    const result = await sim.boot({ budgetMs: TIMEOUT_BUDGET_MS });

    assert.equal(result.ready, false);
    assert.equal(sim.lastBoot?.ready, false);
  });
});

// ---- waitReady() --------------------------------------------------------

test("Simulator.waitReady()", async (t) => {
  await t.test("waits without booting -- no simctl boot, no open", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    const result = await sim.waitReady();

    assert.equal(result.ready, true);
    assert.equal(sim.lastBoot?.ready, true);
    assert.ok(!deps.calls.run.some((c) => c.args.includes("boot")));
    assert.ok(!deps.calls.run.some((c) => c.cmd === "open"));
  });

  await t.test("times out honestly -- ready:false, never throws", async () => {
    const deps = createFakeDeps({
      client: {
        accessibilityInfo: async () => {
          throw new Error("fake: simulator not answering yet");
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    const result = await sim.waitReady({ budgetMs: TIMEOUT_BUDGET_MS });

    assert.equal(result.ready, false);
    assert.equal(sim.lastBoot?.ready, false);
  });
});

// ---- shutdown() -----------------------------------------------------------

test("Simulator.shutdown()", async (t) => {
  await t.test("tolerates an already-shut-down simulator", async () => {
    const deps = createFakeDeps({
      run: () => {
        throw new Error("Invalid device: UDID");
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.doesNotReject(sim.shutdown());
  });
});

// ---- delete() -------------------------------------------------------------

test("Simulator.delete()", async (t) => {
  await t.test("closes the companion before any simctl call", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.delete();

    const closeIndex = deps.calls.order.indexOf("closeCompanion:UDID");
    const firstRunIndex = deps.calls.order.findIndex((entry) => entry.startsWith("run:"));

    assert.notEqual(closeIndex, -1, "closeCompanion must be called");
    assert.notEqual(firstRunIndex, -1, "a simctl call must happen");
    assert.ok(closeIndex < firstRunIndex, "companion must close before any simctl call");
    assert.deepEqual(deps.calls.closeCompanion, ["UDID"]);
  });

  await t.test("tolerates an already-shut-down simulator on the way to delete", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "shutdown") throw new Error("Invalid device: UDID");
        return { stdout: "", stderr: "" };
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.doesNotReject(sim.delete());
    assert.ok(deps.calls.run.some((c) => c.args[1] === "delete"));
  });

  await t.test("a simctl 'Invalid device' failure on the delete call surfaces as SimulatorNotFoundError", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "delete") throw new Error("Invalid device: UDID");
        return { stdout: "", stderr: "" };
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.delete(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError);
      assert.equal(error.code, "simulator-not-found");
      assert.doesNotMatch((error as Error).message, /Invalid device/);
      return true;
    });
  });

  await t.test("clears the recovery registry", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID-CLEARS", "iPhone", deps);
    deps.recovery.markAnswered("UDID-CLEARS");

    await sim.delete();

    assert.equal(deps.recovery.hasAnswered("UDID-CLEARS"), false);
  });

  // The close that opens `delete()` blocks every companion for the udid until
  // something reopens it, and only the two paths below decide which. Getting
  // this wrong is silent: the delete throws, the simulator is still there and
  // still meant to be drivable, and every later read from any handle in the
  // process dies inside `companionFor` instead.
  await t.test("a delete that fails for a real reason reopens the companion", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "delete") throw new Error("Unable to delete: device is booted");
        // Still listed: the delete failed, so the simulator is still there.
        if (args[1] === "list") return devicesListing(true);
        return { stdout: "", stderr: "" };
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);
    deps.recovery.markAnswered("UDID");

    await assert.rejects(sim.delete(), (error: unknown) => {
      assert.doesNotMatch((error as Error).constructor.name, /SimulatorNotFound/);
      return true;
    });

    // Reopened, and after the failed delete rather than before it.
    assert.deepEqual(deps.calls.reopenCompanion, ["UDID"]);
    assert.ok(
      deps.calls.order.indexOf("reopenCompanion:UDID") >
        deps.calls.order.indexOf("run:xcrun simctl delete UDID")
    );
    // The simulator still exists, so the handle is still good for it and the
    // recovery state is still about a real device.
    assert.equal(deps.recovery.hasAnswered("UDID"), true);
    // And the handle is still a working handle on it, not a stale one.
    assert.equal(await sim.state(), "Booted");
  });

  await t.test("a delete that finds it already gone marks the handle stale anyway", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => {
        if (args[1] === "delete") throw new Error("Invalid device: UDID");
        return { stdout: "", stderr: "" };
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);
    deps.recovery.markAnswered("UDID");

    await assert.rejects(sim.delete(), (error: unknown) => error instanceof SimulatorNotFoundError);

    // Someone else granted the caller's wish. The error is the only difference
    // between this and a delete that worked: the handle is stale, the recovery
    // state is dropped, and the companion stays blocked because there is no
    // simulator left to drive.
    assert.deepEqual(deps.calls.reopenCompanion, []);
    assert.equal(deps.recovery.hasAnswered("UDID"), false);
    const ordersBefore = deps.calls.order.length;
    await assert.rejects(sim.state(), (error: unknown) => error instanceof SimulatorNotFoundError);
    assert.equal(deps.calls.order.length, ordersBefore, "a stale handle must not touch deps");
  });
});

// ---- external deletion, on the companion path ------------------------------

/** simctl's device list, as `findDevice` reads it. `present: false` is a udid
 * simctl no longer knows — a simulator deleted underneath a live handle. */
function devicesListing(present: boolean) {
  return {
    stdout: JSON.stringify({
      devices: present
        ? {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              { udid: "UDID", name: "iPhone 16 Pro", state: "Booted", deviceTypeIdentifier: "x" },
            ],
          }
        : {},
    }),
    stderr: "",
  };
}

test("a failed companion call is resolved against simctl", async (t) => {
  // The spec promises `SimulatorNotFoundError` from *every* method on a
  // simulator deleted underneath a live handle. `mapSimctlError` could only
  // ever deliver that for the methods that go through simctl; a read or a tap
  // spawns a companion, which cannot resolve the vanished target and exits, so
  // it came back as `companion-start-failed` — true about the companion and
  // wrong about the cause.
  await t.test("becomes SimulatorNotFoundError when the udid is gone", async () => {
    const deps = createFakeDeps({
      run: () => devicesListing(false),
      companionStartFailure: new CompanionStartError([
        "Failed to load device set",
        "no device with udid UDID",
      ]),
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError, `got ${(error as Error).name}`);
      assert.equal(error.code, "simulator-not-found");
      assert.equal(error.udid, "UDID");
      return true;
    });
  });

  await t.test("stays CompanionStartError when the simulator is still there", async () => {
    // The other half, and the reason this is a lookup rather than a rename: a
    // companion that genuinely failed to start against a live simulator is a
    // real fault, and calling it "not found" would send whoever reads it
    // looking in the wrong place entirely.
    const deps = createFakeDeps({
      run: () => devicesListing(true),
      companionStartFailure: new CompanionStartError(["dyld: library not loaded"]),
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.ok(error instanceof CompanionStartError, `got ${(error as Error).name}`);
      assert.equal(error.code, "companion-start-failed");
      assert.deepEqual(error.stderrTail, ["dyld: library not loaded"]);
      return true;
    });
  });

  await t.test("a wedged bridge is never resolved against simctl", async () => {
    // The one exemption, and it has to hold: idb's "no translation object" is
    // a statement about a bridge belonging to a simulator that plainly
    // exists, `withAccessibilityRecovery` reads that wording to pick the cure,
    // and it is the only companion failure frequent enough for a `simctl
    // list` per attempt to be worth avoiding.
    const deps = createFakeDeps({
      run: () => devicesListing(true),
      client: {
        accessibilityInfo: async () => {
          throw new Error("no translation object for this element");
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen());
    assert.equal(
      deps.calls.run.filter((c) => c.args[1] === "list").length,
      0,
      "a wedge error must not pay a simctl round trip on its way out"
    );
  });

  await t.test("a udid that is still there keeps whatever failure it got", async () => {
    // Not every companion failure is a start failure — a udid that already had
    // a companion fails somewhere else entirely — so the lookup is what
    // decides, not the error's class. A simulator still listed keeps its own
    // error, whatever that was.
    const failure = new Error("14 UNAVAILABLE: no connection established");
    const deps = createFakeDeps({
      run: () => devicesListing(true),
      client: {
        accessibilityInfo: async () => {
          throw failure;
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.equal(error, failure);
      return true;
    });
  });

  await t.test("a udid that is gone becomes SimulatorNotFoundError however it failed", async () => {
    // The e2e's case: the handle already had a companion, so the failure never
    // goes near a spawn. Any shape at all arrives here -- the point of asking
    // simctl is that the shapes were never enumerable -- so the fake throws a
    // plain Error, and simctl is what decides.
    const deps = createFakeDeps({
      run: () => devicesListing(false),
      client: {
        accessibilityInfo: async () => {
          throw new Error("Simulator UDID is being shut down, so no companion will be started for it.");
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError, `got ${(error as Error).name}`);
      assert.equal(error.udid, "UDID");
      return true;
    });
  });

  await t.test("a typed refusal mid-delete survives the simctl question", async () => {
    // The other half of TODO #82: `delete()` closes the udid, then spends
    // seconds in simctl, so a concurrent read is refused while the device is
    // *still listed*. `withClient` then asks simctl, is told it exists, and
    // rethrows what it caught -- which has to already be the typed error, or
    // this window is the one place a caller still gets an unbranchable one.
    const refusal = new SimulatorNotFoundError(
      "UDID",
      "Simulator UDID is being shut down, so no companion will be started for it."
    );
    const deps = createFakeDeps({
      run: () => devicesListing(true),
      client: {
        accessibilityInfo: async () => {
          throw refusal;
        },
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.describeScreen(), (error: unknown) => {
      assert.equal(error, refusal, "rethrown as caught, prose and all");
      assert.equal((error as SimulatorNotFoundError).code, "simulator-not-found");
      return true;
    });
  });

  await t.test("findByLabel throws rather than answering null", async () => {
    // `findByLabel`'s tree fallback answers `null` when the screen cannot be
    // read, which is right for a screen that has no such element and wrong for
    // a simulator that no longer exists: "not found" would be about the label.
    const deps = createFakeDeps({
      run: () => devicesListing(false),
      companionStartFailure: new CompanionStartError(["no device with udid UDID"]),
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.findByLabel("Plain Button"), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError, `got ${(error as Error).name}`);
      return true;
    });
  });
});

// ---- stale handle: every method after delete() -----------------------------

test("every method throws SimulatorNotFoundError after delete(), touching nothing", async (t) => {
  const cases: Array<[string, (sim: Simulator) => Promise<unknown>]> = [
    ["state", (sim) => sim.state()],
    ["boot", (sim) => sim.boot()],
    ["waitReady", (sim) => sim.waitReady()],
    ["shutdown", (sim) => sim.shutdown()],
    ["delete", (sim) => sim.delete()],
    ["installApp", (sim) => sim.installApp(thisFile)],
    ["launchApp", (sim) => sim.launchApp("com.example.app")],
    ["describeScreen", (sim) => sim.describeScreen()],
    ["screenSize", (sim) => sim.screenSize()],
    ["findByLabel", (sim) => sim.findByLabel("Plain Button")],
    ["findByIdentifier", (sim) => sim.findByIdentifier("PlainButton")],
    ["describePoint", (sim) => sim.describePoint(10, 10)],
    ["rotate", (sim) => sim.rotate("landscape_left")],
    ["detectOrientation", (sim) => sim.detectOrientation()],
    ["restartBridge", (sim) => sim.restartBridge()],
    ["releaseCompanion", (sim) => sim.releaseCompanion()],
    ["screenshot", (sim) => sim.screenshot()],
    ["startRecording", (sim) => sim.startRecording("out.mp4")],
    ["stopRecording", (sim) => sim.stopRecording()],
  ];

  for (const [name, call] of cases) {
    await t.test(name, async () => {
      const deps = createFakeDeps({
        client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
      });
      const sim = new Simulator("UDID", "iPhone", deps);
      await sim.delete();
      const ordersBefore = deps.calls.order.length;

      await assert.rejects(call(sim), (error: unknown) => {
        assert.ok(error instanceof SimulatorNotFoundError);
        assert.equal(error.code, "simulator-not-found");
        return true;
      });

      assert.equal(deps.calls.order.length, ordersBefore, `${name}() must not touch deps again`);
    });
  }
});

// ---- installApp -----------------------------------------------------------

test("Simulator.installApp", async (t) => {
  await t.test("throws app-bundle-not-found before touching simctl", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(
      sim.installApp("/nonexistent-simgadget-test-fixture/Test.app"),
      (error: unknown) => {
        assert.ok(error instanceof SimGadgetError);
        assert.equal(error.code, "app-bundle-not-found");
        return true;
      }
    );
    assert.equal(deps.calls.run.length, 0);
  });

  await t.test("installs an existing path via simctl install", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.installApp(thisFile);

    assert.deepEqual(deps.calls.run[0], {
      cmd: "xcrun",
      args: ["simctl", "install", "UDID", thisFile],
    });
  });

  await t.test("a simctl 'Invalid device' failure surfaces as SimulatorNotFoundError", async () => {
    const deps = createFakeDeps({
      run: () => {
        throw new Error(
          "Command failed: xcrun simctl install UDID ...\nInvalid device: UDID\n"
        );
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.installApp(thisFile), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError);
      assert.equal(error.udid, "UDID");
      return true;
    });
  });
});

// ---- launchApp --------------------------------------------------------------

test("Simulator.launchApp", async (t) => {
  // The fixture here is what `simctl launch` actually prints, which is the
  // whole point: this test used to feed it a bare `"1234\n"` and passed against
  // a parse anchored with `/^(\d+)/` that could never match the real thing. The
  // e2e suite found `pid` was null for every launch that had ever succeeded.
  await t.test("parses the pid simctl prints after the bundle id", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) =>
        args[1] === "launch"
          ? { stdout: "com.example.mcptestapp: 18900\n", stderr: "" }
          : { stdout: "", stderr: "" },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    assert.deepEqual(await sim.launchApp("com.example.app"), { pid: 18900 });
  });

  await t.test("returns null when stdout carries no pid", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => (args[1] === "launch" ? { stdout: "", stderr: "" } : { stdout: "", stderr: "" }),
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    assert.deepEqual(await sim.launchApp("com.example.app"), { pid: null });
  });

  await t.test("puts --terminate-running-process before the udid", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.launchApp("com.example.app", { terminateRunning: true });

    const launchCall = deps.calls.run.find((c) => c.args[1] === "launch");
    assert.deepEqual(launchCall?.args, [
      "simctl",
      "launch",
      "--terminate-running-process",
      "UDID",
      "com.example.app",
    ]);
  });
});

// ---- restartBridge() / releaseCompanion() ----------------------------------

test("Simulator.restartBridge()", async (t) => {
  await t.test("runs the guest launchctl stop", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.restartBridge();

    assert.ok(
      deps.calls.run.some(
        (c) => c.cmd === "xcrun" && c.args.includes("launchctl") && c.args.includes("stop")
      )
    );
  });

  await t.test("maps an 'Invalid device' failure", async () => {
    const deps = createFakeDeps({
      run: () => {
        throw new Error("Invalid device: UDID");
      },
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    await assert.rejects(sim.restartBridge(), (error: unknown) => error instanceof SimulatorNotFoundError);
  });
});

test("Simulator.releaseCompanion()", async (t) => {
  await t.test("delegates to shutdownCompanion", async () => {
    const deps = createFakeDeps();
    const sim = new Simulator("UDID", "iPhone", deps);

    await sim.releaseCompanion();

    assert.deepEqual(deps.calls.shutdownCompanion, ["UDID"]);
  });
});
