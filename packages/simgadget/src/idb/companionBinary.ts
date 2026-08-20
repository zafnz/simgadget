/**
 * Resolves the `idb_companion` binary this server runs.
 *
 * The companion is downloaded once from a URL and hash pinned in
 * `companion.lock.json`, then cached. There is deliberately no discovery: no
 * GitHub API call, no version negotiation, no `$PATH` lookup. A pinned URL and
 * a pinned hash cannot drift, rate-limit, or quietly hand us a different build.
 *
 * Falling back to a companion on `$PATH` would be worse than failing. Protobuf
 * compatibility means an older companion does not reject fields it does not
 * understand — it ignores them and answers anyway. A `marker` lookup against
 * the 2022 build returns the whole tree instead of the element asked for, and
 * `keys` returns everything. The result is wrong but entirely plausible, which
 * is the failure mode this design exists to avoid.
 */

import { execFile, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import http from "http";
import os from "os";
import path from "path";
import { promisify } from "util";
import { IdbError } from "./client.ts";
import { assertIdbPathUnset, readEnv } from "../env.ts";
import { CompanionDownloadError, UnsupportedArchitectureError } from "../errors.ts";

const execFileAsync = promisify(execFile);

export type CompanionLock = {
  idbSha: string;
  xcode: string;
  swift: string;
  arch: string;
  url: string;
  sha256: string;
  bytes: number;
  builtAt: string;
};

/** Redirect hops to follow. Release URLs bounce to a storage host. */
const MAX_REDIRECTS = 5;

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * True on Apple Silicon, including an x64 Node running under Rosetta.
 *
 * `process.arch` describes the Node build, not the machine: it reads "x64"
 * under Rosetta on a machine that runs arm64 binaries perfectly well. Gating on
 * it would refuse working Macs.
 */
function isAppleSilicon(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("sysctl", ["-n", "hw.optional.arm64"], {
    encoding: "utf-8",
  });
  return probe.status === 0 && probe.stdout.trim() === "1";
}

/**
 * The pure decision behind the arch gate: Apple Silicon only, checked at
 * resolve time so the failure is an explicit error naming the arch rather
 * than a gRPC timeout thirty seconds later once a companion never starts.
 * `platform`/`arm64` are passed in — not read from `process` here — so a
 * test can drive every combination without touching `sysctl`; the impure
 * probe (`isAppleSilicon`, see its comment for why `process.arch` alone
 * cannot be trusted) stays at the call site.
 */
export function assertSupportedArchitecture(input: {
  platform: NodeJS.Platform;
  arch: string;
  arm64: boolean;
}): void {
  if (input.platform === "darwin" && input.arm64) return;
  throw new UnsupportedArchitectureError(input.arch);
}

/** Where downloaded companions live. Ours alone; never `/usr/local/bin`. */
export function cacheRoot(): string {
  const override = readEnv("COMPANION_CACHE");
  if (override) return expandTilde(override);
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "simgadget");
  }
  return path.join(os.homedir(), "Library", "Caches", "simgadget");
}

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The package root, from the compiled build/idb/companionBinary.js. */
function packageRoot(): string {
  return path.join(__dirname, "..", "..");
}

/**
 * Walks up from `start` looking for `vendor/idb/Build/Distribution/idb_companion`,
 * stopping at the filesystem root. `packageRoot()` is `packages/simgadget`
 * (still right for `companion.lock.json`, which ships alongside it), but the
 * vendored submodule lives two levels further up at the repo root — and an
 * installed package has no vendor directory at any level, so the walk must
 * give up rather than loop forever. `exists` is injected so a test can drive
 * the walk without touching the filesystem.
 */
export function findVendorCompanion(
  start: string,
  exists: (candidate: string) => boolean = fs.existsSync
): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "vendor", "idb", "Build", "Distribution", "idb_companion");
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A companion built from the vendored submodule, if there is one.
 *
 * This is the developer path: `cd vendor/idb && ./build.sh build` leaves its
 * output here, and it is exactly the sha the submodule is pinned to, so it is
 * the same binary the lock file would fetch. Absent in an installed package,
 * which has no vendor directory.
 */
