/**
 * The transports' testable half: the command line, the Host allowlist, the
 * verbose summary and the body reader.
 *
 * None of this had a test on the old server, and not for want of care — it all
 * lived in `src/index.ts`, which starts a server on import, so no test could
 * load it. That is the whole reason `parseArgs` and `resolveConfig` are in
 * `transport.ts` rather than in `index.ts` where the plan's table put them: a
 * precedence rule the plan asks to be tested cannot be tested in a module that
 * boots a server the moment it is imported. The deviation is recorded in
 * SIMGADGET_PLAN_SERVER.md.
 *
 * What is *not* here is `runHttp` and `runStdio` themselves: they bind a port
 * or take over stdin, and the thing they are worth proving — that a built
 * server answers an `initialize` — is `test/mcp.test.mts`'s job over a real
 * process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { resetEnvWarnings } from "../src/env.ts";
import {
  allowedHostHeaders,
  CONTAINER_HOST_NAMES,
  createVlog,
  parseArgs,
  readJsonBody,
  resolveConfig,
  summarizeRpc,
} from "../src/transport.ts";

/** Runs `fn` against a scratch copy of `process.env`, restored afterwards. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
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
    return fn();
  } finally {
    process.env = saved;
    resetEnvWarnings();
  }
}

/** Captures every line written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

// ---- parseArgs -------------------------------------------------------------

test("parseArgs", async (t) => {
  await t.test("reports nothing for an empty command line", () => {
    assert.deepEqual(parseArgs([]), {});
  });

  await t.test("--http and --stdio select a transport", () => {
    assert.equal(parseArgs(["--http"]).transport, "http");
    assert.equal(parseArgs(["--stdio"]).transport, "stdio");
  });

  await t.test("every value flag accepts both spellings", () => {
    assert.deepEqual(parseArgs(["--transport", "stdio"]), { transport: "stdio" });
    assert.deepEqual(parseArgs(["--transport=stdio"]), { transport: "stdio" });
    assert.deepEqual(parseArgs(["--host", "0.0.0.0"]), { host: "0.0.0.0" });
    assert.deepEqual(parseArgs(["--host=0.0.0.0"]), { host: "0.0.0.0" });
    assert.deepEqual(parseArgs(["--port", "9000"]), { port: "9000" });
    assert.deepEqual(parseArgs(["--port=9000"]), { port: "9000" });
  });

  await t.test("--verbose and -v are the same flag", () => {
    assert.equal(parseArgs(["--verbose"]).verbose, true);
    assert.equal(parseArgs(["-v"]).verbose, true);
  });

  await t.test("a value flag consumes exactly one argument", () => {
    assert.deepEqual(parseArgs(["--port", "9000", "--verbose"]), {
      port: "9000",
      verbose: true,
    });
  });

  await t.test("an unrecognised argument is ignored, not an error", () => {
    // A client that appends its own flags to the command line it spawns should
    // still get a server, not a usage message.
    assert.deepEqual(parseArgs(["--wat", "--stdio", "extra"]), { transport: "stdio" });
  });

  await t.test("the last spelling of a setting wins", () => {
    assert.equal(parseArgs(["--http", "--stdio"]).transport, "stdio");
    assert.equal(parseArgs(["--port", "1", "--port", "2"]).port, "2");
  });
});

// ---- resolveConfig: CLI > env > default -------------------------------------

test("resolveConfig", async (t) => {
  await t.test("falls back to the documented defaults", () => {
    withEnv({}, () => {
      assert.deepEqual(resolveConfig({}), {
        transport: "http",
        host: "127.0.0.1",
        port: 8008,
        verbose: false,
      });
    });
  });

  await t.test("an environment variable beats the default, for all four", () => {
    withEnv(
      {
        SIMGADGET_TRANSPORT: "stdio",
        SIMGADGET_HTTP_HOST: "0.0.0.0",
        SIMGADGET_HTTP_PORT: "9100",
        SIMGADGET_VERBOSE: "1",
      },
      () => {
        assert.deepEqual(resolveConfig({}), {
          transport: "stdio",
          host: "0.0.0.0",
          port: 9100,
          verbose: true,
        });
      }
    );
  });

  await t.test("a CLI flag beats an environment variable, for all four", () => {
    withEnv(
      {
        SIMGADGET_TRANSPORT: "stdio",
        SIMGADGET_HTTP_HOST: "0.0.0.0",
        SIMGADGET_HTTP_PORT: "9100",
        SIMGADGET_VERBOSE: "",
      },
      () => {
        assert.deepEqual(
          resolveConfig({ transport: "http", host: "10.0.0.2", port: "9200", verbose: true }),
          { transport: "http", host: "10.0.0.2", port: 9200, verbose: true }
        );
      }
    );
  });

  await t.test("the deprecated spelling still resolves", () => {
    withEnv({ IOS_SIMULATOR_MCP_HTTP_PORT: "9300" }, () => {
      assert.equal(resolveConfig({}).port, 9300);
    });
  });

  await t.test("a transport is lowercased, from either source", () => {
    withEnv({ SIMGADGET_TRANSPORT: "STDIO" }, () => {
      assert.equal(resolveConfig({}).transport, "stdio");
    });
    withEnv({}, () => {
      assert.equal(resolveConfig({ transport: "HTTP" }).transport, "http");
    });
  });

  await t.test("an unparseable port is NaN rather than the default", () => {
    // Deliberate, and inherited: a typo that silently binds 8008 is how two
    // servers end up fighting over one port. `listen(NaN)` fails loudly at the
    // one moment an operator is watching.
    withEnv({}, () => {
      assert.ok(Number.isNaN(resolveConfig({ port: "zzz" }).port));
    });
    withEnv({ SIMGADGET_HTTP_PORT: "zzz" }, () => {
      assert.ok(Number.isNaN(resolveConfig({}).port));
    });
  });

  await t.test("--verbose cannot be turned off by the environment", () => {
    withEnv({ SIMGADGET_VERBOSE: "no" }, () => {
      assert.equal(resolveConfig({ verbose: true }).verbose, true);
    });
  });
});

// ---- the Host allowlist -----------------------------------------------------

test("allowedHostHeaders", async (t) => {
  await t.test("accepts every loopback spelling on the bound port", () => {
    withEnv({}, () => {
      const allowed = allowedHostHeaders("127.0.0.1", 8008);
      assert.ok(allowed.includes("127.0.0.1:8008"));
      assert.ok(allowed.includes("localhost:8008"));
      assert.ok(allowed.includes("[::1]:8008"));
    });
  });

  await t.test("accepts the names a container reaches its host by", () => {
    withEnv({}, () => {
      const allowed = allowedHostHeaders("127.0.0.1", 8008);
      for (const name of CONTAINER_HOST_NAMES) {
        assert.ok(allowed.includes(`${name}:8008`), `${name} should be allowed`);
      }
    });
  });

  await t.test("accepts the address it was actually bound to", () => {
    withEnv({}, () => {
      assert.ok(allowedHostHeaders("192.168.1.5", 9000).includes("192.168.1.5:9000"));
    });
  });

  await t.test("a wildcard bind adds no name, because it names nothing", () => {
    withEnv({}, () => {
      for (const wildcard of ["0.0.0.0", "::"]) {
        const allowed = allowedHostHeaders(wildcard, 8008);
        assert.ok(!allowed.includes(`${wildcard}:8008`), `${wildcard} should not be allowed`);
      }
    });
  });

  await t.test("rejects an attacker's rebound name", () => {
    // The whole point: a rebound request carries a hostname the attacker
    // controls, and no derivation from our own bind address can produce one.
    withEnv({}, () => {
      const allowed = allowedHostHeaders("127.0.0.1", 8008);
      assert.ok(!allowed.includes("evil.example.com:8008"));
      assert.ok(!allowed.some((entry) => entry.includes("evil.example.com")));
    });
  });

  await t.test("SIMGADGET_ALLOWED_HOSTS is appended verbatim, port and all", () => {
    withEnv({ SIMGADGET_ALLOWED_HOSTS: "proxy.internal:443, mac.local:8008" }, () => {
      const allowed = allowedHostHeaders("127.0.0.1", 8008);
      assert.ok(allowed.includes("proxy.internal:443"));
      assert.ok(allowed.includes("mac.local:8008"));
      // Still an allowlist: adding one name does not open the rest.
      assert.ok(!allowed.includes("evil.example.com:8008"));
    });
  });

  await t.test("the deprecated spelling of the extras still works", () => {
    withEnv({ IOS_SIMULATOR_MCP_ALLOWED_HOSTS: "proxy.internal:443" }, () => {
      assert.ok(allowedHostHeaders("127.0.0.1", 8008).includes("proxy.internal:443"));
    });
  });
});

// ---- verbose logging --------------------------------------------------------

test("summarizeRpc", async (t) => {
  await t.test("names the session and the tool for a tools/call", () => {
    assert.equal(
      summarizeRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ui_tap", arguments: { id: "x", label: "OK" } },
      }),
      'session "x" ui_tap'
    );
  });

  await t.test("falls back to the tool alone when there is no session", () => {
    assert.equal(
      summarizeRpc({ method: "tools/call", params: { name: "ui_tap", arguments: {} } }),
      "ui_tap"
    );
  });

  await t.test("names any other method by its method", () => {
    assert.equal(summarizeRpc({ method: "initialize" }), "initialize");
    assert.equal(summarizeRpc({ method: "tools/list" }), "tools/list");
  });

  await t.test("renders a batch as a list", () => {
    assert.equal(
      summarizeRpc([
        { method: "initialize" },
        { method: "tools/call", params: { name: "ui_tap", arguments: { id: "x" } } },
      ]),
      'initialize, session "x" ui_tap'
    );
  });

  await t.test("survives a malformed body rather than throwing", () => {
    // This runs before the request is dispatched. A logger that threw on junk
    // would turn a client's bad request into this server's 500.
    assert.equal(summarizeRpc(undefined), "?");
    assert.equal(summarizeRpc(null), "?");
    assert.equal(summarizeRpc("not an object"), "?");
    assert.equal(summarizeRpc(42), "?");
    assert.equal(summarizeRpc({}), "response");
    assert.equal(summarizeRpc({ result: {} }), "response");
    assert.equal(summarizeRpc({ method: "tools/call" }), "?");
    assert.equal(summarizeRpc([null, "junk"]), "?, ?");
  });
});

test("createVlog", async (t) => {
  await t.test("writes nothing when verbose is off", () => {
    const lines = captureStderr(() => createVlog(false)("something happened"));
    assert.deepEqual(lines, []);
  });

  await t.test("writes one timestamped line when verbose is on", () => {
    const lines = captureStderr(() => createVlog(true)("something happened"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] something happened\n$/);
  });
});

// ---- reading a request body -------------------------------------------------

/** A real `IncomingMessage` that emits `chunks` and ends. The socket is never
 * read from — `readJsonBody` only listens. */
