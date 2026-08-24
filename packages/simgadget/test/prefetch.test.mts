/**
 * The download ladder behind `prefetchCompanion`, driven without a network.
 *
 * `createCompanionResolver` takes the three impure edges — what this machine
 * already has, what the lock file says, and the fetch itself — so everything
 * between them is the real code: the cache layout keyed by content hash, the
 * checksum comparison, `tar`, the chmod, the smoke test, the atomic rename and
 * the scratch cleanup. The fake tarball carries a shell script called
 * `idb_companion`, so even the "prove it runs before letting anything find it"
 * step is exercised rather than stubbed.
 *
 * The one thing not reached from here is `fetchToFile`, which would need a
 * socket to say anything about; `scripts/verify-companion-download.mjs` is
 * where the real download is checked, against the real release.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCompanionResolver,
  prefetchCompanion,
  type CompanionLock,
  type CompanionSource,
} from "../src/idb/companionBinary.ts";
import { CompanionDownloadError } from "../src/errors.ts";
import { resetEnvWarnings } from "../src/env.ts";

/** A tarball with an executable `idb_companion` at its root, and its sha256. */
let artifact: { tarball: string; sha256: string; bytes: number };

before(() => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "simgadget-artifact-"));
  const tree = path.join(scratch, "tree");
  fs.mkdirSync(tree);
  // Something the smoke test can actually run: `download` chmods it 0755 and
  // then asks it for `--version`.
  fs.writeFileSync(
    path.join(tree, "idb_companion"),
    "#!/bin/sh\necho idb_companion 1.1.8\n"
  );
  const tarball = path.join(scratch, "companion.tar.gz");
  execFileSync("tar", ["czf", tarball, "-C", tree, "idb_companion"]);
  const bytes = fs.readFileSync(tarball);
  artifact = {
    tarball,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
});

const IDB_SHA = "9f3a1c2b7d4e5f60718293a4b5c6d7e8f9012345";