function locallyBuiltCompanion(): string | undefined {
  const found = findVendorCompanion(packageRoot());
  return found && isUsable(found) ? found : undefined;
}

/**
 * Reads the lock file shipped alongside the compiled server.
 *
 * Both failures are `CompanionDownloadError`: the lock file is the thing a
 * download is made from, so a missing or unreadable one is the download path
 * failing before it reaches the network, and the caller's remedy — point
 * `SIMGADGET_COMPANION_PATH` at a binary — is the same either way. They were
 * `IdbError`s, which no caller could branch on because it is not exported.
 *
 * `lockPath` is injected the way `findVendorCompanion`'s `exists` is, and for
 * the same reason: the shipped lock file is always present in this repository,
 * so neither failure is reachable in a test without it.
 */
export function readLock(
  lockPath: string = path.join(packageRoot(), "companion.lock.json")
): CompanionLock {
  if (!fs.existsSync(lockPath)) {
    throw new CompanionDownloadError(
      `no companion.lock.json at ${lockPath}`,
      `No companion.lock.json found at ${lockPath}, so there is no pinned ` +
        `idb_companion to download. Point SIMGADGET_COMPANION_PATH at ` +
        `an idb_companion binary, or build one with the build-companion workflow.`
    );
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as CompanionLock;
  } catch (error) {
    throw new CompanionDownloadError(
      `unreadable companion.lock.json at ${lockPath}`,
      `companion.lock.json at ${lockPath} is not readable JSON: ${(error as Error).message}`
    );
  }
}

/**
 * A companion this machine already has: the `SIMGADGET_COMPANION_PATH`
 * override, or a build from the pinned submodule. `undefined` when one has to
 * be downloaded — and a throw when the machine cannot run one at all, because
 * the arch gate belongs between those two: an override is honoured on any
 * machine (that is what it is for), and everything below it is an arm64 binary.
 *
 * Checked at resolve time rather than at import: a library that throws on
 * import merely for a stray environment variable is hostile to anyone who
 * imported it for an unrelated reason.
 */
function localCompanion(log: (message: string) => void): string | undefined {
  assertIdbPathUnset();

  const override = readEnv("COMPANION_PATH");
  if (override) {
    const expanded = expandTilde(override);
    if (!fs.existsSync(expanded)) {
      // Deliberately still an untyped `IdbError` (TODO #82). Nothing in the
      // frozen `ErrorCode` union is honest about it: no download was wanted —
      // avoiding one is what the override is for — and nothing was spawned, so
      // neither companion code fits. A caller reads the message, and the
      // message is the whole remedy. Giving it a code means adding one, which
      // is a spec change rather than a tidy-up.
      throw new IdbError(
        `SIMGADGET_COMPANION_PATH points at a file that does not exist: ${expanded}`
      );
    }
    return expanded;
  }

  assertSupportedArchitecture({
    platform: process.platform,
    arch: process.arch,
    arm64: isAppleSilicon(),
  });

  // Prefer a companion built from the pinned submodule over downloading one.
  // It is the same sha, so this is not a compatibility compromise -- it just
  // saves a developer who has already built it from fetching it again.
  const local = locallyBuiltCompanion();
  if (local) {
    log(`Using locally built idb_companion from ${path.relative(packageRoot(), local)}`);
    return local;
  }

  return undefined;
}

/**
 * The impure edges of resolution, injected so the download ladder can be driven
 * without a network.
 *
 * All three, not just the fetch: a test that faked only the network would still
 * be answered by whatever the machine running it happens to have — a vendored
 * build short-circuits the download entirely, and the real lock file names a
 * URL on the internet. Faking the edges is what makes these tests say the same
 * thing on every machine.
 *
 * @internal Not part of the published surface; `index.ts` exports neither this
 * nor the resolver factory below.
 */
export interface CompanionSource {
  /** A companion this machine already has; see `localCompanion`. */
  local: (log: (message: string) => void) => string | undefined;
  /** The pinned artifact to fetch when it does not. */
  readLock: () => CompanionLock;
  /** Streams `url` to `destination`, returning its sha256. */
  fetch: (url: string, destination: string) => Promise<string>;
}

