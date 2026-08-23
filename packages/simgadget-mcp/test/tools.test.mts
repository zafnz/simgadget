/**
 * The seventeen tool registrations, driven as an agent drives them.
 *
 * ## Why this goes through a real MCP client
 *
 * The two routes the plan offered were exported handler functions called
 * directly, and a `Client` connected to an `McpServer` over
 * `InMemoryTransport`. This is the second, because it is the only one that
 * exercises the half of a tool that an agent actually meets: the Zod schema.
 * A handler tested directly is handed arguments a test author typed, already
 * the right shape; a handler reached through a client is handed what the
 * schema produced from JSON — with `count` defaulted, `duration` still a
 * string, and an unknown key rejected before the body runs. Getting a default
 * wrong is invisible to the first route and is a real behaviour change.
 *
 * It also makes the parity baseline checkable *now* rather than at step 3.7:
 * every registration below is diffed against
 * `fixtures/tools-list.baseline.json` — name, description, input schema and
 * annotations — which is what an agent sees at connect time. Agent D's
 * `mcp.test.mts` still has to do it over stdio against the *built* server,
 * because that also proves the entry point and the transport; this one proves
 * the registrations, which is where the mistakes are, and it costs
 * milliseconds.
 *
 * ## What each tool's test asserts
 *
 * Three things, and a test that skips the middle one is the "it accepts
 * arguments" test this suite exists not to be:
 *
 *  1. it called the library method the mapping table names (SIMGADGET.md,
 *     "The MCP on top"),
 *  2. with the arguments the schema produced,
 *  3. and rendered the result through the renderer that owns that prose.
 *
 * The third is asserted against `render.ts`'s own functions rather than
 * against a copied string. A literal here would be a second copy of the prose
 * — the exact thing `render.ts` exists to prevent — and would go on passing
 * after the renderer changed underneath it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { connectTools } from "./harness/mcp.ts";
import { SERVER_INSTRUCTIONS } from "../src/tools.ts";
import { SessionRegistry, type SessionConstructors } from "../src/sessions.ts";
import {
  errorWithTroubleshooting,
  renderAttached,
  renderDestroyed,
  renderDetectedOrientation,
  renderElement,
  renderNoElementFound,
  renderResumed,
  renderRotate,
  renderScreen,
  renderStarted,
} from "../src/render.ts";
import { asSimulator, FakeSimulator } from "./fakes/simulator.ts";

import { AccessibilityUnreadableError, SimulatorNotFoundError } from "simgadget";

// ---- harness ---------------------------------------------------------------

const BASELINE = JSON.parse(
  readFileSync(new URL("./fixtures/tools-list.baseline.json", import.meta.url), "utf8")
) as {
  tools: {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations: unknown;
  }[];
};

/** A registry over one fake, handing the same handle to `create` and `attach`
 * so a test picks the entry point rather than the device. */
function registryOver(fake: FakeSimulator, overrides: Partial<SessionConstructors> = {}) {
  return new SessionRegistry({
    create: async () => asSimulator(fake),
    attach: async () => asSimulator(fake),
    ...overrides,
  });
}

/** A registry that already holds `id`, as every non-lifecycle tool requires. */
async function startedRegistry(fake: FakeSimulator, id = "s"): Promise<SessionRegistry> {
  const registry = registryOver(fake);
  await registry.create(id);
  return registry;
}

/** Shorthand: every test connects, calls, and closes. */
const connect = connectTools;

/** The registrations the server actually published, by name. */
async function listedTools(sessions = registryOver(new FakeSimulator())) {
  const harness = await connect(sessions);
  try {
    return await harness.list();
  } finally {
    await harness.close();
  }
}

/**
 * Diffs one registration against the captured baseline: the whole
 * connect-time surface of that tool, which is precisely what an agent reads
 * and validates against.
 */
async function assertMatchesBaseline(name: string): Promise<void> {
  const expected = BASELINE.tools.find((tool) => tool.name === name);
  assert.ok(expected, `no baseline entry for ${name} — the fixture has 17 tools`);

  const actual = (await listedTools()).get(name);
  assert.ok(actual, `${name} was not registered`);

  assert.equal(actual.description, expected.description, `${name}: description`);
  assert.deepEqual(actual.inputSchema, expected.inputSchema, `${name}: inputSchema`);
  assert.deepEqual(actual.annotations, expected.annotations, `${name}: annotations`);
}

