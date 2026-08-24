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
import path from "node:path";

import { connectTools } from "./harness/mcp.ts";
import { SERVER_INSTRUCTIONS } from "../src/tools.ts";
import { SessionRegistry, type SessionConstructors } from "../src/sessions.ts";
import {
  errorWithTroubleshooting,
  renderAttached,
  renderDestroyed,
  renderDetectedOrientation,
  renderElement,
  renderNoElementAtPoint,
  renderNoElementFound,
  renderResumed,
  renderRotate,
  renderScreen,
  renderAppInstalled,
  renderAppLaunched,
  renderRecordingStarted,
  renderRecordingStopped,
  renderScreenshotCaptured,
  renderScreenshotSaved,
  renderStarted,
  renderSwiped,
  renderTap,
  renderTyped,
} from "../src/render.ts";
import { asSimulator, FakeSimulator } from "./fakes/simulator.ts";

import {
  AccessibilityUnreadableError,
  ElementDisabledError,
  ElementNotFoundError,
  SimGadgetError,
  SimulatorNotFoundError,
  TapObstructedError,
  ToggleGestureError,
} from "simgadget";

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
/**
 * The one authorised difference between a registration and the baseline: the
 * two output-path descriptions name `SIMGADGET_DEFAULT_OUTPUT_DIR` where the
 * old server named `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` (row 15, TODO #93).
 * `mcp.test.mts` carries the same substitution against the built server; this
 * one keeps the per-tool check honest in the millisecond suite.
 */
const OUTPUT_DIR_RENAME = {
  was: "IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR",
  now: "SIMGADGET_DEFAULT_OUTPUT_DIR",
  tools: ["screenshot", "record_video"],
};

