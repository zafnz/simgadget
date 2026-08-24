import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOTSTATUS_CAP_MS,
  BOOT_SETTLE_MS,
  BRIDGE_RECOVERY_MIN_POLL_MS,
  RECOVERY_TAIL_MS,
  attachSimulatorWith,
  createSimulatorWith,
  deriveDeviceName,
  findDevice,
  isAlreadyBootedError,
  isInvalidDeviceError,
  listSimulatorsWith,
  parseDevices,
  pickDeviceType,
  parseLaunchPid,
  pickLatestRuntime,
  shouldAttemptBootRecovery,
  waitUntilDriveable,
  type DeviceTypeInfo,
  type RuntimeInfo,
} from "../src/lifecycle.ts";
import { DeviceTypeNotFoundError, SimGadgetError, SimulatorNotFoundError } from "../src/errors.ts";
import { FakeChildProcess, createFakeDeps } from "./fakes/deps.ts";

// ---- pure extractions -------------------------------------------------------

test("parseDevices", async (t) => {
  await t.test("flattens every runtime bucket into one array", () => {
    const json = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          {
            udid: "AAAAAAAA-0000-0000-0000-000000000000",
            name: "iPhone 16 Pro",
            state: "Shutdown",
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
          },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
          {
            udid: "BBBBBBBB-0000-0000-0000-000000000000",
            name: "iPad Air",
            state: "Booted",
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air",
          },
        ],
      },
    };

    const devices = parseDevices(json);
    assert.equal(devices.length, 2);
    assert.deepEqual(
      devices.map((d) => d.udid).sort(),
      ["AAAAAAAA-0000-0000-0000-000000000000", "BBBBBBBB-0000-0000-0000-000000000000"]
    );
  });

  await t.test("threads the bucket key through as runtimeIdentifier", () => {
    const devices = parseDevices({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "AAAA", name: "iPhone", state: "Booted", deviceTypeIdentifier: "x" },
        ],
      },
    });
    assert.equal(devices[0].runtimeIdentifier, "com.apple.CoreSimulator.SimRuntime.iOS-18-0");
  });

  await t.test("an empty read comes back as an empty array, not a crash", () => {
    assert.deepEqual(parseDevices({ devices: {} }), []);
    assert.deepEqual(parseDevices({}), []);
    assert.deepEqual(parseDevices(null), []);
  });

  await t.test("skips entries with no udid rather than throwing", () => {
    const devices = parseDevices({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "no udid here" }, null],
      },
    });
    assert.deepEqual(devices, []);
  });
});