/** A booted fake, with the fields `start_simulator` renders from. */
function createdFake(options: Partial<ConstructorParameters<typeof FakeSimulator>[0]> = {}) {
  return new FakeSimulator({
    udid: "ABC-123",
    name: "qa_iphone",
    deviceType: { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", name: "iPhone 16 Pro" },
    boot: { ready: true, waitedMs: 41_000, recoveryTried: false, recovered: false },
    ...options,
  });
}

// ---- the instructions ------------------------------------------------------

test("the handshake instructions are the baseline's, unchanged", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("./fixtures/tools-list.baseline.json", import.meta.url), "utf8")
  ) as { instructions: string };
  assert.equal(SERVER_INSTRUCTIONS, baseline.instructions);
});

// ---- filtering -------------------------------------------------------------

test("filtering", async (t) => {
  t.afterEach(() => {
    delete process.env.SIMGADGET_FILTERED_TOOLS;
    delete process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS;
  });

  await t.test("a filtered tool is absent from tools/list, not merely refusing", async () => {
    process.env.SIMGADGET_FILTERED_TOOLS = "destroy_simulator";
    const tools = await listedTools();
    assert.equal(tools.has("destroy_simulator"), false);
    assert.equal(tools.has("start_simulator"), true, "the others are untouched");
  });

  await t.test("several, comma separated and space tolerant", async () => {
    process.env.SIMGADGET_FILTERED_TOOLS = "start_simulator, destroy_simulator";
    const tools = await listedTools();
    assert.equal(tools.has("start_simulator"), false);
    assert.equal(tools.has("destroy_simulator"), false);
  });

  await t.test("nothing filtered when the variable is unset", async () => {
    const tools = await listedTools();
    assert.equal(tools.has("start_simulator"), true);
  });
});

// ---- start_simulator -------------------------------------------------------