const realSource: CompanionSource = {
  local: localCompanion,
  readLock,
  fetch: fetchToFile,
};

/**
 * A resolver, with its own in-flight dedup.
 *
 * One per process in production — `resolveCompanion` below — because sharing
 * the in-flight promise is the whole point of it: several simulators starting
 * at once must wait on one download, not four. It is a factory rather than
 * module-level state so that a test gets a resolver of its own, where a
 * previous case's cached result cannot decide the next case's outcome.
 *
 * @internal
 */
export function createCompanionResolver(
  source: CompanionSource = realSource
): (log?: (message: string) => void) => Promise<string> {
  let pending: Promise<string> | undefined;

  const resolve = (log: (message: string) => void = () => {}): Promise<string> => {
    if (!pending) {
      pending = resolveOnce(source, log).catch((error) => {
        // Don't cache a failure: a transient network error should not poison
        // the process for its whole life.
        pending = undefined;
        throw error;
      });
    }
    // Nor should a success outlive the file it points at. Clearing the cache is
    // advice we give in an error message, so a long-running server must notice
    // the binary has gone and fetch it again rather than handing out a path
    // that no longer exists until it is restarted.
    return pending.then((binary) => {
      if (isUsable(binary)) return binary;
      pending = undefined;
      return resolve(log);
    });
  };

  return resolve;
}

/**
 * Absolute path to a usable `idb_companion`, downloading it if necessary.
 *
 * Call this lazily, on the first request that actually needs a companion —
 * never at startup — so listing tools or driving simctl never pays for a
 * download.
 */
export const resolveCompanion = createCompanionResolver();

/**
 * Resolves the pinned `idb_companion`, downloading it if it is not already
 * cached, and answers with its absolute path.
 *
 * The public name for what every other call does lazily on its way to a
 * simulator. It exists so a CI image or a provisioning script can front-run the
 * ~19 MB first-call download, at a moment when a slow step is expected, rather
 * than have it land inside the first test that touches a device. Also reachable
 * as `npx simgadget prefetch` (`../cli.ts`).
 *
 * `onProgress` is called with the same lines the resolution would otherwise log
 * to nobody: which artifact is being fetched, and where it ended up. Safe to
 * call repeatedly and from several places at once — concurrent callers share
 * one download, and a cached companion is a couple of `stat` calls.
 */
export function prefetchCompanion(
  onProgress?: (message: string) => void
): Promise<string> {
  return resolveCompanion(onProgress);
}

async function resolveOnce(
  source: CompanionSource,
  log: (message: string) => void
): Promise<string> {
  const local = source.local(log);
  if (local) return local;

  const lock = source.readLock();
  // Keyed by content hash, not version, so a changed lock is simply a different
  // directory. Rollback and multi-version coexistence come free, and a
  // half-written tree can never be mistaken for a complete one.
  const installDir = path.join(cacheRoot(), "companion", lock.sha256);
  const binary = path.join(installDir, "idb_companion");

  if (isUsable(binary)) return binary;

  await download(source, lock, installDir, log);

  if (!isUsable(binary)) {
    throw new CompanionDownloadError(
      `downloaded companion is missing or not executable at ${binary}`
    );
  }
  return binary;
}