async function assertMatchesBaseline(name: string): Promise<void> {
  const expected = BASELINE.tools.find((tool) => tool.name === name);
  assert.ok(expected, `no baseline entry for ${name} — the fixture has 17 tools`);

  const actual = (await listedTools()).get(name);
  assert.ok(actual, `${name} was not registered`);

  // The renamed variable is named in the input schema's `output_path`
  // description, not in the tool's own description.
  let inputSchema = expected.inputSchema;
  if (OUTPUT_DIR_RENAME.tools.includes(name)) {
    const schema = JSON.stringify(inputSchema);
    assert.match(
      schema,
      new RegExp(OUTPUT_DIR_RENAME.was),
      `the baseline no longer names ${OUTPUT_DIR_RENAME.was} in ${name} — regenerated?`
    );
    inputSchema = JSON.parse(schema.split(OUTPUT_DIR_RENAME.was).join(OUTPUT_DIR_RENAME.now));
  }

  assert.equal(actual.description, expected.description, `${name}: description`);
  assert.deepEqual(actual.inputSchema, inputSchema, `${name}: inputSchema`);
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

  await t.test("a simulator deleted underneath the session is dropped and recreated", async () => {
    // The other half of the stale branch, and the one that used to escape as an
    // error (TODO #91). `state()` throws for a device that no longer exists —
    // deleted by another agent, or by hand at a terminal — where a shut-down
    // one merely answers "Shutdown". The old server could not tell them apart
    // and did not need to: `findDevice` returned `null` for both.
    const gone = createdFake({ fails: { state: new SimulatorNotFoundError("ABC-123") } });
    const fresh = createdFake({ udid: "DEF-456" });
    let creates = 0;
    const registry = new SessionRegistry({
      create: async () => {
        creates += 1;
        return creates === 1 ? asSimulator(gone) : asSimulator(fresh);
      },
      attach: async () => asSimulator(gone),
    });
    await registry.create("qa");

    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("start_simulator", { id: "qa" });

      assert.equal(isError, false, "a deleted simulator is not a failure to start a new one");
      assert.equal(creates, 2, "the dead entry was replaced, not resumed");
      assert.equal(gone.calls.includes("showWindow"), false, "no window for a device that is gone");
      assert.match(text, /DEF-456/);
      // The old refusal advised calling destroy_simulator, which by then has no
      // session to destroy -- the tool telling the agent to call the tool that
      // just failed.
      assert.doesNotMatch(text, /destroy_simulator/);
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

  await t.test("an unknown udid says only that, with no session advice", async () => {
    // The one tool that passes no `sessionId` to `handleToolError`. Every
    // other tool's session already owns a simulator, so "session X can no
    // longer use it -- call destroy_simulator" is the way back; here nothing
    // was ever registered, and that sentence would send a caller to destroy a
    // session that does not exist. The old server answered with the first
    // sentence alone (index.ts:1395), and so does this.
    const registry = registryOver(createdFake(), {
      attach: async (udid: string) => {
        throw new SimulatorNotFoundError(udid);
      },
    });

    const harness = await connect(registry);
    try {
      const { text, isError } = await harness.call("attach_simulator", {
        id: "qa",
        udid: "11111111-2222-3333-4444-555555555555",
      });

      assert.equal(isError, true);
      assert.match(text, /No simulator found with UDID "11111111-2222-3333-4444-555555555555"/);
      assert.doesNotMatch(text, /no longer use it/);
      assert.doesNotMatch(text, /destroy_simulator/);
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

  await t.test("empty space answers a sentence, and is not a failure", async () => {
    // Two halves of deliberate change 3, and TODO #92 was the second one
    // going missing: the *library* stops throwing, and the *server* says what
    // happened. Rendering the library's `null` as the four characters `null`
    // was accurate and told a caller nothing — while `ui_find`, the other
    // absent-is-an-answer tool, explains itself. The sentence matters
    // particularly here because idb reports one error for both a wedged
    // bridge and an empty point, so "the simulator is answering normally" is
    // the half a caller cannot infer.
    const fake = createdFake({ atPoint: null });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_describe_point", { id: "qa", x: 201, y: 737 });

      assert.equal(isError, false, "empty space is an answer, not an error");
      assert.equal(text, renderNoElementAtPoint(201, 737));
      assert.match(text, /No accessibility element at \(201, 737\)/);
      assert.match(text, /answering normally/);
      assert.notEqual(text, "null");
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

// ---- ui_tap ----------------------------------------------------------------

test("ui_tap", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_tap"));

  await t.test("aims by label, and says which element it acted on", async () => {
    const element = { type: "Button", AXLabel: "Sign In" };
    const result = {
      acted: "touch" as const,
      x: 120,
      y: 340,
      count: 1,
      durationSeconds: 0.1,
      element,
    };
    const fake = createdFake({ tapResult: result });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", { id: "qa", label: "Sign In" });
      // A label target, and `durationSeconds: undefined` — asking for a
      // duration at all is what turns a plain tap on a toggle into a refusal.
      assert.deepEqual(fake.argsFor("tap"), [
        { label: "Sign In" },
        { durationSeconds: undefined, count: 1 },
      ]);
      assert.equal(text, renderTap(result, "Sign In"));
      assert.match(text, /Tapped "Sign In" \(Button\) at \(120, 340\)\./);
    } finally {
      await harness.close();
    }
  });

  await t.test("aims by coordinates when no label is given", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("ui_tap", { id: "qa", x: 50, y: 60 });
      assert.deepEqual(fake.argsFor("tap"), [
        { x: 50, y: 60 },
        { durationSeconds: undefined, count: 1 },
      ]);
    } finally {
      await harness.close();
    }
  });

  await t.test("a label wins when both are given", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("ui_tap", { id: "qa", label: "Sign In", x: 50, y: 60 });
      assert.deepEqual(fake.argsFor("tap")?.[0], { label: "Sign In" });
    } finally {
      await harness.close();
    }
  });

  await t.test("duration arrives as a number, count as the schema's default", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("ui_tap", { id: "qa", x: 1, y: 2, duration: "1.5" });
      assert.deepEqual(fake.argsFor("tap")?.[1], { durationSeconds: 1.5, count: 1 });
    } finally {
      await harness.close();
    }
  });

  await t.test("count passes through for a double-tap", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("ui_tap", { id: "qa", x: 1, y: 2, count: 2 });
      assert.deepEqual(fake.argsFor("tap")?.[1], { durationSeconds: undefined, count: 2 });
    } finally {
      await harness.close();
    }
  });

  await t.test("a switch is switched, and the state is read back", async () => {
    const result = {
      acted: "activation" as const,
      element: { type: "Switch", AXLabel: "Wi-Fi" },
      before: "0",
      after: "1",
    };
    const fake = createdFake({ tapResult: result });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", { id: "qa", label: "Wi-Fi" });
      assert.equal(text, renderTap(result, "Wi-Fi"));
      assert.match(text, /Toggled Wi-Fi off -> on\./);
    } finally {
      await harness.close();
    }
  });

  await t.test("an activation that did not take says so", async () => {
    // The cost of this whole class of bug has been silent success: if it says
    // the state did not change, it did not.
    const result = {
      acted: "activation" as const,
      element: { type: "Switch", AXLabel: "Wi-Fi" },
      before: "1",
      after: "1",
    };
    const fake = createdFake({ tapResult: result });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_tap", { id: "qa", label: "Wi-Fi" });
      assert.equal(isError, false, "it is an answer about what happened");
      assert.match(text, /but it is still on/);
      assert.match(text, /scrolled out of view/);
    } finally {
      await harness.close();
    }
  });

  await t.test("neither a label nor coordinates is refused before anything is sent", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_tap", { id: "qa" });
      assert.equal(isError, true);
      assert.match(
        text,
        /^Error tapping on the screen: ui_tap needs either a label, or both x and y coordinates\./
      );
      assert.equal(fake.calls.includes("tap"), false, "nothing was sent");
    } finally {
      await harness.close();
    }
  });

  await t.test("one x without a y is not a target", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { isError } = await harness.call("ui_tap", { id: "qa", x: 50 });
      assert.equal(isError, true);
      assert.equal(fake.calls.includes("tap"), false);
    } finally {
      await harness.close();
    }
  });

  // ---- the four refusals, each a typed catch rather than a message match ----

  await t.test("refuses: no element with that label", async () => {
    const fake = createdFake({ fails: { tap: new ElementNotFoundError("Nope") } });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_tap", { id: "qa", label: "Nope" });
      assert.equal(isError, true);
      assert.match(text, /No element found whose label contains "Nope"\./);
      assert.match(text, /Use ui_describe_all to see what is on screen\./);
    } finally {
      await harness.close();
    }
  });

  await t.test("refuses: the element is disabled", async () => {
    const element = {
      type: "Button",
      AXLabel: "Submit",
      enabled: false,
      frame: { x: 10, y: 20, width: 100, height: 44 },
    };
    const fake = createdFake({ fails: { tap: new ElementDisabledError(element) } });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", { id: "qa", label: "Submit" });
      assert.match(text, /"Submit" is disabled, so tapping it would do nothing\./);
      assert.match(text, /\{x:10 y:20 w:100 h:44\}/, "the rectangle, because the remedy needs it");
    } finally {
      await harness.close();
    }
  });

  await t.test("refuses: something else is on top of it", async () => {
    const element = {
      type: "Button",
      AXLabel: "Increment",
      frame: { x: 10, y: 20, width: 100, height: 44 },
    };
    const obstruction = { type: "SearchField", AXLabel: "Search" };
    const fake = createdFake({
      fails: {
        tap: new TapObstructedError(element, obstruction, { x: 60, y: 42 }),
      },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", { id: "qa", label: "Increment" });
      assert.match(text, /"Search" is there instead/);
      assert.match(text, /covered, off screen, or scrolled out of view/);
      assert.match(text, /use ui_tap \{x, y\}/, "and the way out");
    } finally {
      await harness.close();
    }
  });

  await t.test("refuses: a hold or a multi-tap aimed at a toggle by name", async () => {
    const element = { type: "Switch", AXLabel: "Wi-Fi" };
    const fake = createdFake({
      fails: { tap: new ToggleGestureError(element, "hold") },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", {
        id: "qa",
        label: "Wi-Fi",
        duration: "1",
      });
      assert.match(text, /"Wi-Fi" is a toggle, and a hold cannot be delivered to one by name/);
      assert.match(text, /with no duration/, "the argument to drop, not the other one");
    } finally {
      await harness.close();
    }
  });

  await t.test("the label reaches the renderer when the error has no element name", async () => {
    // `ElementNotFoundError` carries the query, but the two element-bearing
    // rows fall back to the caller's label — which only arrives because every
    // body passes it in the RenderContext.
    const fake = createdFake({
      fails: { tap: new ElementDisabledError({ type: "Button" }) },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_tap", { id: "qa", label: "Submit" });
      assert.match(text, /"Submit" is disabled/);
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_type ---------------------------------------------------------------

test("ui_type", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_type"));

  await t.test("passes the text through to the handle", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_type", { id: "qa", text: "hello@example.com" });
      assert.deepEqual(fake.argsFor("typeText"), ["hello@example.com"]);
      assert.equal(text, renderTyped());
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects text the companion cannot send", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      // A newline is outside the printable-ASCII range the regex allows, and
      // is refused before the handle is touched.
      await assert.rejects(() => harness.callRaw("ui_type", { id: "qa", text: "a\nb" }));
      assert.equal(fake.calls.includes("typeText"), false);
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_swipe --------------------------------------------------------------

test("ui_swipe", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_swipe"));

  await t.test("sends both endpoints as points, with the schema's defaults", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("ui_swipe", {
        id: "qa",
        x_start: 100,
        y_start: 700,
        x_end: 100,
        y_end: 200,
      });
      assert.deepEqual(fake.argsFor("swipe"), [
        { x: 100, y: 700 },
        { x: 100, y: 200 },
        { delta: 1, durationSeconds: 1 },
      ]);
      assert.equal(text, renderSwiped());
    } finally {
      await harness.close();
    }
  });

  await t.test("an explicit duration and delta override the defaults", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("ui_swipe", {
        id: "qa",
        x_start: 0,
        y_start: 0,
        x_end: 10,
        y_end: 10,
        duration: "0.5",
        delta: 25,
      });
      assert.deepEqual(fake.argsFor("swipe")?.[2], { delta: 25, durationSeconds: 0.5 });
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects a swipe with no end point", async () => {
    const harness = await connect(await startedRegistry(createdFake(), "qa"));
    try {
      await assert.rejects(() =>
        harness.callRaw("ui_swipe", { id: "qa", x_start: 0, y_start: 0 })
      );
    } finally {
      await harness.close();
    }
  });
});

// ---- ui_view ---------------------------------------------------------------

test("ui_view", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("ui_view"));

  await t.test("asks for a compressed, point-sized JPEG and returns it as an image block", async () => {
    const bytes = Buffer.from("pretend this is a jpeg");
    const fake = createdFake({ imageData: bytes });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { content, isError } = await harness.call("ui_view", { id: "qa" });
      assert.equal(isError, false);
      // The three options are what make this the compressed *view* rather than
      // a file: JPEG at 80, resized to the space an agent's coordinates live in.
      assert.deepEqual(fake.argsFor("screenshot"), [
        { format: "jpeg", quality: 80, resizeTo: "points" },
      ]);
      assert.deepEqual(content, [
        { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" },
        { type: "text", text: renderScreenshotCaptured() },
      ]);
    } finally {
      await harness.close();
    }
  });

  await t.test("a simulator that cannot be read renders the typed error", async () => {
    const fake = createdFake({
      fails: { screenshot: new AccessibilityUnreadableError("booting", "empty") },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("ui_view", { id: "qa" });
      assert.equal(isError, true);
      assert.match(text, /^Error capturing screenshot: Simulator is still booting\./);
    } finally {
      await harness.close();
    }
  });
});

// ---- screenshot ------------------------------------------------------------

test("screenshot", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("screenshot"));

  await t.test("resolves a relative path before the library sees it", async () => {
    // The library takes absolute paths only, on purpose: `~/Downloads` is host
    // policy, and a relative path must never land in the server process's
    // working directory, which belongs to whoever launched the daemon.
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    const previous = process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
    process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = "/tmp/shots";
    try {
      const { text } = await harness.call("screenshot", {
        id: "qa",
        output_path: "login.png",
      });
      assert.deepEqual(fake.argsFor("screenshot"), [
        { format: undefined, display: undefined, mask: undefined, path: "/tmp/shots/login.png" },
      ]);
      assert.equal(text, renderScreenshotSaved("/tmp/shots/login.png"));
    } finally {
      if (previous === undefined) delete process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
      else process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = previous;
      await harness.close();
    }
  });

  await t.test("passes format, display and mask through", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("screenshot", {
        id: "qa",
        output_path: "/tmp/a.jpg",
        type: "jpeg",
        display: "internal",
        mask: "black",
      });
      assert.deepEqual(fake.argsFor("screenshot"), [
        { format: "jpeg", display: "internal", mask: "black", path: "/tmp/a.jpg" },
      ]);
    } finally {
      await harness.close();
    }
  });

  await t.test("the schema rejects a format simctl does not have", async () => {
    const harness = await connect(await startedRegistry(createdFake(), "qa"));
    try {
      await assert.rejects(() =>
        harness.callRaw("screenshot", { id: "qa", output_path: "/tmp/a.webp", type: "webp" })
      );
    } finally {
      await harness.close();
    }
  });
});

