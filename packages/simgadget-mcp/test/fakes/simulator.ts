/**
 * A fake `Simulator` handle, and the one cast in this package's test suite.
 *
 * ## Why a cast is needed at all
 *
 * `Simulator` is a class with private and protected fields (`deleted`,
 * `recording`, `deps`, …), so **no object literal and no separate class can
 * ever be structurally assignable to it** — TypeScript compares private
 * members by declaration site, not by shape. There is no honest way to write a
 * fake handle without an assertion somewhere.
 *
 * ## Why `as any` is nonetheless the wrong answer
 *
 * The library's fake `idb_companion` is tethered to the real one by the
 * contract checks, because nothing else can notice a fake drifting from a
 * binary somebody else ships. This package's dependency is ours and it is
 * typed, so **the compiler is the tether** — and `as any` cuts it. A fake
 * asserted to `Simulator` wholesale keeps compiling after the library renames
 * a method, changes an argument or changes a return type, and the first thing
 * that notices is a server in front of a user.
 *
 * So the cast is narrowed to one function, `asSimulator`, and the drift
 * detection is bolted back on above it: `SimulatorSurface` is a
 * `Pick<Simulator, …>` over exactly the members `sessions.ts` uses, and
 * `FakeSimulator implements SimulatorSurface`. A changed signature in
 * `simgadget` is then a red `npm run typecheck` here — which is the property
 * the cast would otherwise have thrown away. A *removed* member is red too:
 * `Pick` over a name the class no longer has does not compile.
 *
 * ## Extending this
 *
 * A later step needing another method (`tap`, `screenshot`, `rotate`, …) adds
 * its name to `SimulatorSurface` and an implementation to the class. That is
 * the whole procedure, and it is the reason the surface is a `Pick` list
 * rather than a hand-written interface: the list can only name members the
 * real class actually has.
 */

import type { Simulator, SimulatorState } from "simgadget";
import { SimGadgetError } from "simgadget";

/**
 * Exactly the slice of `Simulator` that `sessions.ts` touches. Kept minimal on
 * purpose — a surface that claims more than the code under test uses is a
 * surface nothing checks.
 */
export type SimulatorSurface = Pick<
  Simulator,
  "udid" | "name" | "state" | "delete" | "releaseCompanion" | "stopRecording"
>;

export interface FakeSimulatorOptions {
  udid?: string;
  name?: string;
  /** What `state()` answers. Defaults to a booted simulator. */
  state?: SimulatorState;
  /** Whether `stopRecording()` finds a recording, or throws the library's
   * `no-active-recording`. Defaults to no recording. */
  recording?: boolean;
  /** Errors to throw from a given method instead of succeeding. The values are
   * thrown as-is, so a test picks the exact shape it wants to exercise. */
  fails?: Partial<Record<"state" | "delete" | "releaseCompanion" | "stopRecording", unknown>>;
}

export class FakeSimulator implements SimulatorSurface {
  readonly udid: string;
  readonly name: string;

  /** Every method called on this handle, in order. Ordering is the assertion
   * for shutdown: a recording must be stopped before the device under it is
   * deleted. */
  readonly calls: string[] = [];

  private readonly stateValue: SimulatorState;
  private readonly fails: FakeSimulatorOptions["fails"];
  private recording: boolean;

  constructor(options: FakeSimulatorOptions = {}) {
    this.udid = options.udid ?? "00000000-0000-0000-0000-000000000000";
    this.name = options.name ?? "fake-sim";
    this.stateValue = options.state ?? "Booted";
    this.recording = options.recording ?? false;
    this.fails = options.fails;
  }

  /** True once `delete()` has succeeded, so a test can tell a deleted handle
   * from a merely released one without reading `calls`. */
  deleted = false;
  /** True once `releaseCompanion()` has succeeded. */
  released = false;

  private record(method: keyof NonNullable<FakeSimulatorOptions["fails"]>): void {
    this.calls.push(method);
    const failure = this.fails?.[method];
    if (failure !== undefined) throw failure;
  }

  async state(): Promise<SimulatorState> {
    this.record("state");
    return this.stateValue;
  }

  async delete(): Promise<void> {
    this.record("delete");
    this.deleted = true;
  }

  async releaseCompanion(): Promise<void> {
    this.record("releaseCompanion");
    this.released = true;
  }

  async stopRecording(): Promise<{ path: string }> {
    this.record("stopRecording");
    if (!this.recording) {
      // The library's own wording and code (simulator.ts:2044). The message is
      // copied so a test can prove the tolerance keys off the code even when
      // the message matches, and off the code even when it does not.
      throw new SimGadgetError(
        "no-active-recording",
        "No recording is in progress for this simulator handle."
      );
    }
    this.recording = false;
    return { path: `/tmp/${this.udid}.mp4` };
  }
}

/**
 * The single cast, at the fake's own boundary.
 *
 * Everything above is checked against the real class; this line is the one
 * place the check is suspended, and it is suspended for a language limitation
 * (private fields) rather than for convenience. Nothing else in the suite may
 * assert a handle's type.
 */
export function asSimulator(fake: FakeSimulator): Simulator {
  return fake as unknown as Simulator;
}