function bodyOf(chunks: (string | Buffer)[], options: { error?: Error } = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit("data", Buffer.from(chunk));
    if (options.error) req.emit("error", options.error);
    else req.emit("end");
  });
  return req;
}

test("readJsonBody", async (t) => {
  await t.test("returns undefined for an empty body", async () => {
    // A GET arrives this way, and so does any request the SDK will answer with
    // a protocol error of its own; `undefined` is what says "there was nothing"
    // rather than "there was something unparseable".
    assert.equal(await readJsonBody(bodyOf([])), undefined);
    assert.equal(await readJsonBody(bodyOf([""])), undefined);
  });

  await t.test("parses a JSON body", async () => {
    assert.deepEqual(await readJsonBody(bodyOf(['{"method":"initialize"}'])), {
      method: "initialize",
    });
  });

  await t.test("reassembles a body that arrived in pieces", async () => {
    assert.deepEqual(await readJsonBody(bodyOf(['{"met', 'hod":"tool', 's/list"}'])), {
      method: "tools/list",
    });
  });

  await t.test("reassembles a multi-byte character split across chunks", async () => {
    // "—" is three bytes in UTF-8. Concatenating buffers and decoding once is
    // what makes this work; decoding each chunk would produce replacement
    // characters and a parse error on a body that was never malformed.
    const raw = Buffer.from('{"text":"a—b"}');
    const cut = raw.indexOf(0xe2) + 1;
    assert.deepEqual(await readJsonBody(bodyOf([raw.subarray(0, cut), raw.subarray(cut)])), {
      text: "a—b",
    });
  });

  await t.test("rejects a body that is not JSON", async () => {
    await assert.rejects(() => readJsonBody(bodyOf(["not json"])), SyntaxError);
  });

  await t.test("rejects when the request errors", async () => {
    const boom = new Error("aborted");
    await assert.rejects(() => readJsonBody(bodyOf(['{"a":1}'], { error: boom })), boom);
  });
});