test("pickDeviceType", async (t) => {
  const list: DeviceTypeInfo[] = [
    { name: "iPhone 16 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro" },
    { name: "iPhone 15", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15" },
    { name: "iPad Pro (12.9-inch)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro" },
  ];

  await t.test("matches by case-insensitive substring", () => {
    assert.equal(pickDeviceType(list, "iphone").name, "iPhone 16 Pro");
    assert.equal(pickDeviceType(list, "IPAD").name, "iPad Pro (12.9-inch)");
  });

  await t.test("the first match wins -- callers must pass simctl's newest-first order", () => {
    // list[0] is "newer" than list[1] by construction; pickDeviceType must not
    // re-sort, or this would silently start returning the 15 instead.
    assert.equal(pickDeviceType(list, "iPhone").identifier, list[0].identifier);
  });

  await t.test("throws DeviceTypeNotFoundError carrying every available name", () => {
    assert.throws(
      () => pickDeviceType(list, "Apple Watch"),
      (error: unknown) => {
        assert.ok(error instanceof DeviceTypeNotFoundError);
        assert.equal(error.code, "device-type-not-found");
        assert.equal(error.keyword, "Apple Watch");
        assert.deepEqual(error.available, list.map((dt) => dt.name));
        return true;
      }
    );
  });
});

test("pickLatestRuntime", async (t) => {
  await t.test("picks the last iOS, available entry -- simctl lists oldest first", () => {
    const list: RuntimeInfo[] = [
      { name: "iOS 17.0", identifier: "iOS-17-0", isAvailable: true },
      { name: "iOS 18.0", identifier: "iOS-18-0", isAvailable: true },
    ];
    assert.equal(pickLatestRuntime(list), "iOS-18-0");
  });

  await t.test("ignores unavailable runtimes", () => {
    const list: RuntimeInfo[] = [
      { name: "iOS 17.0", identifier: "iOS-17-0", isAvailable: true },
      { name: "iOS 18.0", identifier: "iOS-18-0", isAvailable: false },
    ];
    assert.equal(pickLatestRuntime(list), "iOS-17-0");
  });

  await t.test("ignores non-iOS runtimes (watchOS, tvOS, ...)", () => {
    const list: RuntimeInfo[] = [
      { name: "iOS 17.0", identifier: "iOS-17-0", isAvailable: true },
      { name: "watchOS 11.0", identifier: "watchOS-11-0", isAvailable: true },
    ];
    assert.equal(pickLatestRuntime(list), "iOS-17-0");
  });

  await t.test("throws a plain SimGadgetError coded no-ios-runtime when nothing qualifies", () => {
    assert.throws(
      () => pickLatestRuntime([]),
      (error: unknown) => {
        assert.ok(error instanceof SimGadgetError);
        assert.equal(error.code, "no-ios-runtime");
        return true;
      }
    );
  });
});

test("deriveDeviceName", async (t) => {
  await t.test("an explicit name wins outright", () => {
    assert.equal(deriveDeviceName("iPhone", "my-own-name"), "my-own-name");
  });

  await t.test("otherwise derives from the keyword alone -- no session id", () => {
    assert.equal(deriveDeviceName("iPhone"), "simgadget-iphone");
  });

  await t.test("multi-word keywords become dash-separated", () => {
    assert.equal(deriveDeviceName("iPhone 16 Pro"), "simgadget-iphone-16-pro");
  });
});

test("isInvalidDeviceError", async (t) => {
  await t.test("matches shutdown/delete/install/launch/spawn's wording", () => {
    assert.equal(isInvalidDeviceError("Invalid device: 00000000-0000-0000-0000-000000000000"), true);
  });

  await t.test("matches boot's differently-worded shape", () => {
    assert.equal(
      isInvalidDeviceError("Invalid device or device pair: 00000000-0000-0000-0000-000000000000"),
      true
    );
  });

  await t.test("matches wrapped in execFile's 'Command failed' prefix", () => {
    assert.equal(
      isInvalidDeviceError(
        "Command failed: xcrun simctl shutdown 00000000-0000-0000-0000-000000000000\n" +
          "Invalid device: 00000000-0000-0000-0000-000000000000\n"
      ),
      true
    );
  });

  await t.test("does not match near-misses", () => {
    for (const message of [
      // A bad `simctl create` devicetype keyword -- a real simctl failure,
      // but a different one; this library never even reaches it, since
      // pickDeviceType validates first, but the recogniser must not blur
      // the two anyway.
      'Invalid device type "Apple Watch"',
      "Invalid devicetype identifier",
      "invalid device: lowercase does not occur in real simctl output",
      "Device invalid: 00000000-0000-0000-0000-000000000000",
      "No devices are booted.",
      "",
    ]) {
      assert.equal(isInvalidDeviceError(message), false, `should not match: ${message}`);
    }
  });
});

test("isAlreadyBootedError", async (t) => {
  await t.test("matches the real message", () => {
    assert.equal(
      isAlreadyBootedError(
        "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, " +
          "code=164): Unable to boot device in current state: Booted"
      ),
      true
    );
  });

  await t.test("is case-insensitive", () => {
    assert.equal(isAlreadyBootedError("unable to boot device in current state: booted"), true);
  });

  await t.test("does not match a different current state, or an unrelated failure", () => {
    for (const message of [
      "Unable to boot device in current state: Booting",
      "Unable to boot device in current state: Shutting Down",
      "Invalid device or device pair: 00000000-0000-0000-0000-000000000000",
      "",
    ]) {
      assert.equal(isAlreadyBootedError(message), false, `should not match: ${message}`);
    }
  });
});

test("shouldAttemptBootRecovery", async (t) => {
  await t.test("false while comfortably inside the budget", () => {
    assert.equal(
      shouldAttemptBootRecovery({ elapsed: 5_000, budget: 55_000, sincePollStart: 5_000 }),
      false
    );
  });

  await t.test("false near the deadline if polling only just started", () => {
    assert.equal(
      shouldAttemptBootRecovery({ elapsed: 54_000, budget: 55_000, sincePollStart: 1_000 }),
      false
    );
  });

  await t.test("true only once both the tail and the minimum poll window are satisfied", () => {
    assert.equal(
      shouldAttemptBootRecovery({
        elapsed: 44_000,
        budget: 55_000,
        sincePollStart: 9_000, // > BRIDGE_RECOVERY_MIN_POLL_MS
      }),
      true // remaining = 11_000 <= RECOVERY_TAIL_MS
    );
  });

  await t.test("false when there is still plenty of budget left, even after a long poll", () => {
    assert.equal(
      shouldAttemptBootRecovery({ elapsed: 20_000, budget: 55_000, sincePollStart: 15_000 }),
      false // remaining = 35_000, well past RECOVERY_TAIL_MS
    );
  });
});

// ---- the boot ladder (fake-client) -----------------------------------------

/** A root-frame accessibility read the way idb answers it: a one-element array. */
function treeWithFrame(width: number, height: number) {
  return [{ frame: { x: 0, y: 0, width, height } }];
}

test("waitUntilDriveable", async (t) => {
  await t.test("ready:true as soon as a real frame comes back", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });

    const result = await waitUntilDriveable(deps, "UDID", 55_000);

    assert.equal(result.ready, true);
    assert.equal(result.recoveryTried, false);
    assert.equal(result.recovered, false);
    // Settled first, and asserted as an order rather than as a duration: the
    // bootstatus wait costs whatever the device makes it cost (nothing at all
    // when it has already booted), but the settle before the first probe is
    // unconditional. See BOOT_SETTLE_MS for why it is kept.
    assert.deepEqual(deps.calls.order.slice(0, 4), [
      "spawn:xcrun simctl bootstatus UDID -b",
      `setTimer:${BOOTSTATUS_CAP_MS}`,
      `sleep:${BOOT_SETTLE_MS}`,
      "withClient:UDID",
    ]);
  });

  await t.test("a 0x0 frame does not count as ready", async () => {
    let calls = 0;
    const deps = createFakeDeps({
      client: {
        accessibilityInfo: async () => {
          calls += 1;
          // Booting: answers, but with the empty frame a still-coming-up
          // device reports.
          return calls < 3 ? treeWithFrame(0, 0) : treeWithFrame(390, 844);
        },
      },
    });

    const result = await waitUntilDriveable(deps, "UDID", 55_000);
    assert.equal(result.ready, true);
    assert.ok(calls >= 3);
  });

  await t.test(
    "times out cleanly -- ready:false, never throws -- and attempts recovery exactly once near the end of budget",
    async () => {
      const deps = createFakeDeps({
        client: {
          accessibilityInfo: async () => {
            throw new Error("fake: simulator not answering yet");
          },
        },
      });

      // Derived from the same constants the ladder uses, not hardcoded: a
      // polling window (BRIDGE_RECOVERY_MIN_POLL_MS + RECOVERY_TAIL_MS) wide
      // guarantees a poll tick lands in the window where shouldAttemptBootRecovery
      // is true, however BOOT_POLL_INTERVAL_MS is tuned later.
      const budgetMs =
        BOOTSTATUS_CAP_MS + BOOT_SETTLE_MS + BRIDGE_RECOVERY_MIN_POLL_MS + RECOVERY_TAIL_MS;

      const result = await waitUntilDriveable(deps, "UDID", budgetMs);

      assert.equal(result.ready, false);
      assert.equal(result.recovered, false);
      assert.equal(result.recoveryTried, true);
      assert.equal(result.waitedMs, budgetMs);

      const restarts = deps.calls.run.filter(
        (c) => c.cmd === "xcrun" && c.args.includes("launchctl") && c.args.includes("stop")
      );
      assert.equal(restarts.length, 1);
    }
  );

  await t.test("waitForBootStatus uses deps.spawn, and kills a still-running probe", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });

    await waitUntilDriveable(deps, "UDID", 55_000);

    assert.equal(deps.calls.spawn.length, 1);
    assert.deepEqual(deps.calls.spawn[0], { cmd: "xcrun", args: ["simctl", "bootstatus", "UDID", "-b"] });
  });

  // The cap on the bootstatus wait is a race, and both sides of it used to
  // leak: a raced `deps.sleep` cannot be cancelled, so whichever side lost
  // kept a `setTimeout` pending and Node alive with it. The two cases below
  // are that race, run in both directions; `cancelled` is the assertion in
  // one and "there is no second timer" in the other.
  await t.test("the cap timer is cancelled when bootstatus exits first", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });

    await waitUntilDriveable(deps, "UDID", 55_000);

    // The default fake child exits at once, as bootstatus does on a device
    // that has already booted — the case a live 30s timer taxed hardest.
    assert.equal(deps.calls.timers.length, 1);
    assert.equal(deps.calls.timers[0].ms, BOOTSTATUS_CAP_MS);
    assert.equal(deps.calls.timers[0].cancelled, true);
  });

  await t.test("the cap fires, and kills the child rather than leaving it", async () => {
    const children: FakeChildProcess[] = [];
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
      // Never exits: bootstatus against a device that really is still coming
      // up, so the cap is what ends the wait.
      spawn: () => {
        const child = new FakeChildProcess();
        children.push(child);
        return child;
      },
    });

    const pending = waitUntilDriveable(deps, "UDID", 55_000);
    // Armed synchronously — `waitForBootStatus` spawns and arms before it
    // yields — so the timer is there to fire without waiting for a tick.
    assert.equal(deps.calls.timers.length, 1);
    deps.calls.timers[0].fire();
    const result = await pending;

    assert.equal(result.ready, true);
    assert.equal(children[0].killed, true);
    // One timer, fired rather than cancelled, and nothing armed after it.
    assert.equal(deps.calls.timers.length, 1);
    assert.equal(deps.calls.timers[0].cancelled, false);
  });

  await t.test("a spawn that cannot run the binary is a wait ended, not a crash", async () => {
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
      spawn: () => {
        const child = new FakeChildProcess();
        // An unhandled `error` on an EventEmitter throws, so without the
        // listener this takes the process down instead of failing a test.
        setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
        return child;
      },
    });

    const result = await waitUntilDriveable(deps, "UDID", 55_000);

    assert.equal(result.ready, true);
    assert.equal(deps.calls.timers[0].cancelled, true);
  });
});

