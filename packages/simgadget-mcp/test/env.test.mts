import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedHosts,
  assertIdbPathUnset,
  cleanupOnExit,
  defaultOutputDir,
  filteredTools,
  httpHost,
  httpPort,
  readEnv,
  resetEnvWarnings,
  transport,
  verbose,
  type ServerEnvName,
} from "../src/env.ts";

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

/**
 * The eight, paired with an accessor and a value that is visibly not the
 * default. Every table-driven test below runs over this, which is what makes
 * "one variable was forgotten" impossible rather than merely unlikely: a
 * ninth variable added to `ServerEnvName` without a row here does not compile.
 */
const VARIABLES: {
  name: ServerEnvName;
  read: () => unknown;
  sample: string;
  expected: unknown;
}[] = [
  { name: "ALLOWED_HOSTS", read: allowedHosts, sample: "example.test:9000", expected: ["example.test:9000"] },
  { name: "CLEANUP_ON_EXIT", read: cleanupOnExit, sample: "false", expected: false },
  { name: "DEFAULT_OUTPUT_DIR", read: defaultOutputDir, sample: "/tmp/shots", expected: "/tmp/shots" },
  { name: "FILTERED_TOOLS", read: filteredTools, sample: "ui_tap", expected: ["ui_tap"] },
  { name: "HTTP_HOST", read: httpHost, sample: "0.0.0.0", expected: "0.0.0.0" },
  { name: "HTTP_PORT", read: httpPort, sample: "9123", expected: 9123 },
  { name: "TRANSPORT", read: transport, sample: "stdio", expected: "stdio" },
  { name: "VERBOSE", read: verbose, sample: "true", expected: true },
];

test("readEnv", async (t) => {
  await t.test("the new name wins when both are set", () => {
    withEnv(
      { SIMGADGET_HTTP_PORT: "9001", IOS_SIMULATOR_MCP_HTTP_PORT: "9002" },
      () => {
        assert.equal(readEnv("HTTP_PORT"), "9001");
      }
    );
  });

  await t.test("the old name alone still works", () => {
    withEnv({ IOS_SIMULATOR_MCP_HTTP_PORT: "9002" }, () => {
      assert.equal(readEnv("HTTP_PORT"), "9002");
    });
  });

  await t.test("the old name warns exactly once per variable per process", () => {
    withEnv({ IOS_SIMULATOR_MCP_TRANSPORT: "stdio" }, () => {
      const lines = captureStderr(() => {
        readEnv("TRANSPORT");
        readEnv("TRANSPORT");
        readEnv("TRANSPORT");
      });
      assert.equal(lines.length, 1, "one warning for three reads");
      assert.match(lines[0], /IOS_SIMULATOR_MCP_TRANSPORT is deprecated/);
      assert.match(lines[0], /SIMGADGET_TRANSPORT/);
    });
  });

  await t.test("each variable gets its own warning", () => {
    withEnv(
      { IOS_SIMULATOR_MCP_TRANSPORT: "stdio", IOS_SIMULATOR_MCP_VERBOSE: "1" },
      () => {
        const lines = captureStderr(() => {
          readEnv("TRANSPORT");
          readEnv("VERBOSE");
        });
        assert.equal(lines.length, 2);
      }
    );
  });

  await t.test("the new name alone never warns", () => {
    withEnv({ SIMGADGET_TRANSPORT: "stdio" }, () => {
      assert.deepEqual(captureStderr(() => readEnv("TRANSPORT")), []);
    });
  });

  await t.test("an empty string counts as unset on either spelling", () => {
    withEnv({ SIMGADGET_HTTP_HOST: "", IOS_SIMULATOR_MCP_HTTP_HOST: "" }, () => {
      assert.equal(readEnv("HTTP_HOST"), undefined);
    });
  });

  await t.test("an empty new name falls through to a set old name", () => {
    withEnv({ SIMGADGET_HTTP_HOST: "", IOS_SIMULATOR_MCP_HTTP_HOST: "1.2.3.4" }, () => {
      assert.equal(readEnv("HTTP_HOST"), "1.2.3.4");
    });
  });
});

test("every server variable", async (t) => {
  for (const { name, read, sample, expected } of VARIABLES) {
    await t.test(`${name}: the new spelling is read`, () => {
      withEnv({ [`SIMGADGET_${name}`]: sample }, () => {
        assert.deepEqual(read(), expected);
      });
    });

    await t.test(`${name}: the old spelling still works, and warns`, () => {
      withEnv({ [`IOS_SIMULATOR_MCP_${name}`]: sample }, () => {
        const lines = captureStderr(() => {
          assert.deepEqual(read(), expected);
        });
        assert.equal(lines.length, 1);
        assert.match(lines[0], new RegExp(`IOS_SIMULATOR_MCP_${name}`));
      });
    });

    await t.test(`${name}: the new spelling wins over the old`, () => {
      withEnv(
        { [`SIMGADGET_${name}`]: sample, [`IOS_SIMULATOR_MCP_${name}`]: "wrong:1" },
        () => {
          assert.deepEqual(read(), expected);
        }
      );
    });
  }
});