function isUsable(binary: string): boolean {
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function download(
  source: CompanionSource,
  lock: CompanionLock,
  installDir: string,
  log: (message: string) => void
): Promise<void> {
  const tmpRoot = path.join(cacheRoot(), "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(tmpRoot, "companion-"));
  const tarball = path.join(scratch, "companion.tar.gz");

  const megabytes = (lock.bytes / 1_000_000).toFixed(0);
  log(
    `Downloading idb_companion (${megabytes} MB, idb ${lock.idbSha.slice(0, 7)}). ` +
      `This happens once; it is cached afterwards.`
  );

  try {
    const actualSha = await source.fetch(lock.url, tarball);
    if (actualSha !== lock.sha256) {
      throw new CompanionDownloadError(
        `checksum mismatch for ${lock.url}`,
        `Checksum mismatch for ${lock.url}\n` +
          `  expected ${lock.sha256}\n` +
          `  actual   ${actualSha}\n` +
          `Refusing to run it. The download was corrupted, or the published ` +
          `artifact does not match companion.lock.json.`
      );
    }

    const extracted = path.join(scratch, "tree");
    fs.mkdirSync(extracted, { recursive: true });
    try {
      await execFileAsync("tar", ["xzf", tarball, "-C", extracted]);
    } catch (error) {
      throw new CompanionDownloadError(
        `could not extract archive from ${lock.url}: ${(error as Error).message}`
      );
    }
    fs.unlinkSync(tarball);

    const binary = path.join(extracted, "idb_companion");
    if (!fs.existsSync(binary)) {
      throw new CompanionDownloadError(
        `the archive at ${lock.url} does not contain idb_companion at its root`
      );
    }
    fs.chmodSync(binary, 0o755);

    // Prove it runs before letting anything else find it in the cache. A
    // companion that cannot start should fail here, once, with a clear message
    // rather than on every later call.
    await smokeTest(binary);

    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    try {
      // Atomic: nothing ever observes a partially extracted tree under
      // installDir. Two processes may race here; one wins the rename and the
      // loser finds a complete, verified tree already in place.
      fs.renameSync(extracted, installDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const lostRace = code === "ENOTEMPTY" || code === "EEXIST";
      if (!lostRace || !isUsable(path.join(installDir, "idb_companion"))) {
        throw error;
      }
    }
    log(`idb_companion ready at ${installDir}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function smokeTest(binary: string): Promise<void> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 30_000 });
  } catch (error) {
    const detail = (error as Error).message;
    throw new CompanionDownloadError(
      `downloaded companion could not run: ${detail}`,
      `The downloaded idb_companion could not run: ${detail}\n` +
        `If macOS blocked it, check for a quarantine attribute with ` +
        `\`xattr -l ${binary}\`; \`xattr -dr com.apple.quarantine ${binary}\` clears it.`
    );
  }
}

/** Streams `url` to `destination`, following redirects. Returns its sha256. */
function fetchToFile(url: string, destination: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const file = fs.createWriteStream(destination);
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      reject(
        error instanceof CompanionDownloadError
          ? error
          : new CompanionDownloadError(error.message)
      );
    };

    const get = (target: string, redirectsLeft: number) => {
      // A malformed Location, or one with a protocol we cannot speak, must
      // reject rather than throw: this runs inside a response handler, where an
      // exception escapes the promise entirely and takes the process with it.
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        fail(new CompanionDownloadError(`not a valid URL: ${target}`));
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        fail(
          new CompanionDownloadError(
            `refusing to fetch ${target}: only http and https are supported`
          )
        );
        return;
      }

      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(
        target,
        { headers: { "user-agent": "simgadget" } },
        (response) => {
          const status = response.statusCode ?? 0;

          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirectsLeft === 0) {
              fail(new CompanionDownloadError(`too many redirects fetching ${url}`));
              return;
            }
            let next: string;
            try {
              next = new URL(response.headers.location, target).toString();
            } catch {
              fail(
                new CompanionDownloadError(
                  `server redirected ${target} to an unusable location: ${response.headers.location}`
                )
              );
              return;
            }
            get(next, redirectsLeft - 1);
            return;
          }

          if (status !== 200) {
            response.resume();
            fail(
              new CompanionDownloadError(
                `HTTP ${status} downloading ${url}`,
                `Downloading ${url} failed with HTTP ${status}. The release asset ` +
                  `named in companion.lock.json may have been moved or deleted.`
              )
            );
            return;
          }

          response.on("data", (chunk: Buffer) => hash.update(chunk));
          response.pipe(file);
          response.on("error", fail);
          file.on("error", fail);
          file.on("finish", () => {
            if (settled) return;
            settled = true;
            resolve(hash.digest("hex"));
          });
        }
      );

      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy();
        fail(new CompanionDownloadError(`timed out downloading ${url}`));
      });
      request.on("error", fail);
    };

    get(url, MAX_REDIRECTS);
  });
}
