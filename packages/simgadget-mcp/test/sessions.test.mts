/**
 * The session registry, against fake handles.
 *
 * Every test here exists because the rule it covers is wrong invisibly. An
 * `owned` flag read backwards deletes a simulator someone was working in; a
 * creation guard that reserves an id one `await` too late leaks a booted
 * device that nothing will ever clean up; a shutdown that stops at its first
 * failure orphans everything behind it. None of those look different from
 * success at the moment they happen, and all of them cost a simulator boot to
 * find any other way.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SessionRegistry,
  stopRecordingIfActive,
  type SessionConstructors,
} from "../src/sessions.ts";
import {
  renderAlreadyAttached,
  renderAlreadyStarting,
  renderNoSession,
  renderNotBooted,
} from "../src/render.ts";
import { asSimulator, FakeSimulator } from "./fakes/simulator.ts";

import { SimGadgetError, SimulatorNotFoundError, type CreateOptions } from "simgadget";
import { resetEnvWarnings } from "../src/env.ts";

// ---- harness ---------------------------------------------------------------

/** Records what the registry asked its constructors for, and hands back
 * whichever fake the test prepared. */
class FakeConstructors implements SessionConstructors {
  readonly createCalls: (CreateOptions | undefined)[] = [];
  readonly attachCalls: string[] = [];

  constructor(
    private readonly onCreate: (opts?: CreateOptions) => Promise<FakeSimulator>,
    private readonly onAttach: (udid: string) => Promise<FakeSimulator> = async (udid) =>
      new FakeSimulator({ udid })
  ) {}

  async create(opts?: CreateOptions) {
    this.createCalls.push(opts);
    return asSimulator(await this.onCreate(opts));
  }

  async attach(udid: string) {
    this.attachCalls.push(udid);
    return asSimulator(await this.onAttach(udid));
  }
}

/** A registry whose `create` immediately yields one fixed fake. */
function registryOver(fake: FakeSimulator): {
  registry: SessionRegistry;
  constructors: FakeConstructors;
} {
  const constructors = new FakeConstructors(async () => fake, async () => fake);
  return { registry: new SessionRegistry(constructors), constructors };
}