test("defaults when neither spelling is set", async (t) => {
  await t.test("transport is http", () => {
    withEnv({}, () => assert.equal(transport(), "http"));
  });

  await t.test("host is loopback", () => {
    withEnv({}, () => assert.equal(httpHost(), "127.0.0.1"));
  });

  await t.test("port is 8008", () => {
    withEnv({}, () => assert.equal(httpPort(), 8008));
  });

  await t.test("verbose is off", () => {
    withEnv({}, () => assert.equal(verbose(), false));
  });

  await t.test("cleanup-on-exit is on", () => {
    withEnv({}, () => assert.equal(cleanupOnExit(), true));
  });

  await t.test("no tools are filtered", () => {
    withEnv({}, () => assert.deepEqual(filteredTools(), []));
  });

  await t.test("no extra hosts are allowed", () => {
    withEnv({}, () => assert.deepEqual(allowedHosts(), []));
  });

  await t.test("there is no default output dir — paths.ts supplies it", () => {
    withEnv({}, () => assert.equal(defaultOutputDir(), undefined));
  });
});

test("transport", async (t) => {
  await t.test("is lowercased, so STDIO works", () => {
    withEnv({ SIMGADGET_TRANSPORT: "STDIO" }, () => {
      assert.equal(transport(), "stdio");
    });
  });
});

test("verbose", async (t) => {
  for (const yes of ["1", "true", "yes", "TRUE", "Yes"]) {
    await t.test(`${JSON.stringify(yes)} turns it on`, () => {
      withEnv({ SIMGADGET_VERBOSE: yes }, () => assert.equal(verbose(), true));
    });
  }

  // The old server's `envTruthy` recognised exactly three words. Anything
  // else is off, including things a reader might expect to work.
  for (const no of ["0", "false", "on", "y", "verbose"]) {
    await t.test(`${JSON.stringify(no)} leaves it off`, () => {
      withEnv({ SIMGADGET_VERBOSE: no }, () => assert.equal(verbose(), false));
    });
  }
});

test("cleanupOnExit", async (t) => {
  await t.test("only the literal false turns it off", () => {
    withEnv({ SIMGADGET_CLEANUP_ON_EXIT: "false" }, () => {
      assert.equal(cleanupOnExit(), false);
    });
  });

  await t.test("case does not matter", () => {
    withEnv({ SIMGADGET_CLEANUP_ON_EXIT: "FALSE" }, () => {
      assert.equal(cleanupOnExit(), false);
    });
  });

  // The asymmetry with VERBOSE, pinned so nobody "fixes" it into agreement:
  // a safety default must not be switchable off by a typo.
  await t.test("an unrecognised value leaves cleanup on", () => {
    withEnv({ SIMGADGET_CLEANUP_ON_EXIT: "0" }, () => {
      assert.equal(cleanupOnExit(), true);
    });
    withEnv({ SIMGADGET_CLEANUP_ON_EXIT: "no" }, () => {
      assert.equal(cleanupOnExit(), true);
    });
  });
});

test("httpPort", async (t) => {
  await t.test("a non-numeric port is NaN, not a silent 8008", () => {
    withEnv({ SIMGADGET_HTTP_PORT: "eight thousand" }, () => {
      assert.ok(Number.isNaN(httpPort()));
    });
  });
});

test("filteredTools", async (t) => {
  await t.test("splits on commas and trims", () => {
    withEnv({ SIMGADGET_FILTERED_TOOLS: "ui_tap, ui_type ,screenshot" }, () => {
      assert.deepEqual(filteredTools(), ["ui_tap", "ui_type", "screenshot"]);
    });
  });

  await t.test("a single name is a list of one", () => {
    withEnv({ SIMGADGET_FILTERED_TOOLS: "ui_view" }, () => {
      assert.deepEqual(filteredTools(), ["ui_view"]);
    });
  });
});

test("allowedHosts", async (t) => {
  await t.test("splits, trims and drops blanks", () => {
    withEnv({ SIMGADGET_ALLOWED_HOSTS: "a.test:8008, b.test:8008 ,," }, () => {
      assert.deepEqual(allowedHosts(), ["a.test:8008", "b.test:8008"]);
    });
  });
});

test("assertIdbPathUnset", async (t) => {
  await t.test("does nothing when neither spelling is set", () => {
    withEnv({}, () => assert.doesNotThrow(() => assertIdbPathUnset()));
  });

  await t.test("throws for the old spelling, naming it", () => {
    withEnv({ IOS_SIMULATOR_MCP_IDB_PATH: "/usr/local/bin/idb" }, () => {
      assert.throws(() => assertIdbPathUnset(), /IOS_SIMULATOR_MCP_IDB_PATH is no longer supported/);
    });
  });

  await t.test("throws for the new spelling too — it was never valid", () => {
    withEnv({ SIMGADGET_IDB_PATH: "/usr/local/bin/idb" }, () => {
      assert.throws(() => assertIdbPathUnset(), /SIMGADGET_IDB_PATH is no longer supported/);
    });
  });

  await t.test("points at COMPANION_PATH, which is the thing that does work", () => {
    withEnv({ SIMGADGET_IDB_PATH: "/x" }, () => {
      assert.throws(() => assertIdbPathUnset(), /SIMGADGET_COMPANION_PATH/);
    });
  });

  await t.test("never warns — it is a tombstone, not a deprecation shim", () => {
    withEnv({ IOS_SIMULATOR_MCP_IDB_PATH: "/x" }, () => {
      const lines = captureStderr(() => {
        assert.throws(() => assertIdbPathUnset());
      });
      assert.deepEqual(lines, []);
    });
  });
});
