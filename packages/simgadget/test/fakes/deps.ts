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
 * they may need to `.kill()` (`waitForBootStatus`'s `simctl bootstatus`,
 * `startRecording`'s `simctl io recordVideo`). Never actually spawns anything;
 * a test drives the child itself with `emitStderr`, `emitExit` and `emitClose`.
 *
 * `signals` rather than only `killed`, because **which** signal was sent is the
 * whole assertion for a recording: `SIGINT` is what lets `simctl io recordVideo`
 * finalize the file, and a `SIGKILL` leaves a file that exists, has a plausible
 * size and will not play. A boolean cannot tell those apart.
 */
export class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  /** Every signal `kill()` was called with, in order; `undefined` for a bare
   * `kill()`, which is Node's `SIGTERM`. */
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  /** The child's stderr. A real `ChildProcess` types this as nullable and the
   * code under test reads it as such, so a fake that always has one is the
   * easy case rather than a cheat. */
  readonly stderr = new EventEmitter();

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }

  /** Simulates the child exiting, for a test that wants `waitForBootStatus`
   * to resolve via the process instead of via the timeout race. */
  emitExit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code);
  }

  /**
   * Simulates the child's stdio closing. Separate from `emitExit` because a
   * real child emits `exit` and then `close`, and the two consumers in this
   * package listen for different ones — `waitForBootStatus` for `exit`, the
   * recording's start protocol for `close`.
   */
  emitClose(code = 0): void {
    this.exitCode = code;
    this.emit("close", code);
  }

  /** One chunk on stderr, which is where `simctl io` says everything it says. */
  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }
}

/**
 * A child that exits on the next turn of the event loop, as `simctl bootstatus
 * -b` does against a device that has already finished booting.
 *
 * Asynchronous on purpose: a real `ChildProcess` cannot emit before its caller
 * has attached listeners, and a fake that exited synchronously inside `spawn()`
 * would let code with no `exit` listener at all pass.
 */
export function childThatExits(code = 0): FakeChildProcess {
  const child = new FakeChildProcess();
  setImmediate(() => child.emitExit(code));
  return child;
}

/** One armed `setTimer`, as the fake records it. */
export interface FakeTimer {
  ms: number;
  cancelled: boolean;
  /** Runs the callback, unless it was already cancelled or already fired. */
  fire(): void;
}