// ---- record_video ----------------------------------------------------------

test("record_video", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("record_video"));

  await t.test("starts a recording at the resolved path, naming the tool that ends it", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("record_video", {
        id: "qa",
        output_path: "/tmp/run.mp4",
        codec: "h264",
        force: true,
      });
      assert.deepEqual(fake.argsFor("startRecording"), [
        "/tmp/run.mp4",
        { codec: "h264", display: undefined, mask: undefined, force: true },
      ]);
      assert.equal(text, renderRecordingStarted("/tmp/run.mp4"));
      assert.match(text, /To stop recording, use the stop_recording command\./);
    } finally {
      await harness.close();
    }
  });

  await t.test("invents a name when none is given, in the default directory", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    const previous = process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
    process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = "/tmp/videos";
    try {
      await harness.call("record_video", { id: "qa" });
      const [outputPath] = fake.argsFor("startRecording") ?? [];
      assert.match(String(outputPath), /^\/tmp\/videos\/simulator_recording_\d+\.mp4$/);
    } finally {
      if (previous === undefined) delete process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
      else process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = previous;
      await harness.close();
    }
  });

  await t.test("a second recording is refused, and the refusal names the session", async () => {
    const fake = createdFake({
      fails: {
        startRecording: new SimGadgetError(
          "recording-already-active",
          "A recording is already in progress for this simulator handle. Stop it first."
        ),
      },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("record_video", { id: "qa" });
      assert.equal(isError, true);
      // The handle-flavoured wording is replaced by the session-flavoured one,
      // which is the whole reason every body passes a RenderContext.
      assert.match(text, /A recording is already in progress for session "qa"\. Call stop_recording first\./);
    } finally {
      await harness.close();
    }
  });
});

