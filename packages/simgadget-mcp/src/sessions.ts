/**
 * The session registry: MCP session id → `Simulator` handle, and every policy
 * that follows from the id rather than from the simulator.
 *
 * This file is the server's half of the split rule (SIMGADGET.md): *state keyed
 * by udid belongs to the library, state keyed by session id belongs to the
 * server*. What survives the port is the map, the ownership flag, the
 * creation guard and cleanup-on-exit. What does not survive is everything the
 * old `SimSession` carried about the *device* — `orientation` and `screenDims`
 * (index.ts:364) are now the handle's, per DECISIONS.md #5, and a second copy
 * here would be a second answer to "which way is the screen up".
 *
 * So the record is two fields. `sim` is the handle; `owned` is the only thing
 * this server knows that the library cannot: whether *we* created the
 * simulator, and may therefore delete it.
 *
 * ## The seam
 *
 * The constructors are injected — `{create, attach}`, defaulting to the
 * library's `createSimulator`/`attachSimulator` — for the same reason
 * `simgadget/src/internal/deps.ts` injects its own: it is what lets a test
 * check the ownership rules against a fake handle instead of a 40-second boot.
 * The rules below are exactly the kind that are wrong invisibly. An `owned`
 * read backwards deletes a simulator someone was using, and nothing about that
 * mistake looks different from success until the device is gone.
 *
 * ## What lives here and what does not
 *
 * The registry answers with *facts* and with the two refusals that are its own
 * (`renderNoSession`, `renderAlreadyStarting`); rendering the rest is
 * `render.ts`'s job and calling it is `tools.ts`'s. Nothing here registers a
 * tool, validates an argument or knows that MCP exists.
 */

import {
  attachSimulator,
  createSimulator,
  SimGadgetError,
  SimulatorNotFoundError,
  type CreateOptions,
  type Simulator,
} from "simgadget";

import { cleanupOnExit } from "./env.ts";
import {
  renderAlreadyAttached,
  renderAlreadyStarting,
  renderNoSession,
  renderNotBooted,
} from "./render.ts";

/**
 * One session's simulator, and whether this server may delete it.
 *
 * `owned: true` — we created it, so exiting deletes it and `destroy_simulator`
 * deletes it. `owned: false` — we attached to somebody else's, so both merely
 * let go. The distinction is the whole of `destroy`'s and `shutdown`'s
 * branching, and it is why both have tests of their own.
 */
export interface SimSession {
  readonly sim: Simulator;
  readonly owned: boolean;
}

/**
 * The two ways a handle comes into existence. Injected so a test can hand back
 * a fake; in production these are the library's own functions, unchanged.
 */
export interface SessionConstructors {
  create(opts?: CreateOptions): Promise<Simulator>;
  attach(udid: string): Promise<Simulator>;
}

/** The real ones. The default, and the only pair a running server uses. */
export const libraryConstructors: SessionConstructors = {
  create: createSimulator,
  attach: attachSimulator,
};

/**
 * Stops `sim`'s recording, tolerating there being none.
 *
 * **The tolerance is a check on `code`, never on the message.** The library
 * throws a bare `SimGadgetError("no-active-recording", …)` whose wording is
 * handle-flavoured ("for this simulator handle"), and that sentence is prose:
 * it can be improved in a patch release without anybody thinking they have
 * changed behaviour. A server that matched on it would start failing its own
 * shutdown, silently, on an upgrade — which is the exact class of bug the
 * typed errors were introduced to end (SIMGADGET.md, "Errors": the old
 * `/found no element/i` matching dies at this boundary).
 *
 * Takes a structural slice rather than a `Simulator` so it is callable — and
 * testable — with anything that can stop a recording.
 */
export async function stopRecordingIfActive(
  sim: Pick<Simulator, "stopRecording">
): Promise<void> {
  try {
    await sim.stopRecording();
  } catch (error) {
    if (error instanceof SimGadgetError && error.code === "no-active-recording") {
      return;
    }
    throw error;
  }
}

