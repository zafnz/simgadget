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
import { SimGadgetError, SimulatorNotFoundError } from "../src/errors.ts";
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
  await t.test("parses the pid from the first token of stdout", async () => {
    const deps = createFakeDeps({
      run: (cmd, args) => (args[1] === "launch" ? { stdout: "1234\n", stderr: "" } : { stdout: "", stderr: "" }),
    });
    const sim = new Simulator("UDID", "iPhone", deps);

    assert.deepEqual(await sim.launchApp("com.example.app"), { pid: 1234 });
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