/** A promise a test resolves by hand, for the concurrency cases. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Runs `fn` against a scratch copy of `process.env`, restored afterwards.
 * Every `SIMGADGET_*` and `IOS_SIMULATOR_MCP_*` variable is cleared first, so
 * a developer's own shell cannot decide whether a test passes. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SIMGADGET_") || key.startsWith("IOS_SIMULATOR_MCP_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvWarnings();
    return await fn();
  } finally {
    process.env = saved;
    resetEnvWarnings();
  }
}

/** The message a rejected registry call carried. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    assert.fail("expected a rejection");
  } catch (error) {
    return (error as Error).message;
  }
}

// ---- the "no session" answer -----------------------------------------------

test("a session id that was never started is an answer, not a crash", async (t) => {
  await t.test("require gives the start_simulator-first refusal", () => {
    const { registry } = registryOver(new FakeSimulator());
    assert.throws(
      () => registry.require("never-started"),
      (error: Error) => error.message === renderNoSession("never-started")
    );
  });

  await t.test("and so does withSession, without running the body", async () => {
    const { registry } = registryOver(new FakeSimulator());
    let ran = false;
    const message = await messageOf(
      registry.withSession("never-started", async () => {
        ran = true;
      })
    );
    assert.equal(message, renderNoSession("never-started"));
    assert.equal(ran, false, "the body must not run without a session");
  });

  await t.test("destroy too", async () => {
    const { registry } = registryOver(new FakeSimulator());
    assert.equal(await messageOf(registry.destroy("ghost")), renderNoSession("ghost"));
  });

  await t.test("get simply reports absence", () => {
    const { registry } = registryOver(new FakeSimulator());
    assert.equal(registry.get("never-started"), undefined);
  });
});

// ---- the creation guard ----------------------------------------------------

test("the creation guard reserves the id synchronously", async (t) => {
  await t.test("a second concurrent create for one new id is refused", async () => {
    const gate = deferred<FakeSimulator>();
    const constructors = new FakeConstructors(() => gate.promise);
    const registry = new SessionRegistry(constructors);

    // No `await` between these two lines, deliberately: that is the whole
    // property. If the reservation happened after the first `await` inside
    // `create`, the second call would sail past the guard and create a second
    // simulator that nothing would ever clean up.
    const first = registry.create("qa");
    const second = registry.create("qa");

    assert.equal(await messageOf(second), renderAlreadyStarting("qa"));

    const fake = new FakeSimulator({ udid: "UDID-1" });
    gate.resolve(fake);
    await first;

    assert.equal(constructors.createCalls.length, 1, "only one simulator created");
    assert.equal(registry.get("qa")?.sim.udid, "UDID-1", "and the first call won");
  });

  await t.test("the winner's session is owned", async () => {
    const { registry } = registryOver(new FakeSimulator());
    const session = await registry.create("qa");
    assert.equal(session.owned, true);
    assert.equal(registry.get("qa"), session);
  });

  await t.test("the options reach the library untouched", async () => {
    const { registry, constructors } = registryOver(new FakeSimulator());
    await registry.create("qa", { deviceType: "iPad", name: "qa_ipad" });
    assert.deepEqual(constructors.createCalls, [{ deviceType: "iPad", name: "qa_ipad" }]);
  });

  await t.test("the reservation is released once creation finishes", async () => {
    const { registry, constructors } = registryOver(new FakeSimulator());
    await registry.create("qa");
    await registry.create("qa");
    assert.equal(constructors.createCalls.length, 2, "a later create is not blocked");
  });

  await t.test("and released when creation fails, so the id is not wedged", async () => {
    const failure = new Error("simctl create exploded");
    let attempts = 0;
    const constructors = new FakeConstructors(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return new FakeSimulator();
    });
    const registry = new SessionRegistry(constructors);

    assert.equal(await messageOf(registry.create("qa")), "simctl create exploded");
    assert.equal(registry.get("qa"), undefined, "a failed create registers nothing");

    await registry.create("qa");
    assert.equal(attempts, 2, "the id is usable again");
  });

  await t.test("two different ids do not block each other", async () => {
    const gate = deferred<FakeSimulator>();
    const constructors = new FakeConstructors(() => gate.promise);
    const registry = new SessionRegistry(constructors);

    const a = registry.create("qa-a");
    const b = registry.create("qa-b");
    gate.resolve(new FakeSimulator());
    await a;
    await b;

    assert.equal(constructors.createCalls.length, 2);
  });
});

// ---- attach ----------------------------------------------------------------

test("attach adopts a simulator without claiming it", async (t) => {
  await t.test("the session is registered as not owned", async () => {
    const fake = new FakeSimulator({ udid: "UDID-9", name: "somebody-elses" });
    const { registry, constructors } = registryOver(fake);

    const session = await registry.attach("qa", "UDID-9");

    assert.equal(session.owned, false);
    assert.deepEqual(constructors.attachCalls, ["UDID-9"]);
    assert.equal(registry.get("qa"), session);
  });

  await t.test("an id that already has a simulator is refused", async () => {
    const fake = new FakeSimulator({ udid: "UDID-1", name: "mine" });
    const { registry, constructors } = registryOver(fake);
    await registry.create("qa");

    const message = await messageOf(registry.attach("qa", "UDID-9"));

    assert.equal(message, renderAlreadyAttached("qa", "mine", "UDID-1"));
    assert.deepEqual(constructors.attachCalls, [], "and no handle is made for it");
  });

  await t.test("a simulator that is not booted is refused, and not registered", async () => {
    const fake = new FakeSimulator({ udid: "UDID-9", name: "asleep", state: "Shutdown" });
    const { registry } = registryOver(fake);

    const message = await messageOf(registry.attach("qa", "UDID-9"));

    assert.equal(message, renderNotBooted("asleep", "UDID-9", "Shutdown"));
    assert.equal(registry.get("qa"), undefined);
  });
});

// ---- ownership, which is the one that deletes somebody's work ---------------

test("owned decides teardown, and nothing else does", async (t) => {
  await t.test("destroying an owned session deletes the simulator", async () => {
    const fake = new FakeSimulator({ udid: "UDID-1", name: "qa_iphone" });
    const { registry } = registryOver(fake);
    await registry.create("qa");

    const facts = await registry.destroy("qa");

    assert.deepEqual(facts, { name: "qa_iphone", udid: "UDID-1", owned: true });
    assert.equal(fake.deleted, true);
    assert.equal(fake.released, false, "an owned simulator is deleted, not merely released");
    assert.equal(registry.get("qa"), undefined);
  });

  await t.test("destroying an attached session releases it and never deletes", async () => {
    const fake = new FakeSimulator({ udid: "UDID-9", name: "somebody-elses" });
    const { registry } = registryOver(fake);
    await registry.attach("qa", "UDID-9");

    const facts = await registry.destroy("qa");

    assert.deepEqual(facts, { name: "somebody-elses", udid: "UDID-9", owned: false });
    assert.equal(
      fake.deleted,
      false,
      "deleting an attached simulator destroys a device someone else was using"
    );
    assert.equal(fake.released, true);
    assert.equal(fake.calls.includes("delete"), false);
    assert.equal(registry.get("qa"), undefined);
  });

  await t.test("a teardown that fails leaves the session in place", async () => {
    const fake = new FakeSimulator({ fails: { delete: new Error("simctl delete failed") } });
    const { registry } = registryOver(fake);
    await registry.create("qa");

    assert.equal(await messageOf(registry.destroy("qa")), "simctl delete failed");
    assert.notEqual(registry.get("qa"), undefined, "the simulator is still there, and still ours");
  });
});

// ---- a stale handle --------------------------------------------------------

test("SimulatorNotFoundError drops the session, wherever it comes from", async (t) => {
  await t.test("from an ordinary tool call, not just a lifecycle one", async () => {
    const stale = new SimulatorNotFoundError("UDID-1");
    const { registry } = registryOver(new FakeSimulator({ udid: "UDID-1" }));
    await registry.create("qa");

    await assert.rejects(
      registry.withSession("qa", async () => {
        throw stale;
      }),
      (error: unknown) => error === stale
    );
    assert.equal(registry.get("qa"), undefined, "a stale handle must not be resumable");
  });

  await t.test("from destroy, when something deleted it first", async () => {
    const fake = new FakeSimulator({ fails: { delete: new SimulatorNotFoundError("UDID-1") } });
    const { registry } = registryOver(fake);
    await registry.create("qa");

    await assert.rejects(registry.destroy("qa"), SimulatorNotFoundError);
    assert.equal(registry.get("qa"), undefined);
  });

  await t.test("but any other failure keeps the session", async () => {
    const { registry } = registryOver(new FakeSimulator());
    await registry.create("qa");

    await assert.rejects(
      registry.withSession("qa", async () => {
        throw new SimGadgetError("tap-obstructed", "something covered it");
      })
    );
    assert.notEqual(registry.get("qa"), undefined);
  });

  await t.test("and a body that succeeds is simply passed through", async () => {
    const { registry } = registryOver(new FakeSimulator({ udid: "UDID-1" }));
    await registry.create("qa");

    const udid = await registry.withSession("qa", async ({ sim }) => sim.udid);
    assert.equal(udid, "UDID-1");
  });
});

// ---- stopping a recording --------------------------------------------------

test("the no-recording tolerance keys off the code, never the message", async (t) => {
  await t.test("a differently worded no-active-recording is still tolerated", async () => {
    let called = false;
    await stopRecordingIfActive({
      async stopRecording() {
        called = true;
        throw new SimGadgetError("no-active-recording", "some future rewording entirely");
      },
    });
    assert.equal(called, true);
  });

  await t.test("a different code wearing that message is not", async () => {
    await assert.rejects(
      stopRecordingIfActive({
        async stopRecording() {
          throw new SimGadgetError(
            "simulator-not-found",
            "No recording is in progress for this simulator handle."
          );
        },
      }),
      (error: unknown) => error instanceof SimGadgetError && error.code === "simulator-not-found"
    );
  });

  await t.test("an active recording is stopped", async () => {
    const fake = new FakeSimulator({ recording: true });
    await stopRecordingIfActive(fake);
    assert.deepEqual(fake.calls, ["stopRecording"]);
  });
});

// ---- cleanup on exit -------------------------------------------------------

test("shutdown deletes what we created and lets go of the rest", async (t) => {
  /** An owned session and an attached one, in one registry. */
  async function twoSessions(options?: {
    ownedFails?: unknown;
    recording?: boolean;
  }): Promise<{ registry: SessionRegistry; mine: FakeSimulator; theirs: FakeSimulator }> {
    const mine = new FakeSimulator({
      udid: "UDID-MINE",
      recording: options?.recording,
      fails: options?.ownedFails ? { delete: options.ownedFails } : undefined,
    });
    const theirs = new FakeSimulator({ udid: "UDID-THEIRS", recording: options?.recording });
    const registry = new SessionRegistry(
      new FakeConstructors(
        async () => mine,
        async () => theirs
      )
    );
    await registry.create("mine");
    await registry.attach("theirs", "UDID-THEIRS");
    return { registry, mine, theirs };
  }

  await t.test("owned simulators are deleted, attached ones only released", async () => {
    await withEnv({}, async () => {
      const { registry, mine, theirs } = await twoSessions();
      await registry.shutdown();

      assert.equal(mine.deleted, true);
      assert.equal(theirs.deleted, false, "never delete a simulator we did not create");
      assert.equal(theirs.released, true);
      assert.equal(registry.get("mine"), undefined);
      assert.equal(registry.get("theirs"), undefined);
    });
  });

  await t.test("one failing teardown does not strand the others", async () => {
    await withEnv({}, async () => {
      const { registry, mine, theirs } = await twoSessions({
        ownedFails: new Error("simctl delete hung"),
      });

      await registry.shutdown(); // must not reject

      assert.equal(mine.calls.includes("delete"), true, "it was tried");
      assert.equal(theirs.released, true, "and the next one still happened");
    });
  });

  await t.test("recordings are stopped before anything is deleted", async () => {
    await withEnv({}, async () => {
      const { registry, mine, theirs } = await twoSessions({ recording: true });
      await registry.shutdown();

      assert.deepEqual(mine.calls, ["stopRecording", "delete"]);
      assert.deepEqual(theirs.calls, ["state", "stopRecording", "releaseCompanion"]);
    });
  });

  await t.test("a session with no recording is not a failure", async () => {
    await withEnv({}, async () => {
      const { registry, mine } = await twoSessions({ recording: false });
      await registry.shutdown();
      assert.equal(mine.deleted, true, "the no-active-recording throw was tolerated");
    });
  });

  await t.test("CLEANUP_ON_EXIT=false deletes nothing", async () => {
    await withEnv({ SIMGADGET_CLEANUP_ON_EXIT: "false" }, async () => {
      const { registry, mine, theirs } = await twoSessions();
      await registry.shutdown();

      assert.equal(mine.deleted, false, "the development loop keeps its simulator");
      assert.equal(mine.released, true, "but the companion still goes");
      assert.equal(theirs.deleted, false);
    });
  });

  await t.test("the old spelling of the flag still works", async () => {
    await withEnv({ IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT: "false" }, async () => {
      const { registry, mine } = await twoSessions();
      await registry.shutdown();
      assert.equal(mine.deleted, false);
    });
  });

  await t.test("an empty registry shuts down quietly", async () => {
    await withEnv({}, async () => {
      const registry = new SessionRegistry(new FakeConstructors(async () => new FakeSimulator()));
      await registry.shutdown();
    });
  });
});