// ---- listSimulators / findDevice -------------------------------------------

function devicesJson(devices: Array<{ udid: string; name: string; state: string }>) {
  return {
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": devices.map((d) => ({
          ...d,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
        })),
      },
    }),
    stderr: "",
  };
}

test("listSimulatorsWith / findDevice", async (t) => {
  await t.test("listSimulatorsWith parses simctl's JSON via parseDevices", async () => {
    const deps = createFakeDeps({
      run: () => devicesJson([{ udid: "UDID-1", name: "iPhone 16 Pro", state: "Booted" }]),
    });

    const sims = await listSimulatorsWith(deps);
    assert.equal(sims.length, 1);
    assert.equal(sims[0].udid, "UDID-1");
    assert.equal(sims[0].state, "Booted");
  });

  await t.test("findDevice returns the matching SimInfo", async () => {
    const deps = createFakeDeps({
      run: () =>
        devicesJson([
          { udid: "UDID-1", name: "iPhone 16 Pro", state: "Booted" },
          { udid: "UDID-2", name: "iPad Air", state: "Shutdown" },
        ]),
    });

    const found = await findDevice(deps, "UDID-2");
    assert.equal(found?.name, "iPad Air");
  });

  await t.test("findDevice returns null for an unknown udid", async () => {
    const deps = createFakeDeps({ run: () => devicesJson([]) });
    assert.equal(await findDevice(deps, "no-such-udid"), null);
  });
});

