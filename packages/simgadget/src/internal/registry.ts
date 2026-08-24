/**
 * Recovery state, keyed by simulator udid rather than by handle.
 *
 * SIMGADGET.md's Decisions register ("Recovery state is udid-keyed, not
 * per-handle") and DECISIONS.md #9: `hasAnsweredAccessibility`, the recovery
 * cooldown timestamp and the in-flight recovery dedup are facts about a
 * *simulator*, not about a `Simulator` handle. Handles are deliberately not
 * deduplicated per udid (recording state and the orientation hint are
 * per-handle, and the MCP's sessions depend on that), but two handles on one
 * udid must still share one recovery attempt — "a wedge looks like several
 * things failing at once" is the reason the dedup exists, and per-handle
 * copies of this state would lose it.
 *
 * A process-level singleton, parallel to `companions` in
 * `../idb/companionManager.ts` for the same reason: state describing a
 * simulator, not a request or a handle, must be shared by everything that
 * touches that udid.
 *
 * **This file holds the state and nothing that decides on it.** It owns the
 * container, `markAnswered`/`hasAnswered` and `forget` — `forget` is what
 * `Simulator.delete()` needs (today's `forgetSimulator`, index.ts:888), and
 * `markAnswered` is wired from `lifecycle.ts`'s `waitUntilDriveable`, which
 * records the plain fact that a real frame came back (DECISIONS.md #18). The
 * cooldown timestamp and the in-flight promise are declared here and read in
 * `../simulator.ts`: `shouldRecover`'s wiring, the dedup and the cure ladder
 * all live there, and nothing in this file computes a cooldown or launches a
 * recovery.
 *
 * Everything that reads this registry reaches it through
 * `SimulatorDeps.recovery` rather than through the singleton below — see
 * DECISIONS.md #21 for why a test must never share it.
 */

export interface RecoveryEntry {
  /** Has this simulator ever served a usable accessibility read? Read by
   * step 3's `shouldRecover` gate ("never recover a simulator that has not
   * answered yet") — a device that has never answered is booting, not
   * broken, and the boot ladder already owns that case with its own budget. */
  hasAnswered: boolean;
  /** `deps.now()` at the last bridge restart, for step 3's cooldown
   * comparison. `undefined` until the first attempt. */
  lastRecoveryAt: number | undefined;
  /** The in-flight recovery attempt, if one is running, so concurrent
   * failures for one udid share it rather than each ordering their own
   * bridge restart — step 3. */
  recoveryInFlight: Promise<boolean> | undefined;
}

function emptyEntry(): RecoveryEntry {
  return { hasAnswered: false, lastRecoveryAt: undefined, recoveryInFlight: undefined };
}

export class RecoveryRegistry {
  private entries = new Map<string, RecoveryEntry>();

  private entry(udid: string): RecoveryEntry {
    let existing = this.entries.get(udid);
    if (!existing) {
      existing = emptyEntry();
      this.entries.set(udid, existing);
    }
    return existing;
  }

  hasAnswered(udid: string): boolean {
    return this.entries.get(udid)?.hasAnswered ?? false;
  }

  markAnswered(udid: string): void {
    this.entry(udid).hasAnswered = true;
  }

  lastRecoveryAt(udid: string): number | undefined {
    return this.entries.get(udid)?.lastRecoveryAt;
  }

  setLastRecoveryAt(udid: string, at: number): void {
    this.entry(udid).lastRecoveryAt = at;
  }

  recoveryInFlight(udid: string): Promise<boolean> | undefined {
    return this.entries.get(udid)?.recoveryInFlight;
  }

  setRecoveryInFlight(udid: string, promise: Promise<boolean> | undefined): void {
    this.entry(udid).recoveryInFlight = promise;
  }

  /** Clears every fact this registry holds about `udid` — today's
   * `forgetSimulator` (index.ts:888). Called by `Simulator.delete()`. */
  forget(udid: string): void {
    this.entries.delete(udid);
  }
}

/**
 * The one registry for this process, and `realDeps.recovery`'s value. Reach it
 * through `SimulatorDeps.recovery` rather than importing it — production gets
 * this instance either way, and a test gets a fresh one, which is the whole
 * point (DECISIONS.md #21).
 *
 * Nothing in production may construct a second: two handles on one udid would
 * each keep their own copy of state that is supposed to be shared, losing the
 * dedup that exists because a wedge presents as several reads failing at once.
 */
export const recoveryRegistry = new RecoveryRegistry();