test("start_simulator", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("start_simulator"));

  await t.test("creates, passing the device keyword and the composed name", async () => {
    const fake = createdFake();
    const created: unknown[] = [];
    const registry = new SessionRegistry({
      create: async (opts) => {
        created.push(opts);
        return asSimulator(fake);
      },
      attach: async () => asSimulator(fake),
    });

    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("start_simulator", {
        id: "qa",
        type: "iPhone 16 Pro",
      });
      assert.equal(isError, false);
      // The name is the server's to compose: the session id belongs to it, and
      // the keyword is lowercased with spaces hyphenated (index.ts:1253).
      assert.deepEqual(created, [
        { deviceType: "iPhone 16 Pro", name: "qa_iphone-16-pro" },
      ]);
      assert.equal(
        text,
        renderStarted({
          deviceName: "qa_iphone",
          deviceTypeName: "iPhone 16 Pro",
          udid: "ABC-123",
          boot: { ready: true, waitedMs: 41_000, recoveryTried: false, recovered: false },
        })
      );
    } finally {
      await harness.close();
    }
  });

  await t.test("defaults the keyword to iPhone", async () => {
    const created: unknown[] = [];
    const registry = new SessionRegistry({
      create: async (opts) => {
        created.push(opts);
        return asSimulator(createdFake());
      },
      attach: async () => asSimulator(createdFake()),
    });

    const harness = await connect(registry);
    try {
      await harness.call("start_simulator", { id: "qa" });
      assert.deepEqual(created, [{ deviceType: "iPhone", name: "qa_iphone" }]);
    } finally {
      await harness.close();
    }
  });

  await t.test("the model name comes off the handle, not from the keyword", async () => {
    // An agent asks for "iPhone" and the answer is the only place it learns
    // which iPhone it got. That is the whole reason `deviceType` was added to
    // the handle (SIMGADGET_PLAN_SERVER.md, "A second gap").
    const fake = createdFake({ deviceType: { identifier: "x", name: "iPhone 16 Pro" } });
    const harness = await connect(registryOver(fake));
    try {
      const { text } = await harness.call("start_simulator", { id: "qa", type: "iPhone" });
      assert.match(text, /\(iPhone 16 Pro, ABC-123\)/);
    } finally {
      await harness.close();
    }
  });

  await t.test("resumes a booted simulator: showWindow, and no create", async () => {
    const fake = createdFake();
    const registry = await startedRegistry(fake, "qa");
    fake.calls.length = 0;

    const harness = await connect(registry);
    try {
      const { text } = await harness.call("start_simulator", { id: "qa" });
      // `state()` then `showWindow()` — never `boot()`, whose unconditional 8s
      // settle is what `showWindow` exists to avoid on a live simulator.
      assert.deepEqual(fake.calls, ["state", "showWindow"]);
      assert.equal(text, renderResumed("qa", "qa_iphone", "ABC-123"));
    } finally {
      await harness.close();
    }
  });

  await t.test("a shut-down simulator is dropped and recreated", async () => {
    const stale = createdFake({ state: "Shutdown" });
    const fresh = createdFake({ udid: "DEF-456" });
    let creates = 0;
    // The first create seeds the stale session through the same door a real one
    // arrives by; the second is the one the tool makes.
    const registry = new SessionRegistry({
      create: async () => {
        creates += 1;
        return creates === 1 ? asSimulator(stale) : asSimulator(fresh);
      },
      attach: async () => asSimulator(stale),
    });
    await registry.create("qa");

    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("start_simulator", { id: "qa" });
      assert.equal(isError, false);
      assert.equal(creates, 2, "the stale entry was replaced, not resumed");
      assert.equal(stale.calls.includes("showWindow"), false, "no window for a dead one");
      assert.match(text, /DEF-456/);
    } finally {
      await harness.close();
    }
  });

  await t.test("a failure renders with the troubleshooting guide", async () => {
    const registry = new SessionRegistry({
      create: async () => {
        throw new Error("simctl said no");
      },
      attach: async () => asSimulator(createdFake()),
    });
    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("start_simulator", { id: "qa" });
      assert.equal(isError, true);
      assert.equal(text, errorWithTroubleshooting("Error starting simulator: simctl said no"));
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects a session id with a shell metacharacter", async () => {
    const harness = await connect(registryOver(createdFake()));
    try {
      await assert.rejects(() => harness.callRaw("start_simulator", { id: "qa; rm -rf /" }));
    } finally {
      await harness.close();
    }
  });
});

// ---- destroy_simulator -----------------------------------------------------

test("destroy_simulator", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("destroy_simulator"));

  await t.test("deletes what we created, and says so", async () => {
    const fake = createdFake();
    const registry = await startedRegistry(fake, "qa");

    const harness = await connect(registry);
    try {
      const { text } = await harness.call("destroy_simulator", { id: "qa" });
      assert.equal(fake.deleted, true);
      assert.equal(text, renderDestroyed("qa_iphone", "ABC-123", true));
    } finally {
      await harness.close();
    }
  });

  await t.test("an attached simulator is detached, never deleted", async () => {
    const fake = createdFake();
    const registry = registryOver(fake);
    await registry.attach("qa", "ABC-123");

    const harness = await connect(registry);
    try {
      const { text } = await harness.call("destroy_simulator", { id: "qa" });
      assert.equal(fake.deleted, false, "somebody else's simulator is still theirs");
      assert.equal(fake.released, true);
      assert.equal(text, renderDestroyed("qa_iphone", "ABC-123", false));
    } finally {
      await harness.close();
    }
  });

  await t.test("an unknown session gets the start_simulator answer", async () => {
    const harness = await connect(registryOver(createdFake()));
    try {
      const { text, isError } = await harness.call("destroy_simulator", { id: "nobody" });
      assert.equal(isError, true);
      assert.match(text, /No simulator is running for session "nobody"\. Call start_simulator first\./);
    } finally {
      await harness.close();
    }
  });
});

// ---- attach_simulator ------------------------------------------------------