// ---- stop_recording --------------------------------------------------------

test("stop_recording", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("stop_recording"));

  await t.test("stops the handle's recording", async () => {
    const fake = createdFake({ recording: true });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("stop_recording", { id: "qa" });
      assert.equal(fake.calls.includes("stopRecording"), true);
      assert.equal(text, renderRecordingStopped());
    } finally {
      await harness.close();
    }
  });

  await t.test("no recording is an error that names the session", async () => {
    const fake = createdFake({ recording: false });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("stop_recording", { id: "qa" });
      assert.equal(isError, true);
      assert.match(text, /No active recording for session "qa"\./);
    } finally {
      await harness.close();
    }
  });
});

// ---- install_app -----------------------------------------------------------

test("install_app", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("install_app"));

  await t.test("installs the resolved path, and says the same path back", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("install_app", {
        id: "qa",
        app_path: "/tmp/Fixture.app",
      });
      assert.deepEqual(fake.argsFor("installApp"), ["/tmp/Fixture.app"]);
      assert.equal(text, renderAppInstalled("/tmp/Fixture.app"));
    } finally {
      await harness.close();
    }
  });

  await t.test("a relative bundle path resolves against the working directory", async () => {
    // Not `~/Downloads`: an app bundle is something the caller built, so a
    // relative path means "from here". This is the old server's behaviour and
    // the library's own rule, so the two provably agree.
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    const previous = process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
    process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = "/tmp/elsewhere";
    try {
      await harness.call("install_app", { id: "qa", app_path: "build/Fixture.app" });
      assert.deepEqual(fake.argsFor("installApp"), [
        path.resolve("build/Fixture.app"),
      ]);
    } finally {
      if (previous === undefined) delete process.env.SIMGADGET_DEFAULT_OUTPUT_DIR;
      else process.env.SIMGADGET_DEFAULT_OUTPUT_DIR = previous;
      await harness.close();
    }
  });

  await t.test("a bundle that is not there renders the typed error", async () => {
    const fake = createdFake({
      fails: {
        installApp: new SimGadgetError(
          "app-bundle-not-found",
          "App bundle not found at: /tmp/Missing.app"
        ),
      },
    });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text, isError } = await harness.call("install_app", {
        id: "qa",
        app_path: "/tmp/Missing.app",
      });
      assert.equal(isError, true);
      assert.match(text, /^Error installing app: App bundle not found at: \/tmp\/Missing\.app/);
    } finally {
      await harness.close();
    }
  });
});