export class SessionRegistry {
  /** id → session. The port of `managedSimulators` (index.ts:367). */
  private readonly sessions = new Map<string, SimSession>();

  /**
   * Session ids that are mid-creation. The port of `startingSessions`
   * (index.ts:377), and the one piece of state in this server whose
   * correctness is a statement about *when* code runs rather than what it
   * does — see `create` below.
   */
  private readonly starting = new Set<string>();

  private readonly make: SessionConstructors;

  constructor(constructors: SessionConstructors = libraryConstructors) {
    this.make = constructors;
  }

  /** The session for `id`, or `undefined`. For the callers that treat "no
   * session" as an ordinary branch — `start_simulator`'s resume path. */
  get(id: string): SimSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * The session for `id`, or the refusal `getManagedSim` has always given
   * (index.ts:409). The prose is `render.ts`'s, not retyped here.
   */
  require(id: string): SimSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(renderNoSession(id));
    return session;
  }

  /** Forgets `id` without touching its simulator. For the caller that has
   * established the handle is dead — `start_simulator`'s stale entry
   * (index.ts:1235). */
  drop(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Runs `fn` against `id`'s handle, or refuses with the "call start_simulator
   * first" answer.
   *
   * **This is the accessor a tool body should use**, because of the catch: a
   * `SimulatorNotFoundError` means the handle is stale — the simulator was
   * deleted, by this server or by somebody at a terminal — and the session is
   * never going to work again. Every method on `Simulator` checks for that
   * first and throws it, so a stale handle surfaces from `ui_tap` exactly as
   * readily as from `destroy_simulator`. Dropping the session here is what
   * makes the next `start_simulator` create a fresh one rather than resume a
   * corpse; leaving it would strand the id until the server restarted.
   *
   * The error is rethrown, not swallowed. The caller still failed, and
   * `renderError` has a sentence naming the way back.
   */
  async withSession<T>(id: string, fn: (session: SimSession) => Promise<T>): Promise<T> {
    const session = this.require(id);
    try {
      return await fn(session);
    } catch (error) {
      if (error instanceof SimulatorNotFoundError) this.sessions.delete(id);
      throw error;
    }
  }

  /**
   * Creates a simulator for `id` and registers it as ours.
   *
   * **The reservation is synchronous, and that is the whole point of this
   * method.** `starting.has` and `starting.add` run in the same turn as the
   * call, before the first `await` — a port of index.ts:1241–1246, where the
   * ordering was already load-bearing and already commented. Two concurrent
   * `start_simulator` calls for one new id would otherwise both get past the
   * guard while the other was suspended inside `simctl create`, and the loser
   * would leak a whole simulator: booted, invisible to the registry, and
   * cleaned up by nothing.
   *
   * The reservation is released in a `finally`, so a failed create leaves the
   * id usable rather than permanently "already being created".
   *
   * The caller resolves any existing session first — `start_simulator` either
   * resumes it or drops it as stale — which is why there is no check for one
   * here. That matches the old server, which likewise `set` unconditionally
   * (index.ts:1272) after its resume branch had already run.
   */
  async create(id: string, opts?: CreateOptions): Promise<SimSession> {
    if (this.starting.has(id)) throw new Error(renderAlreadyStarting(id));
    this.starting.add(id);

    try {
      const sim = await this.make.create(opts);
      const session: SimSession = { sim, owned: true };
      this.sessions.set(id, session);
      return session;
    } finally {
      this.starting.delete(id);
    }
  }

  /**
   * Adopts an already-booted simulator by udid, as somebody else's.
   *
   * Two refusals, both before anything is registered:
   *
   *  - the id already has a simulator (index.ts:1385) — a session owns one
   *    device, and silently replacing it would orphan the first;
   *  - the simulator is not booted (index.ts:1394). The check is here rather
   *    than in the tool body so the registry can never come to hold a session
   *    whose simulator was never driveable: registering first and refusing
   *    afterwards would need an un-register on the failure path, which is one
   *    more place to get ownership wrong. It is a deviation from the mapping
   *    table's split of `attach_simulator`, and is recorded in
   *    SIMGADGET_PLAN_SERVER.md.
   *
   * `waitReady()` is deliberately *not* called here: it takes up to a minute
   * and produces the numbers the tool's answer is built from, so it belongs to
   * the caller, which knows how to render them.
   */
  async attach(id: string, udid: string): Promise<SimSession> {
    const existing = this.sessions.get(id);
    if (existing) {
      throw new Error(renderAlreadyAttached(id, existing.sim.name, existing.sim.udid));
    }

    const sim = await this.make.attach(udid);

    const state = await sim.state();
    if (state !== "Booted") {
      throw new Error(renderNotBooted(sim.name, sim.udid, state));
    }

    const session: SimSession = { sim, owned: false };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Tears `id`'s simulator down and forgets the session.
   *
   * **`owned` decides which teardown, and nothing else does.** Owned →
   * `sim.delete()`, which shuts down, deletes and marks the handle stale.
   * Attached → `sim.releaseCompanion()`, which stops the companion process we
   * started and leaves the simulator running, exactly as its user left it.
   * Reading this flag backwards deletes a device somebody was working in, so
   * it has a test to itself rather than an assertion inside a larger one.
   *
   * Returns the three facts the answer is built from. They are read *before*
   * the teardown for a reason: after a successful `delete()` the handle is
   * stale, and only its plain `udid`/`name` fields are still safe to touch.
   */
  async destroy(id: string): Promise<{ name: string; udid: string; owned: boolean }> {
    const { sim, owned } = this.require(id);
    const facts = { name: sim.name, udid: sim.udid, owned };

    try {
      if (owned) await sim.delete();
      else await sim.releaseCompanion();
    } catch (error) {
      // Already gone: the caller's wish has been granted by somebody else, so
      // the session goes with it. Any other failure leaves the session in
      // place — the simulator is still there and still this session's.
      if (error instanceof SimulatorNotFoundError) this.sessions.delete(id);
      throw error;
    }

    this.sessions.delete(id);
    return facts;
  }

  /**
   * Process exit: stop what we started, delete what we created.
   *
   * The port of `cleanupAllSimulators` (index.ts:476) and of `shutdown`'s
   * recording loop (index.ts:3021), which used to be two passes over two maps
   * and is now two passes over one. `activeRecordings` is gone: a recording
   * belongs to the handle that started it, so stopping them all is a walk of
   * the sessions.
   *
   * Recordings are stopped first, and separately, so a `simctl io recordVideo`
   * gets its `SIGINT` and finalizes its file before the device underneath it
   * is deleted. `Simulator.delete()` does this for its own handle anyway; an
   * *attached* session's recording has nothing else that would.
   *
   * **`Promise.allSettled`, twice**, as index.ts:477 has always done: one
   * simulator that refuses to shut down must not strand the others, because
   * the ones it strands are the orphans a user finds a week later.
   *
   * `cleanupOnExit()` is read here rather than at construction so a test — and
   * the development loop CLAUDE.md documents — can set it and see it take
   * effect. When it is off, an owned simulator is *released*, not deleted:
   * that is the point of `SIMGADGET_CLEANUP_ON_EXIT=false`, which keeps a
   * booted simulator across a server restart.
   */
  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];

    await Promise.allSettled(sessions.map(({ sim }) => stopRecordingIfActive(sim)));

    const deleting = cleanupOnExit();
    await Promise.allSettled(
      sessions.map(({ sim, owned }) =>
        owned && deleting ? sim.delete() : sim.releaseCompanion()
      )
    );

    this.sessions.clear();
  }
}