test("attach_simulator", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("attach_simulator"));

  await t.test("attaches by udid, waits for readiness, and renders the numbers", async () => {
    const fake = createdFake();
    const attached: string[] = [];
    const registry = new SessionRegistry({
      create: async () => asSimulator(fake),
      attach: async (udid) => {
        attached.push(udid);
        return asSimulator(fake);
      },
    });

    const harness = await connect(registry);
    try {
      const { text } = await harness.call("attach_simulator", {
        id: "qa",
        udid: "11111111-2222-3333-4444-555555555555",
      });
      assert.deepEqual(attached, ["11111111-2222-3333-4444-555555555555"]);
      // The wait belongs to the tool, not the registry: it produces the numbers
      // this answer is built from.
      assert.equal(fake.calls.includes("waitReady"), true);
      assert.equal(
        text,
        renderAttached({
          name: "qa_iphone",
          udid: "ABC-123",
          boot: { ready: true, waitedMs: 41_000, recoveryTried: false, recovered: false },
        })
      );
    } finally {
      await harness.close();
    }
  });

  await t.test("a simulator that never answered is reported as attached anyway", async () => {
    const fake = createdFake({
      boot: { ready: false, waitedMs: 55_000, recoveryTried: true, recovered: false },
    });
    const registry = registryOver(fake);

    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("attach_simulator", {
        id: "qa",
        udid: "11111111-2222-3333-4444-555555555555",
      });
      assert.equal(isError, false, "it attached; the wait timing out is not a failure");
      assert.match(text, /has not answered an accessibility read after 55s/);
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects something that is not a udid", async () => {
    const harness = await connect(registryOver(createdFake()));
    try {
      await assert.rejects(() =>
        harness.callRaw("attach_simulator", { id: "qa", udid: "not-a-udid" })
      );
    } finally {
      await harness.close();
    }
  });
});

// ---- rotate ----------------------------------------------------------------

test("rotate", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("rotate"));

  await t.test("asks the handle to rotate, and names the session", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("rotate", {
        id: "qa",
        orientation: "landscape_left",
      });
      assert.deepEqual(fake.argsFor("rotate"), ["landscape_left"]);
      assert.equal(
        text,
        renderRotate("qa", { requested: "landscape_left", adopted: "landscape_left" })
      );
    } finally {
      await harness.close();
    }
  });

  await t.test("an orientation the app declined is reported, not hidden", async () => {
    // The interface is read back rather than assumed, and disagreeing is not
    // an error: coordinates follow what was adopted either way, and that is
    // the fact the caller needs.
    const fake = createdFake({ adopted: "portrait" });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("rotate", {
        id: "qa",
        orientation: "upside_down",
      });
      assert.equal(isError, false);
      assert.equal(
        text,
        renderRotate("qa", { requested: "upside_down", adopted: "portrait" })
      );
      assert.match(text, /Face ID/, "the iPhone explanation, not the generic one");
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects an orientation that is not one of the four", async () => {
    const harness = await connect(await startedRegistry(createdFake(), "qa"));
    try {
      await assert.rejects(() => harness.callRaw("rotate", { id: "qa", orientation: "sideways" }));
    } finally {
      await harness.close();
    }
  });
});

// ---- detect_rotation -------------------------------------------------------