// ---- createSimulatorWith / attachSimulatorWith -----------------------------

/** A fake `run` that answers `simctl list devicetypes/runtimes -j` with one
 * entry each, `simctl create` with a fixed udid, and records everything else
 * as an ordered label via `order`. */
function createFakeCreateDeps(order: string[], overrides: { accessibilityInfo?: () => Promise<unknown> } = {}) {
  return createFakeDeps({
    run: (cmd, args) => {
      if (args.includes("devicetypes")) {
        return {
          stdout: JSON.stringify({
            devicetypes: [{ name: "iPhone 16 Pro", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro" }],
          }),
          stderr: "",
        };
      }
      if (args.includes("runtimes")) {
        return {
          stdout: JSON.stringify({
            runtimes: [{ name: "iOS 18.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", isAvailable: true }],
          }),
          stderr: "",
        };
      }
      if (args[1] === "create") {
        order.push("create");
        return { stdout: "FAKE-UDID", stderr: "" };
      }
      if (args[1] === "boot") {
        order.push("boot");
        return { stdout: "", stderr: "" };
      }
      if (cmd === "open") {
        order.push("open");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    client: {
      accessibilityInfo:
        overrides.accessibilityInfo ??
        (async () => {
          order.push("probe");
          return treeWithFrame(390, 844);
        }),
    },
  });
}

test("waitUntilDriveable narrates the boot-time cure", async (t) => {
  // The other half of TODO #100, found by watching two real simulators wedge
  // and recover during the step-6 TESTING_SERVER run while the log stayed
  // empty. The mid-session cure lives on the handle and reports itself; this
  // one lives in the boot ladder, which has no handle — so it takes the sink
  // as an argument, and `boot()`/`waitReady()` hand it their own.
  await t.test("says it restarted the bridge, and that the restart is what fixed it", async () => {
    const logged: string[] = [];
    let reads = 0;
    const deps = createFakeDeps({
      client: {
        accessibilityInfo: async () => {
          reads += 1;
          // Silent until well past the point a healthy device would answer,
          // which is what makes the ladder reach for the cure.
          if (reads < 9) throw new Error("no translation object");
          return treeWithFrame(390, 844);
        },
      },
    });

    // A 25s budget so the fake clock reaches the *tail*, which is the only
    // place the boot ladder reaches for the cure: `shouldAttemptBootRecovery`
    // wants the remaining budget under RECOVERY_TAIL_MS and the poll loop
    // already 8s old. A generous budget never gets there — the first version
    // of this test used 120s and never armed it.
    const result = await waitUntilDriveable(deps, "UDID", 25_000, (m) => logged.push(m));

    assert.equal(result.ready, true);
    assert.equal(result.recoveryTried, true, "the fixture has to reach the cure to be a test of it");
    assert.equal(
      logged[0],
      "simulator UDID has not answered accessibility while booting; restarting com.apple.CoreSimulator.bridge"
    );
    assert.match(
      logged[1] ?? "",
      /^simulator UDID recovered \d+s into the boot, after restarting com\.apple\.CoreSimulator\.bridge$/
    );
  });

  await t.test("a boot that never needed the cure says nothing", async () => {
    const logged: string[] = [];
    const deps = createFakeDeps({
      client: { accessibilityInfo: async () => treeWithFrame(390, 844) },
    });

    const result = await waitUntilDriveable(deps, "UDID", 60_000, (m) => logged.push(m));

    assert.equal(result.ready, true);
    assert.equal(result.recoveryTried, false);
    assert.deepEqual(logged, []);
  });
});

test("createSimulatorWith", async (t) => {
  await t.test("runs create -> boot -> open -> probe, in that order, and returns a ready handle", async () => {
    const order: string[] = [];
    const deps = createFakeCreateDeps(order);

    const sim = await createSimulatorWith(undefined, deps);

    assert.equal(sim.udid, "FAKE-UDID");
    assert.equal(sim.name, "simgadget-iphone");
    assert.deepEqual(order.slice(0, 4), ["create", "boot", "open", "probe"]);
    assert.equal(sim.lastBoot?.ready, true);
  });

  await t.test("keeps the device type it resolved, name as well as identifier", async () => {
    // The create call is the only place the *name* is known for free: it
    // resolves the model to pass an identifier to `simctl create`, and no
    // later lookup can recover "iPhone 16 Pro" from a udid -- `SimInfo`
    // carries the identifier only. The MCP's start_simulator answer names the
    // model, which is where an agent that asked for "iPhone" learns which one
    // it got.
    const deps = createFakeCreateDeps([]);

    const sim = await createSimulatorWith({ deviceType: "iPhone" }, deps);

    assert.deepEqual(sim.deviceType, {
      name: "iPhone 16 Pro",
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
    });
  });

  await t.test("boot:false skips simctl boot, opening the window, and the wait entirely", async () => {
    const order: string[] = [];
    const deps = createFakeCreateDeps(order);

    const sim = await createSimulatorWith({ boot: false }, deps);

    assert.deepEqual(order, ["create"]);
    assert.equal(sim.lastBoot, undefined);
  });

  await t.test("does not throw on a boot that times out -- the handle and udid still come back", async () => {
    const order: string[] = [];
    const deps = createFakeCreateDeps(order, {
      accessibilityInfo: async () => {
        throw new Error("fake: never answers");
      },
    });

    const budgetMs =
      BOOTSTATUS_CAP_MS + BOOT_SETTLE_MS + BRIDGE_RECOVERY_MIN_POLL_MS + RECOVERY_TAIL_MS;

    const sim = await createSimulatorWith({ budgetMs }, deps);

    assert.equal(sim.udid, "FAKE-UDID");
    assert.equal(sim.lastBoot?.ready, false);
    assert.equal(sim.lastBoot?.recoveryTried, true);
  });

  await t.test("an unknown device-type keyword fails before anything is created", async () => {
    const order: string[] = [];
    const deps = createFakeCreateDeps(order);

    await assert.rejects(
      createSimulatorWith({ deviceType: "Apple Watch" }, deps),
      (error: unknown) => error instanceof DeviceTypeNotFoundError
    );
    assert.deepEqual(order, []);
  });

  await t.test("clears a previous close() block on the fresh udid", async () => {
    // DECISIONS.md #19: reopenCompanion is reached through the deps seam
    // (not called on the process-level singleton directly), which is what
    // makes it observable here.
    const order: string[] = [];
    const deps = createFakeCreateDeps(order);
    const sim = await createSimulatorWith(undefined, deps);
    assert.deepEqual(deps.calls.reopenCompanion, [sim.udid]);
  });
});

test("attachSimulatorWith", async (t) => {
  await t.test("throws SimulatorNotFoundError for an unknown udid, and never boots or probes", async () => {
    const deps = createFakeDeps({ run: () => devicesJson([]) });

    await assert.rejects(
      attachSimulatorWith("no-such-udid", deps),
      (error: unknown) => {
        assert.ok(error instanceof SimulatorNotFoundError);
        assert.equal(error.code, "simulator-not-found");
        assert.equal(error.udid, "no-such-udid");
        return true;
      }
    );

    assert.equal(deps.calls.withClient.length, 0, "must not probe accessibility");
    const bootOrOpenCalls = deps.calls.run.filter(
      (c) => c.args[1] === "boot" || c.cmd === "open"
    );
    assert.deepEqual(bootOrOpenCalls, []);
  });

  await t.test("leaves deviceType undefined, because attaching never resolves one", async () => {
    // Undefined rather than guessed. A udid's device type is knowable from
    // `listSimulators()` as an identifier, at the cost of a `simctl list`, and
    // the model name is not knowable at all without a second one -- so the
    // handle says it does not know instead of paying for a half-answer nobody
    // asked for.
    const deps = createFakeDeps({
      run: () => devicesJson([{ udid: "UDID-1", name: "iPhone 16 Pro", state: "Booted" }]),
    });

    const sim = await attachSimulatorWith("UDID-1", deps);

    assert.equal(sim.deviceType, undefined);
    // The *device* name is still there: that is the simulator's own name, not
    // its model, and the two are only equal by coincidence of this fixture.
    assert.equal(sim.name, "iPhone 16 Pro");
  });

  await t.test("adopts a known udid without probing or waiting -- lastBoot stays undefined", async () => {
    const deps = createFakeDeps({
      run: () => devicesJson([{ udid: "UDID-1", name: "iPhone 16 Pro", state: "Booted" }]),
    });

    const sim = await attachSimulatorWith("UDID-1", deps);

    assert.equal(sim.udid, "UDID-1");
    assert.equal(sim.name, "iPhone 16 Pro");
    assert.equal(sim.lastBoot, undefined);
    assert.equal(deps.calls.withClient.length, 0);
    assert.equal(deps.calls.sleep.length, 0);
    // Clears a block a previous detach left behind, via the deps seam
    // (DECISIONS.md #19).
    assert.deepEqual(deps.calls.reopenCompanion, ["UDID-1"]);
  });
});

/**
 * The shapes `simctl launch` actually answers with.
 *
 * The port read `/^(\\d+)/` — anchored at the start of a line that begins with
 * the bundle identifier — so it matched nothing simctl has ever printed, and
 * `launchApp` returned `{pid: null}` for every successful launch. The unit test
 * that covered it fed a bare `"1234\\n"`, a fixture no simctl produces, which
 * is how the bug outlived a test suite. Found by the e2e suite, 2026-08-17.
 */
test("parseLaunchPid", async (t) => {
  await t.test("reads the pid out of what simctl prints", () => {
    assert.equal(parseLaunchPid("com.example.mcptestapp: 18900"), 18900);
    assert.equal(parseLaunchPid("com.example.mcptestapp: 18900\n"), 18900);
  });

  // A bundle identifier may itself contain digits, which is why the pid is
  // taken from the end of the reply rather than after the first colon.
  await t.test("is not confused by digits in the bundle identifier", () => {
    assert.equal(parseLaunchPid("com.example.app2fa: 4242"), 4242);
    assert.equal(parseLaunchPid("io.grpc9.thing99: 7"), 7);
  });

  // The other half of the same fact: an identifier ending in digits, in a
  // reply that carries no pid at all. Reading from the end is only safe
  // because the pid must be preceded by the delimiter that separates it from
  // the identifier -- without that, this returns 2 and the caller is handed a
  // process id that never existed.
  await t.test("does not read a digit-ending bundle id as a pid", () => {
    for (const reply of ["com.example.app2", "com.example.app2\n", "io.grpc9.thing99"]) {
      assert.equal(parseLaunchPid(reply), null, `should be null: ${JSON.stringify(reply)}`);
    }
  });

  await t.test("answers null when there is no pid to read", () => {
    for (const reply of ["", "   ", "com.example.app:", "no pid here"]) {
      assert.equal(parseLaunchPid(reply), null, `should be null: ${JSON.stringify(reply)}`);
    }
  });
});
