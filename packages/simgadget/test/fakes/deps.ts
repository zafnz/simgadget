/**
 * A fake `SimulatorDeps` for the fake-client test layer
 * (SIMGADGET_PLAN.md, "Testing: three layers"). The shared home every later
 * step extends rather than building a second one: script `run()` results per
 * command, script `withClient()`'s answers (accessibility reads, failures),
 * and drive time through `clock` instead of waiting out a real rotation
 * settle or recovery cooldown. `closeCompanion`/`reopenCompanion`/
 * `shutdownCompanion` just record that they were called (DECISIONS.md #19 —
 * they exist on the seam so a test can observe the call, not because the
 * fake needs to model `CompanionManager`'s actual blocking behaviour).
 * `calls.order` logs every call across every kind, in the order it happened,
 * for a test that needs to assert ordering rather than just occurrence —
 * e.g. `Simulator.delete()` closing the companion before any simctl call.
 *
 * The tether rule (SIMGADGET_PLAN.md) binds what a fake *`IdbClient`* may
 * claim a real companion does. This file still does not implement one: the
 * `client` option takes any object shaped like the slice of `IdbClient` the
 * code under test calls, and the scriptable fake that models the companion's
 * three read shapes lives next door in `./idb.ts`, where every belief it
 * encodes is listed against the contract check that pins it.
 *
 * `recovery` is a **fresh `RecoveryRegistry` per fake** rather than the
 * process-level singleton (DECISIONS.md #21). Sharing it would let one case's
 * `markAnswered` decide whether the next case's simulator is even eligible for
 * a bridge restart — a leak that shows up as a test that passes alone and
 * fails in the suite.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SimulatorDeps } from "../../src/internal/deps.ts";
import { RecoveryRegistry } from "../../src/internal/registry.ts";

export interface RunCall {
  cmd: string;
  args: string[];
}

export type RunResult = { stdout: string; stderr: string };
export type RunHandler = (cmd: string, args: string[]) => RunResult | Promise<RunResult>;

/**
 * A fake clock `now()`/`sleep()` share, so a test can assert timing-dependent
 * behaviour (the boot budget, a recovery cooldown, the rotation settle)
 * without spending real wall-clock time on it. `sleep(ms)` advances the clock
 * by exactly `ms` and resolves on the next microtask — not "immediately and
 * synchronously" — so code that chains several `await deps.sleep(...)` calls
 * still yields between them the way it would in production.
 */
export class FakeClock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.current += ms;
    await Promise.resolve();
  }

  /** For a test that wants to move time without going through `sleep()`. */
  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * A `ChildProcess`-shaped `EventEmitter`, for deps that `spawn()` a process
 * they may need to `.kill()` (`waitForBootStatus`'s `simctl bootstatus`).
 * Never actually spawns anything; a test fires `.emitExit()` itself to
 * simulate the child finishing.
 */
export class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Simulates the child exiting, for a test that wants `waitForBootStatus`
   * to resolve via the process instead of via the timeout race. */
  emitExit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

export interface FakeDepsCalls {
  run: RunCall[];
  spawn: RunCall[];
  sleep: number[];
  withClient: string[];
  closeCompanion: string[];
  reopenCompanion: string[];
  shutdownCompanion: string[];
  /**
   * Every logged call, in the order it actually happened, as
   * `"<kind>:<detail>"` — e.g. `"closeCompanion:UDID"`,
   * `"run:xcrun simctl shutdown UDID"`. The per-kind arrays above are for
   * filtering by call type; this is for a test that needs to assert
   * *ordering* across kinds, such as `delete()`'s "close the companion
   * before any simctl call" contract, which no per-kind array alone can
   * prove.
   */
  order: string[];
}

export interface FakeDepsOptions {
  /** Answers `run()`. Defaults to `{stdout: "", stderr: ""}` for anything not
   * explicitly handled, so a test only has to script the calls it cares
   * about. */
  run?: RunHandler;
  /** Answers `withClient()`'s callback with this fake client — usually
   * `createFakeIdbClient(...)` from `./idb.ts`. Defaults to one whose
   * `accessibilityInfo()` always rejects, i.e. "never becomes driveable" — the
   * common case for a boot-ladder timeout test. */
  client?: { accessibilityInfo: (query: unknown) => Promise<unknown> };
  /** A registry to share between two handles on one udid, for a test about
   * exactly that. Defaults to a fresh one, which is what every other test
   * wants. */
  recovery?: RecoveryRegistry;
  /** Fake `spawn()` results, keyed the same way `run` calls are logged
   * ("cmd arg1 arg2"). Falls back to a `FakeChildProcess` that never exits on
   * its own, so `waitForBootStatus` resolves via the `capMs` sleep race. */
  spawn?: (cmd: string, args: string[]) => FakeChildProcess;
  clock?: FakeClock;
}

/** Joins a command and its args into one lookup key for `run`/`spawn` maps. */
export function commandKey(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

export interface FakeDeps extends SimulatorDeps {
  calls: FakeDepsCalls;
  clock: FakeClock;
}

export function createFakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const clock = options.clock ?? new FakeClock();
  const calls: FakeDepsCalls = {
    run: [],
    spawn: [],
    sleep: [],
    withClient: [],
    closeCompanion: [],
    reopenCompanion: [],
    shutdownCompanion: [],
    order: [],
  };

  const runHandler: RunHandler = options.run ?? (() => ({ stdout: "", stderr: "" }));
  const client = options.client ?? {
    accessibilityInfo: () => Promise.reject(new Error("fake: simulator not answering yet")),
  };

  return {
    calls,
    clock,
    recovery: options.recovery ?? new RecoveryRegistry(),
    async run(cmd, args) {
      calls.run.push({ cmd, args });
      calls.order.push(`run:${commandKey(cmd, args)}`);
      return runHandler(cmd, args);
    },
    spawn(cmd, args) {
      calls.spawn.push({ cmd, args });
      calls.order.push(`spawn:${commandKey(cmd, args)}`);
      const child = options.spawn?.(cmd, args) ?? new FakeChildProcess();
      return child as unknown as ChildProcess;
    },
    async withClient(udid, fn) {
      calls.withClient.push(udid);
      calls.order.push(`withClient:${udid}`);
      return fn(client as unknown as Parameters<typeof fn>[0]);
    },
    async sleep(ms) {
      calls.sleep.push(ms);
      calls.order.push(`sleep:${ms}`);
      await clock.sleep(ms);
    },
    now() {
      return clock.now();
    },
    async closeCompanion(udid) {
      calls.closeCompanion.push(udid);
      calls.order.push(`closeCompanion:${udid}`);
    },
    reopenCompanion(udid) {
      calls.reopenCompanion.push(udid);
      calls.order.push(`reopenCompanion:${udid}`);
    },
    async shutdownCompanion(udid) {
      calls.shutdownCompanion.push(udid);
      calls.order.push(`shutdownCompanion:${udid}`);
    },
  };
}
