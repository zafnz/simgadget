/**
 * The `Simulator` handle — SIMGADGET.md, "The `Simulator` handle".
 *
 * This file currently holds only the shell needed for `lifecycle.ts`
 * (SIMGADGET_PLAN.md step 2) to compile and return a real `Promise<Simulator>`
 * from `createSimulator`/`attachSimulator`: the `udid`, `name` and `lastBoot`
 * fields from the spec, and the internal constructor. Everything else —
 * `state()`, `boot()`, `waitReady()`, `shutdown()`, `delete()`, `installApp`,
 * `launchApp`, `describeScreen`, `findByLabel`, `tap`, `rotate`, `screenshot`,
 * the udid-keyed recovery registry, and so on — arrives in later plan steps
 * (2b through 8). Do not add methods here for step 2; extend this class in
 * the step that owns them instead.
 */

import type { ReadyResult } from "./lifecycle.ts";
import type { SimulatorDeps } from "./internal/deps.ts";

export class Simulator {
  readonly udid: string;
  readonly name: string;

  private _lastBoot?: ReadyResult;

  /** How the last boot/waitReady went; set by createSimulator, boot() and
   * waitReady(). Undefined on a fresh attach. Exposed as a getter (no public
   * setter) so it reads as read-only to every caller outside this class,
   * while `_recordBoot` below still gives the lifecycle procedures that
   * construct or ready a handle somewhere to write the result — a plain
   * `readonly` field cannot be assigned outside the constructor that declares
   * it, and `createSimulator`'s boot ladder finishes well after that. */
  get lastBoot(): ReadyResult | undefined {
    return this._lastBoot;
  }

  /** @internal Everything future methods on this class reach the outside
   * world through. */
  protected readonly deps: SimulatorDeps;

  /**
   * @internal Constructed only by `createSimulator`/`attachSimulator` in
   * `lifecycle.ts` (via `HandleFactory`), never directly by a library user —
   * `index.ts`'s exports make the class name resolvable but nothing stops a
   * caller from writing `new Simulator(...)` themselves, so this is a
   * documentation boundary, not an enforced one.
   */
  constructor(udid: string, name: string, deps: SimulatorDeps) {
    this.udid = udid;
    this.name = name;
    this.deps = deps;
  }

  /**
   * @internal Lets `lifecycle.ts` record the outcome of the boot that created
   * this handle, once it is known — after the constructor has already run,
   * so it cannot go through the constructor itself. Not part of the public
   * API surface (`index.ts` re-exports the class, not this method); later
   * steps' `boot()`/`waitReady()` call this too.
   */
  _recordBoot(result: ReadyResult): void {
    this._lastBoot = result;
  }
}