export interface FakeDepsCalls {
  run: RunCall[];
  spawn: RunCall[];
  sleep: number[];
  /**
   * Every `setTimer` a test armed, in order, with whether it was cancelled and
   * a `fire()` to run it on demand.
   *
   * A test asserts two different things here and needs both. `fire()` drives
   * the fallback path — a recording that never announces itself — in
   * microseconds. `cancelled` proves the *other* path: that a timer which lost
   * its race was actually called off, which is what stops a pending
   * `setTimeout` adding a silent three-second tail to a short script's exit.
   */
  timers: FakeTimer[];
  withClient: string[];
  /**
   * The udid of every `withClient` call that asked for the **exclusive** lock,
   * in order. Input is what takes it — a multi-tap interleaved with another
   * caller's touches is two unrelated single taps, and a string typed through
   * someone else's tap is a different string — so a test proving "two taps
   * within one exclusive lock" needs to count the locks, not just the taps.
   * Reads never appear here.
   */
  withClientExclusive: string[];
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
   * `createFakeIdbClient(...)` from `./idb.ts`. Anything shaped like the slice
   * of `IdbClient` the code under test calls will do; only
   * `accessibilityInfo` is required, because a test that never rotates has no
   * reason to model `setOrientation`. Defaults to one whose
   * `accessibilityInfo()` always rejects, i.e. "never becomes driveable" — the
   * common case for a boot-ladder timeout test. */
  client?: {
    accessibilityInfo(query: unknown): Promise<unknown>;
    describe?(): Promise<unknown>;
    setOrientation?(orientation: number): Promise<void>;
    activate?(marker: string, matchKey: number): Promise<void>;
    tap?(x: number, y: number, duration?: number): Promise<void>;
    typeText?(text: string): Promise<void>;
    swipe?(
      start: { x: number; y: number },
      end: { x: number; y: number },
      options?: { delta?: number; duration?: number }
    ): Promise<void>;
    pressButton?(button: number, duration?: number): Promise<void>;
  };
  /** A registry to share between two handles on one udid, for a test about
   * exactly that. Defaults to a fresh one, which is what every other test
   * wants. */
  recovery?: RecoveryRegistry;
  /**
   * Makes `withClient` reject with this **before** running the callback, the
   * way `CompanionManager` does when a companion exits during startup.
   *
   * Set rather than throwing from the fake client because the two are
   * different failures wearing the same shape: a client method that rejects
   * says the companion answered and refused, and this says there was never a
   * companion to ask. A simulator deleted underneath a live handle produces
   * the second — the companion cannot resolve a target that no longer
   * exists — and the callback never running is the observable difference.
   */
  companionStartFailure?: Error;
  /**
   * Fake `spawn()` results, keyed the same way `run` calls are logged
   * ("cmd arg1 arg2"). Falls back to a `FakeChildProcess` that exits on the
   * next turn of the event loop, which is what `simctl bootstatus -b` does
   * against an already-booted device — the common case, and the one an
   * uncancelled cap timer used to charge 30s for.
   *
   * A test that wants the *other* side of that race — a child still running
   * when the cap fires — overrides this with a child that never exits and
   * fires `calls.timers[0]` itself.
   */
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
    timers: [],
    withClient: [],
    withClientExclusive: [],
    closeCompanion: [],
    reopenCompanion: [],
    shutdownCompanion: [],
    order: [],
  };

  // Read out here because `withClient`'s own `options` parameter shadows this
  // function's.
  const startFailure = options.companionStartFailure;

  const runHandler: RunHandler = options.run ?? (() => ({ stdout: "", stderr: "" }));
  const client = options.client ?? {
    accessibilityInfo: () => Promise.reject(new Error("fake: simulator not answering yet")),
  };

  /**
   * The client, with every method call logged into `calls.order` as
   * `client:<method>`.
   *
   * `withClient` alone cannot say *what* was asked of the companion — every
   * call through it logs the same `withClient:<udid>` — so a test about
   * ordering between a companion call and a dep call ("`rotate` settles after
   * sending the orientation and before reading the tree") has nothing to assert
   * on. The client's own logs (`FakeIdbClient.calls`) order companion calls
   * against each other but cannot interleave with `sleep`. This is the one
   * place both are visible in a single sequence.
   *
   * Bound to `target` rather than to the proxy so a fake client's own private
   * state is reached directly, as it would be without the proxy in the way.
   */
  const loggedClient = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.order.push(`client:${String(property)}`);
        return value.apply(target, args);
      };
    },
  });

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
      const child = options.spawn?.(cmd, args) ?? childThatExits();
      return child as unknown as ChildProcess;
    },
    async withClient(udid, fn, options) {
      calls.withClient.push(udid);
      // The exclusive flag is part of the order log, not only of its own array,
      // so a test can see where the lock opened relative to the client calls
      // made inside it. A plain read still logs `withClient:<udid>` exactly as
      // before, which is what the existing ordering tests look for.
      if (options?.exclusive) calls.withClientExclusive.push(udid);
      calls.order.push(`withClient:${udid}${options?.exclusive ? " exclusive" : ""}`);
      if (startFailure) throw startFailure;
      return fn(loggedClient as unknown as Parameters<typeof fn>[0]);
    },
    async sleep(ms) {
      calls.sleep.push(ms);
      calls.order.push(`sleep:${ms}`);
      await clock.sleep(ms);
    },
    setTimer(ms: number, fn: () => void): () => void {
      calls.order.push(`setTimer:${ms}`);
      let done = false;
      const timer: FakeTimer = {
        ms,
        cancelled: false,
        fire() {
          if (done || timer.cancelled) return;
          done = true;
          fn();
        },
      };
      calls.timers.push(timer);
      return () => {
        if (done) return;
        timer.cancelled = true;
      };
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
