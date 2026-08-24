/**
 * The parity gate: the **built** server, over a real stdio pipe, diffed against
 * the connect-time surface the old server published.
 *
 * `tools.test.mts` already diffs every registration against the same baseline,
 * in memory, in milliseconds — and this does not replace it. What that one
 * cannot reach is everything between `registerTools` and a client: the entry
 * point, `parseArgs`, the transport selection, the stdio transport itself and
 * the `initialize` handshake. A server whose tools are perfect and whose
 * `index.ts` never connects passes that test and fails every user.
 *
 * ## Why it speaks JSON-RPC by hand
 *
 * No MCP SDK client. The SDK is confined to `test/harness/`, for the CJS/ESM
 * declaration reasons written down there — but there is a better reason here:
 * the thing under test is *the wire*. A handshake proven by the SDK talking to
 * itself is a weaker claim than one proven by two newline-delimited JSON
 * objects going down a pipe, which is all the stdio transport actually is.
 *
 * ## Why it builds first
 *
 * "The built server" has to mean this source, not whatever was last compiled.
 * CLAUDE.md's own development loop warns about testing the old build; a gate
 * that could pass against a stale `build/index.js` would be exactly that trap
 * with a green tick on it. The build costs a second or two and is the only
 * reason this file is measured in seconds rather than microseconds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PACKAGE_ROOT, "build", "index.js");

const BASELINE = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "test/fixtures/tools-list.baseline.json"), "utf8")
) as {
  serverInfo: { name: string; version: string };
  instructions: string;
  toolCount: number;
  tools: { name: string; description: string; inputSchema: unknown; annotations: unknown }[];
};

const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")
).version;

/**
 * The two fields allowed to differ from the baseline, and nothing else.
 *
 * Each names the row of SIMGADGET_PLAN_SERVER.md's "Deliberate behaviour
 * changes" that authorises it. A third difference — a reworded description, a
 * dropped default, a renamed argument — is a regression until that table says
 * otherwise, and the assertion below is written so it cannot be anything else.
 */
const ALLOWED_DIFFERENCES = {
  /**
   * Row 1: "the MCP server's self-reported name becomes `simgadget`". Clients
   * display it, which is why it is a listed behaviour change rather than an
   * internal string.
   */
  serverInfoName: { was: "ios-simulator", now: "simgadget" },
  /**
   * Row 1's corollary. The baseline's `2.2.0` was the *root* package's version
   * — the root publishes nothing now, and the server reports the version of the
   * package it actually ships in.
   */
  serverInfoVersion: { was: "2.2.0", now: PACKAGE_VERSION },
  /**
   * Row 15: the two output-path descriptions name `SIMGADGET_DEFAULT_OUTPUT_DIR`.
   * They are the most-read strings the server has — `tools/list` goes to every
   * agent at connect — and following the old advice earned a deprecation
   * warning on stderr. The shim keeps the old spelling working; only the
   * advice moved (TODO #93).
   */
  outputDirVariable: {
    was: "IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR",
    now: "SIMGADGET_DEFAULT_OUTPUT_DIR",
    tools: ["screenshot", "record_video"],
  },
};

/**
 * The baseline's tools with the allowlisted substitutions applied, so the
 * comparison stays a whole-surface `deepEqual` rather than a set of exclusions.
 * Asserts the baseline really did carry the old spelling: a fixture that had
 * been regenerated would silently agree with whatever the server now says,
 * which is the one thing it must never do.
 */
function expectedTools(
  tools: { name: string; description: string; inputSchema: unknown; annotations: unknown }[]
) {
  const { was, now, tools: affected } = ALLOWED_DIFFERENCES.outputDirVariable;
  return tools.map((tool) => {
    if (!affected.includes(tool.name)) return tool;
    // The variable is named in the *input schema*'s `output_path` description,
    // not the tool's own — which is where an agent reads it, and where the
    // first version of this substitution failed to look.
    const schema = JSON.stringify(tool.inputSchema);
    assert.match(
      schema,
      new RegExp(was),
      `the baseline no longer names ${was} in ${tool.name} — has the fixture been regenerated?`
    );
    return { ...tool, inputSchema: JSON.parse(schema.split(was).join(now)) };
  });
}

// ---- talking to a built server ----------------------------------------------

interface Handshake {
  serverInfo: { name: string; version: string };
  instructions: string;
  tools: { name: string; description: string; inputSchema: unknown; annotations: unknown }[];
}