function lockFor(sha256: string): CompanionLock {
  return {
    idbSha: IDB_SHA,
    xcode: "16.2",
    swift: "6.0.3",
    arch: "arm64",
    url: "https://example.invalid/idb-companion.tar.gz",
    sha256,
    bytes: 19_000_000,
    builtAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * A source that has nothing locally, so every case goes down the download path
 * whatever the machine running it happens to have installed or vendored.
 */
function sourceFor(
  lock: CompanionLock,
  fetch: CompanionSource["fetch"]
): CompanionSource {
  return { local: () => undefined, readLock: () => lock, fetch };
}

/** Copies the prepared tarball, as a successful fetch would, and reports its sha. */
function fetchesTheArtifact(onCall?: () => void): CompanionSource["fetch"] {
  return async (_url, destination) => {
    onCall?.();
    fs.copyFileSync(artifact.tarball, destination);
    return artifact.sha256;
  };
}

/** Runs `fn` with a private, empty companion cache, removed afterwards. */
async function withCache(fn: (cache: string) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "simgadget-cache-"));
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SIMGADGET_") || key.startsWith("IOS_SIMULATOR_MCP_")) {
        delete process.env[key];
      }
    }
    process.env.SIMGADGET_COMPANION_CACHE = cache;
    resetEnvWarnings();
    await fn(cache);
  } finally {
    process.env = saved;
    resetEnvWarnings();
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

test("the download ladder", async (t) => {
  await t.test("reports what it is fetching and where it landed", async () => {
    await withCache(async (cache) => {
      const lock = lockFor(artifact.sha256);
      const lines: string[] = [];

      const resolve = createCompanionResolver(sourceFor(lock, fetchesTheArtifact()));
      const binary = await resolve((message) => lines.push(message));

      const installDir = path.join(cache, "companion", artifact.sha256);
      assert.equal(binary, path.join(installDir, "idb_companion"));
      // Installed, executable, and the archive's own content -- not a
      // half-extracted tree that happens to have the right name.
      assert.match(fs.readFileSync(binary, "utf-8"), /^#!\/bin\/sh/);
      fs.accessSync(binary, fs.constants.X_OK);

      assert.deepEqual(lines, [
        `Downloading idb_companion (19 MB, idb ${IDB_SHA.slice(0, 7)}). ` +
          `This happens once; it is cached afterwards.`,
        `idb_companion ready at ${installDir}`,
      ]);
    });
  });

  await t.test("a cached companion is answered without fetching again", async () => {
    await withCache(async () => {
      let fetches = 0;
      const lock = lockFor(artifact.sha256);
      const source = sourceFor(
        lock,
        fetchesTheArtifact(() => {
          fetches += 1;
        })
      );

      const first = await createCompanionResolver(source)();
      // A second resolver, so this is the cache on disk answering and not the
      // in-flight dedup below.
      const lines: string[] = [];
      const second = await createCompanionResolver(source)((m) => lines.push(m));

      assert.equal(second, first);
      assert.equal(fetches, 1);
      // Nothing to report when nothing was downloaded.
      assert.deepEqual(lines, []);
    });
  });

  await t.test("concurrent callers share one download", async () => {
    await withCache(async () => {
      let fetches = 0;
      let release = () => {};
      const arrived = new Promise<void>((resolve) => {
        release = resolve;
      });

      const resolve = createCompanionResolver(
        sourceFor(lockFor(artifact.sha256), async (_url, destination) => {
          fetches += 1;
          // Held open until both callers have asked, so a resolver that did not
          // share the promise would have started a second fetch by now.
          await arrived;
          fs.copyFileSync(artifact.tarball, destination);
          return artifact.sha256;
        })
      );

      const both = Promise.all([resolve(), resolve()]);
      release();
      const [a, b] = await both;

      assert.equal(fetches, 1);
      assert.equal(a, b);
    });
  });

  await t.test(
    "a checksum mismatch throws, and leaves nothing behind to be found later",
    async () => {
      await withCache(async (cache) => {
        // The lock claims a hash the artifact does not have: the shape of a
        // corrupted download, and of a published asset that no longer matches
        // the lock file.
        const expected = "0".repeat(64);
        const resolve = createCompanionResolver(
          sourceFor(lockFor(expected), fetchesTheArtifact())
        );

        const error = await resolve().then(
          () => assert.fail("expected the mismatch to throw"),
          (e: unknown) => e
        );

        assert.ok(error instanceof CompanionDownloadError);
        assert.equal(error.code, "companion-download-failed");
        assert.match(error.message, /Checksum mismatch/);
        assert.match(error.message, new RegExp(`expected ${expected}`));
        assert.match(error.message, new RegExp(`actual   ${artifact.sha256}`));

        // Nothing under the content-hash directory, because a partially
        // verified tree there is exactly what a later call would trust.
        assert.equal(fs.existsSync(path.join(cache, "companion")), false);
        // And no scratch left in the cache's tmp root, tarball included.
        assert.deepEqual(fs.readdirSync(path.join(cache, "tmp")), []);
      });
    }
  );

  await t.test("a failed attempt is not cached, so the next call retries", async () => {
    await withCache(async () => {
      let attempt = 0;
      const lock = lockFor(artifact.sha256);
      const resolve = createCompanionResolver({
        local: () => undefined,
        readLock: () => lock,
        fetch: async (_url, destination) => {
          attempt += 1;
          if (attempt === 1) throw new CompanionDownloadError("HTTP 503 downloading it");
          fs.copyFileSync(artifact.tarball, destination);
          return artifact.sha256;
        },
      });

      await assert.rejects(resolve(), CompanionDownloadError);
      // A transient network failure must not poison the resolver for the life
      // of the process.
      assert.match(await resolve(), /idb_companion$/);
      assert.equal(attempt, 2);
    });
  });
});

test("prefetchCompanion", async (t) => {
  await t.test("answers with the companion an override names", async () => {
    // The one path through the *real* resolver a test can take without a
    // network: `SIMGADGET_COMPANION_PATH` short-circuits everything below it,
    // and this file is as good an executable as any. The lines the callback
    // would receive are the ladder's, and are asserted above; there is nothing
    // to report when nothing is downloaded.
    const saved = { ...process.env };
    const lines: string[] = [];
    try {
      process.env.SIMGADGET_COMPANION_PATH = process.execPath;
      resetEnvWarnings();
      assert.equal(await prefetchCompanion((m) => lines.push(m)), process.execPath);
      assert.deepEqual(lines, []);
    } finally {
      process.env = saved;
      resetEnvWarnings();
    }
  });
});