// ---- launch_app ------------------------------------------------------------

test("launch_app", async (t) => {
  await t.test("matches the captured baseline", () => assertMatchesBaseline("launch_app"));

  await t.test("launches by bundle id and reports the pid", async () => {
    const fake = createdFake({ pid: 18900 });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("launch_app", {
        id: "qa",
        bundle_id: "com.example.app",
      });
      assert.deepEqual(fake.argsFor("launchApp"), [
        "com.example.app",
        { terminateRunning: undefined },
      ]);
      assert.equal(text, renderAppLaunched("com.example.app", 18900));
    } finally {
      await harness.close();
    }
  });

  await t.test("terminate_running passes through under its library spelling", async () => {
    const fake = createdFake();
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      await harness.call("launch_app", {
        id: "qa",
        bundle_id: "com.example.app",
        terminate_running: true,
      });
      assert.deepEqual(fake.argsFor("launchApp")?.[1], { terminateRunning: true });
    } finally {
      await harness.close();
    }
  });

  await t.test("a launch that reported no pid still says it launched", async () => {
    const fake = createdFake({ pid: null });
    const harness = await connect(await startedRegistry(fake, "qa"));
    try {
      const { text } = await harness.call("launch_app", {
        id: "qa",
        bundle_id: "com.example.app",
      });
      assert.equal(text, "App com.example.app launched successfully");
    } finally {
      await harness.close();
    }
  });
});

// ---- the whole surface -----------------------------------------------------

test("every tool in the baseline is registered, and nothing else is", async () => {
  // The connect-time surface, whole. Individually each tool is diffed above;
  // this is what catches the seventeenth going missing, or an eighteenth
  // arriving that no agent was ever told about.
  const registered = [...(await listedTools()).keys()].sort();
  const expected = BASELINE.tools.map((tool) => tool.name).sort();
  assert.deepEqual(registered, expected);
  assert.equal(registered.length, 17);
});