/**
 * Spawns the built server on stdio and performs one real client session:
 * `initialize`, `notifications/initialized`, `tools/list`.
 *
 * The environment is stripped of every `SIMGADGET_*` and `IOS_SIMULATOR_MCP_*`
 * variable, for the reason the baseline's own README gives: `FILTERED_TOOLS`
 * removes a tool from `tools/list` entirely, so a run with it set would compare
 * a short list against a long one — or, worse, pass forever if the baseline had
 * been captured the same way.
 */
async function handshake(): Promise<Handshake> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SIMGADGET_") || key.startsWith("IOS_SIMULATOR_MCP_")) delete env[key];
  }

  const child = spawn(process.execPath, [SERVER, "--stdio"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  /** id → resolver, for the two requests below. */
  const pending = new Map<number, (message: any) => void>();
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    // Newline-delimited JSON: that is the whole framing of MCP over stdio.
    let cut: number;
    while ((cut = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  const request = (id: number, method: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `the built server did not answer ${method} within 15s. stderr:\n${stderr.join("")}`
          )
        );
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      send({ jsonrpc: "2.0", id, method, params: paramsFor(method) });
    });

  const paramsFor = (method: string) =>
    method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "parity-gate", version: "1" },
        }
      : {};

  try {
    const initialized = await request(1, "initialize");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await request(2, "tools/list");
    return {
      serverInfo: initialized.serverInfo,
      instructions: initialized.instructions,
      tools: listed.tools,
    };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/** One shared handshake: spawning a process per assertion would multiply the
 * only expensive thing in this suite for no more signal. */
let session: Handshake;

test("the built server", async (t) => {
  // Build from source, so "the built server" cannot quietly mean an old one.
  execFileSync("npm", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: "pipe" });
  session = await handshake();

  await t.test("answers initialize over stdio", () => {
    assert.equal(typeof session.serverInfo?.name, "string");
    assert.ok(Array.isArray(session.tools));
  });

  await t.test("reports the name clients display", () => {
    // Deliberate behaviour change, row 1.
    assert.equal(session.serverInfo.name, ALLOWED_DIFFERENCES.serverInfoName.now);
    assert.notEqual(session.serverInfo.name, ALLOWED_DIFFERENCES.serverInfoName.was);
    assert.equal(BASELINE.serverInfo.name, ALLOWED_DIFFERENCES.serverInfoName.was);
  });

  await t.test("reports its own package's version", () => {
    // Deliberate behaviour change, row 1's corollary.
    assert.equal(session.serverInfo.version, ALLOWED_DIFFERENCES.serverInfoVersion.now);
    assert.equal(BASELINE.serverInfo.version, ALLOWED_DIFFERENCES.serverInfoVersion.was);
  });

  await t.test("sends the same instructions, to the character", () => {
    // Every agent that connects reads this and nothing else. It is prose, so
    // nothing but an exact comparison can defend it.
    assert.equal(session.instructions, BASELINE.instructions);
  });

  await t.test("publishes exactly the baseline's seventeen tools", () => {
    assert.equal(session.tools.length, BASELINE.toolCount);
    assert.deepEqual(
      session.tools.map((tool) => tool.name).sort(),
      BASELINE.tools.map((tool) => tool.name).sort()
    );
  });

  await t.test("differs from the baseline in the two allowed fields and nowhere else", () => {
    // The whole surface at once, with the allowlist substituted into the
    // expectation rather than excluded from the comparison. A difference this
    // file has not authorised has nowhere to hide: not in a description, not in
    // a Zod default, not in an annotation, not in the instructions.
    const byName = (
      tools: { name: string; description: string; inputSchema: unknown; annotations: unknown }[]
    ) =>
      Object.fromEntries(
        tools.map(({ name, description, inputSchema, annotations }) => [
          name,
          { description, inputSchema, annotations },
        ])
      );

    assert.deepEqual(
      {
        serverInfo: session.serverInfo,
        instructions: session.instructions,
        tools: byName(session.tools),
      },
      {
        serverInfo: {
          name: ALLOWED_DIFFERENCES.serverInfoName.now,
          version: ALLOWED_DIFFERENCES.serverInfoVersion.now,
        },
        instructions: BASELINE.instructions,
        tools: byName(expectedTools(BASELINE.tools)),
      }
    );
  });
});
