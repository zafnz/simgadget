import test from "node:test";
import assert from "node:assert/strict";

import os from "node:os";
import path from "node:path";

import { buildSocketPath, CompanionManager } from "../src/idb/companionManager.ts";
import { SimulatorNotFoundError } from "../src/errors.ts";

// sockaddr_un.sun_path is 104 bytes on macOS, including the terminator --
// companionManager.ts's SUN_PATH_MAX. Not imported (private to that module);
// duplicated here as a literal is the honest reflection of "the OS says so".
const SUN_PATH_MAX = 104;

test("buildSocketPath", async (t) => {
  await t.test("joins dir, udid, pid and generation into one path", () => {
    assert.equal(
      buildSocketPath("/tmp/simgadget-501", "ABCD-1234", 42, 3),
      "/tmp/simgadget-501/ABCD-1234.42.3.sock"
    );
  });

  await t.test("a worst-case udid + pid + generation stays under SUN_PATH_MAX", () => {
    // A 36-character udid (the real format, e.g.
    // "F60E4D69-DBB4-4054-B262-81370DFAB00C"), a 7-digit pid, and a large
    // generation number -- the realistic worst case for one process's
    // lifetime, not a contrived one.
    const udid = "F60E4D69-DBB4-4054-B262-81370DFAB00C";
    assert.equal(udid.length, 36);
    const pid = 9_999_999; // 7 digits
    const generation = 999_999_999; // a large generation count

    const socketPath = buildSocketPath(
      "/tmp/simgadget-501",
      udid,
      pid,
      generation
    );

    assert.ok(
      Buffer.byteLength(socketPath) < SUN_PATH_MAX,
      `expected under ${SUN_PATH_MAX} bytes, got ${Buffer.byteLength(socketPath)}: ${socketPath}`
    );
  });

  await t.test("a longer socket directory can still overrun the limit", () => {
    // Not a bug -- it is exactly why the check in companionManager.ts runs
    // against the real socketDir(), every spawn, rather than being assumed
    // safe from this test alone.
    const udid = "F60E4D69-DBB4-4054-B262-81370DFAB00C";
    const deepDir = "/tmp/" + "x".repeat(80);
    const socketPath = buildSocketPath(deepDir, udid, 9_999_999, 999_999_999);
    assert.ok(Buffer.byteLength(socketPath) >= SUN_PATH_MAX);
  });
});

test("a udid closed for teardown", async (t) => {
  // `close()` on a udid with no companion running is pure bookkeeping -- no
  // process is spawned, so these run in microseconds and never go near a
  // simulator. That is also the exact shape of the race being tested: a call
  // arriving while `delete()` is between `closeCompanion` and `simctl delete`.
  const UDID = "F60E4D69-DBB4-4054-B262-81370DFAB00C";

  await t.test("refuses with SimulatorNotFoundError, not an untyped IdbError", async () => {
    // TODO #82. `IdbError` is deliberately not exported, so the old refusal
    // could not even be instanceof-checked by the host that had to render it.
    const manager = new CompanionManager();
    await manager.close(UDID);

    await assert.rejects(
      manager.withClient(UDID, async () => "never runs"),
      (error: unknown) => {
        assert.ok(error instanceof SimulatorNotFoundError, `got ${(error as Error).name}`);
        assert.equal(error.udid, UDID);
        assert.equal(error.code, "simulator-not-found");
        // The refusal keeps its own prose: "being shut down" tells a reader
        // which of the two ways this udid became unusable it was.
        assert.match(error.message, /being shut down/);
        return true;
      }
    );
  });

  await t.test("refuses before spawning anything", async () => {
    const manager = new CompanionManager();
    await manager.close(UDID);

    await assert.rejects(manager.withClient(UDID, async () => "never runs"));
    // A spawn would have registered the udid here -- and spawning a companion
    // against a simulator `simctl delete` is about to remove is the whole
    // reason `closed` exists.
    assert.deepEqual(manager.running(), []);
  });

  await t.test("reopen lifts the refusal", async () => {
    // `delete()` reopens a udid when the deletion itself failed, so the
    // refusal must not be permanent. Shown by the failure changing hands: past
    // the gate the spawn runs and stops at binary resolution, which
    // SIMGADGET_COMPANION_PATH pins to a file that does not exist -- an
    // override is honoured before any download, so this test neither fetches
    // 19 MB nor starts a process.
    const saved = process.env.SIMGADGET_COMPANION_PATH;
    process.env.SIMGADGET_COMPANION_PATH = path.join(
      os.tmpdir(),
      "simgadget-no-such-companion"
    );
    try {
      const manager = new CompanionManager();
      await manager.close(UDID);
      manager.reopen(UDID);

      await assert.rejects(
        manager.withClient(UDID, async () => "never runs"),
        (error: unknown) => {
          assert.ok(
            !(error instanceof SimulatorNotFoundError),
            `still refusing after reopen: ${(error as Error).message}`
          );
          assert.match((error as Error).message, /SIMGADGET_COMPANION_PATH/);
          return true;
        }
      );
      assert.deepEqual(manager.running(), [], "nothing was left running");
    } finally {
      if (saved === undefined) delete process.env.SIMGADGET_COMPANION_PATH;
      else process.env.SIMGADGET_COMPANION_PATH = saved;
    }
  });
});