test("detect_rotation", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("detect_rotation"));

  await t.test("probes the handle and reports what it found", async () => {
    const fake = createdFake({ orientation: "landscape_right" });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("detect_rotation", { id: "qa" });
      assert.equal(fake.calls.includes("detectOrientation"), true);
      assert.equal(text, renderDetectedOrientation("qa", "landscape_right"));
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_describe_all -------------------------------------------------------

test("ui_describe_all", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_describe_all"));

  await t.test("returns the elements, and not the screen rectangle beside them", async () => {
    const screen = {
      elements: [
        { type: "Application", frame: { x: 0, y: 0, width: 393, height: 852 } },
        { type: "Button", AXLabel: "Sign In", frame: { x: 20, y: 100, width: 200, height: 44 } },
      ],
      screen: { width: 393, height: 852 },
    };
    const fake = createdFake({ screen });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_describe_all", { id: "qa" });
      assert.equal(fake.calls.includes("describeScreen"), true);
      assert.equal(text, renderScreen(screen));
      // The `screen` rectangle is the root element's frame said twice, and
      // this payload is read by a model on every call.
      assert.deepEqual(JSON.parse(text), screen.elements);
    } finally {
      await harness.close();
    }
  });

  await t.test("a wedged accessibility bridge renders as the typed error", async () => {
    const fake = createdFake({
      fails: {
        describeScreen: new AccessibilityUnreadableError("unrecoverable", "empty tree"),
      },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_describe_all", { id: "qa" });
      assert.equal(isError, true);
      assert.match(text, /^Error describing all of the ui: /);
      assert.match(text, /file a bug/, "the unrecoverable verdict asks for a report");
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_find ---------------------------------------------------------------

test("ui_find", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_find"));

  await t.test("resolves by label and returns the element as JSON", async () => {
    const element = {
      type: "Button",
      AXLabel: "Sign In",
      frame: { x: 20, y: 100, width: 200, height: 44 },
    };
    const fake = createdFake({ element });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_find", { id: "qa", label: "Sign In" });
      assert.deepEqual(fake.argsFor("findByLabel"), ["Sign In"]);
      assert.equal(text, renderElement(element));
    } finally {
      await harness.close();
    }
  });

  await t.test("nothing found is an answer, not an error", async () => {
    const fake = createdFake({ element: null });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_find", { id: "qa", label: "Nope" });
      assert.equal(isError, false, "absent is not a failure");
      assert.equal(text, renderNoElementFound("Nope"));
    } finally {
      await harness.close();
    }
  });

  await t.test("a failure names the label it was looking for", async () => {
    const fake = createdFake({ fails: { findByLabel: new Error("companion died") } });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_find", { id: "qa", label: "Sign In" });
      assert.equal(isError, true);
      assert.match(text, /^Error finding element labelled "Sign In": companion died/);
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects an empty label", async () => {
    const harness = await connect(await startedRegistry(createdFake(), "qa"));
    try {
      await assert.rejects(() => harness.callRaw("ui_find", { id: "qa", label: "" }));
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_describe_point -----------------------------------------------------

test("ui_describe_point", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_describe_point"));

  await t.test("passes the logical coordinates through and returns the element", async () => {
    const element = { type: "Button", AXLabel: "Sign In" };
    const fake = createdFake({ atPoint: element });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_describe_point", { id: "qa", x: 120, y: 340 });
      // Logical in, logical out: the portrait transform lives in the library,
      // and a server that applied its own would apply it twice.
      assert.deepEqual(fake.argsFor("describePoint"), [120, 340]);
      assert.equal(text, renderElement(element));
    } finally {
      await harness.close();
    }
  });

  await t.test("empty space answers null rather than failing", async () => {
    const fake = createdFake({ atPoint: null });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_describe_point", { id: "qa", x: 1, y: 1 });
      assert.equal(isError, false);
      assert.equal(text, "null");
    } finally {
      await harness.close();
    }
  });

  await t.test("a failure names the point", async () => {
    const fake = createdFake({ fails: { describePoint: new Error("no answer") } });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_describe_point", { id: "qa", x: 12, y: 34 });
      assert.match(text, /^Error describing point \(12, 34\): no answer/);
    } finally {
      await harness.close();
    }
  });
});

// ---- the accessor every non-lifecycle tool shares --------------------------

test("a read against an unknown session refuses with the way back", async () => {
  const harness = await connect(registryOver(createdFake()));
  try {
    const { text, isError } = await harness.call("ui_describe_all", { id: "ghost" });
    assert.equal(isError, true);
    assert.match(text, /No simulator is running for session "ghost"\. Call start_simulator first\./);
  } finally {
    await harness.close();
  }
});

test("a stale handle drops its session, so the next start_simulator creates", async () => {
  // `SimulatorNotFoundError` arrives from *any* method once the simulator has
  // been deleted underneath the handle — by this server or by somebody at a
  // terminal. `withSession` is what makes that one rule rather than fourteen.
  const fake = createdFake({
    fails: { describeScreen: new SimulatorNotFoundError("ABC-123") },
  });
  const registry = await startedRegistry(fake, "qa");
  const harness = await connect(registry);
  try {
    const { text, isError } = await harness.call("ui_describe_all", { id: "qa" });
    assert.equal(isError, true);
    assert.match(text, /Session "qa" can no longer use it/);
    assert.equal(registry.get("qa"), undefined, "the session was dropped");
  } finally {
    await harness.close();
  }
});
