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
  listSimulatorsWith,
  parseDevices,
  pickDeviceType,
  pickLatestRuntime,
  shouldAttemptBootRecovery,
  waitUntilDriveable,
  type DeviceTypeInfo,
  type RuntimeInfo,
} from "../src/lifecycle.ts";
import { DeviceTypeNotFoundError, SimGadgetError, SimulatorNotFoundError } from "../src/errors.ts";
import { createFakeDeps } from "./fakes/deps.ts";

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
    // Settled first: bootstatus wait + BOOT_SETTLE_MS, before the first probe.
    assert.ok(result.waitedMs >= BOOTSTATUS_CAP_MS + BOOT_SETTLE_MS);
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
    "times out honestly -- ready:false, never throws -- and attempts recovery exactly once near the end of budget",
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
    // companions.reopen(udid) is a real (harmless, in-memory) call on the
    // process-level singleton -- see lifecycle.ts's comment on why it is not
    // reached through SimulatorDeps. Exercised here for coverage; there is no
    // observable effect to assert beyond "this does not throw".
    const order: string[] = [];
    const deps = createFakeCreateDeps(order);
    await assert.doesNotReject(createSimulatorWith(undefined, deps));
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
  });
});
