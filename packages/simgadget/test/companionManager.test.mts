import test from "node:test";
import assert from "node:assert/strict";

import { buildSocketPath } from "../src/idb/companionManager.ts";

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
