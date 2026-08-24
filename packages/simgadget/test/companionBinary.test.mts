import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import fs from "node:fs";

import {
  assertSupportedArchitecture,
  cacheRoot,
  findVendorCompanion,
  readLock,
} from "../src/idb/companionBinary.ts";
import { CompanionDownloadError, UnsupportedArchitectureError } from "../src/errors.ts";
import { resetEnvWarnings } from "../src/env.ts";

/** Runs `fn` against a scratch copy of `process.env`, restored afterwards. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("SIMGADGET_") ||
        key.startsWith("IOS_SIMULATOR_MCP_") ||
        key === "XDG_CACHE_HOME"
      ) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvWarnings();
    fn();
  } finally {
    process.env = saved;
    resetEnvWarnings();
  }
}

test("findVendorCompanion", async (t) => {
  await t.test("finds a vendor build two levels above the package root", () => {
    // packages/simgadget is the package root; vendor/idb lives at the repo
    // root, two levels further up -- exactly the discrepancy the walk exists
    // to fix.
    const packageRoot = "/repo/packages/simgadget";
    const expected = "/repo/vendor/idb/Build/Distribution/idb_companion";
    const exists = (candidate: string) => candidate === expected;

    assert.equal(findVendorCompanion(packageRoot, exists), expected);
  });

  await t.test("finds a build sitting directly at the start directory", () => {
    const start = "/some/place";
    const expected = path.join(start, "vendor", "idb", "Build", "Distribution", "idb_companion");
    assert.equal(
      findVendorCompanion(start, (candidate) => candidate === expected),
      expected
    );
  });

  await t.test("gives up at the filesystem root when nothing is found", () => {
    assert.equal(
      findVendorCompanion("/repo/packages/simgadget", () => false),
      undefined
    );
  });

  await t.test("never calls exists again once dir === parent (root reached)", () => {
    let calls = 0;
    findVendorCompanion("/", () => {
      calls += 1;
      return false;
    });
    // "/"'s parent is "/" itself, so exactly one probe, then stop.
    assert.equal(calls, 1);
  });
});

test("cacheRoot", async (t) => {
  await t.test("honours the new override spelling", () => {
    withEnv({ SIMGADGET_COMPANION_CACHE: "/custom/cache" }, () => {
      assert.equal(cacheRoot(), "/custom/cache");
    });
  });

  await t.test("honours the deprecated override spelling", () => {
    withEnv({ IOS_SIMULATOR_MCP_COMPANION_CACHE: "/old/custom/cache" }, () => {
      assert.equal(cacheRoot(), "/old/custom/cache");
    });
  });

  await t.test("expands a leading ~/ in the override", () => {
    withEnv({ SIMGADGET_COMPANION_CACHE: "~/caches/simgadget" }, () => {
      assert.equal(cacheRoot(), path.join(os.homedir(), "caches", "simgadget"));
    });
  });

  await t.test("falls back to XDG_CACHE_HOME, named simgadget", () => {
    withEnv({ XDG_CACHE_HOME: "/xdg/cache" }, () => {
      assert.equal(cacheRoot(), path.join("/xdg/cache", "simgadget"));
    });
  });

  await t.test("the override wins over XDG_CACHE_HOME", () => {
    withEnv({ SIMGADGET_COMPANION_CACHE: "/custom/cache", XDG_CACHE_HOME: "/xdg/cache" }, () => {
      assert.equal(cacheRoot(), "/custom/cache");
    });
  });

  await t.test("falls back to ~/Library/Caches/simgadget when nothing is set", () => {
    withEnv({}, () => {
      assert.equal(
        cacheRoot(),
        path.join(os.homedir(), "Library", "Caches", "simgadget")
      );
    });
  });
});

test("readLock", async (t) => {
  // TODO #82: both failures used to be an `IdbError`, which is not exported --
  // so a caller could read the message and nothing else. The code is what any
  // of this is for.
  // Only the injected path is exercised: the default resolves through
  // `__dirname`, which does not exist when the suite runs the TypeScript
  // directly. The shipped file is read for real by the e2e suite instead.
  await t.test("a missing lock file is a typed download failure", () => {
    const missing = path.join(os.tmpdir(), "simgadget-no-such-lock-file.json");
    assert.equal(fs.existsSync(missing), false, "the fixture path must not exist");

    try {
      readLock(missing);
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof CompanionDownloadError, `got ${(error as Error).name}`);
      assert.equal(error.code, "companion-download-failed");
      // The prose is the remedy, and it must survive being given a code.
      assert.match(error.message, /SIMGADGET_COMPANION_PATH/);
      assert.match(error.message, /companion\.lock\.json/);
    }
  });

  await t.test("an unreadable lock file is the same failure, one step later", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "simgadget-lock-"));
    const lockPath = path.join(scratch, "companion.lock.json");
    fs.writeFileSync(lockPath, "{ this is not json");
    try {
      readLock(lockPath);
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof CompanionDownloadError, `got ${(error as Error).name}`);
      assert.equal(error.code, "companion-download-failed");
      assert.match(error.message, /not readable JSON/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test("assertSupportedArchitecture", async (t) => {
  await t.test("passes on Apple Silicon", () => {
    assert.doesNotThrow(() =>
      assertSupportedArchitecture({ platform: "darwin", arch: "arm64", arm64: true })
    );
  });

  await t.test("throws for an x64 Mac", () => {
    assert.throws(
      () => assertSupportedArchitecture({ platform: "darwin", arch: "x64", arm64: false }),
      UnsupportedArchitectureError
    );
  });

  await t.test("the thrown error names the arch and carries the right code", () => {
    try {
      assertSupportedArchitecture({ platform: "darwin", arch: "x64", arm64: false });
      assert.fail("expected a throw");
    } catch (error) {
      assert.equal(error instanceof UnsupportedArchitectureError, true);
      assert.equal((error as UnsupportedArchitectureError).code, "unsupported-architecture");
      assert.match((error as Error).message, /x64/);
    }
  });

  await t.test("throws for a non-Darwin platform even if arm64 is somehow true", () => {
    assert.throws(
      () => assertSupportedArchitecture({ platform: "linux", arch: "arm64", arm64: true }),
      UnsupportedArchitectureError
    );
  });

  await t.test("names the given platform's arch when refusing", () => {
    try {
      assertSupportedArchitecture({ platform: "win32", arch: "x64", arm64: false });
      assert.fail("expected a throw");
    } catch (error) {
      assert.match((error as Error).message, /x64/);
    }
  });
});
