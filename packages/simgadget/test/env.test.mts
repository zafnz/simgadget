import test from "node:test";
import assert from "node:assert/strict";

import { assertIdbPathUnset, readEnv, resetEnvWarnings } from "../src/env.ts";

/** Runs `fn` against a scratch copy of `process.env`, restored afterwards. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
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
    fn();
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

test("readEnv", async (t) => {
  await t.test("the new name wins when both are set", () => {
    withEnv(
      { SIMGADGET_COMPANION_PATH: "/new/path", IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path" },
      () => {
        assert.equal(readEnv("COMPANION_PATH"), "/new/path");
      }
    );
  });

  await t.test("the old name alone still works", () => {
    withEnv({ IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path" }, () => {
      assert.equal(readEnv("COMPANION_PATH"), "/old/path");
    });
  });

  await t.test("the old name warns, naming both spellings", () => {
    withEnv({ IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path" }, () => {
      const lines = captureStderr(() => readEnv("COMPANION_PATH"));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /IOS_SIMULATOR_MCP_COMPANION_PATH/);
      assert.match(lines[0], /SIMGADGET_COMPANION_PATH/);
    });
  });

  await t.test("the new name never warns", () => {
    withEnv({ SIMGADGET_COMPANION_PATH: "/new/path" }, () => {
      const lines = captureStderr(() => readEnv("COMPANION_PATH"));
      assert.equal(lines.length, 0);
    });
  });

  await t.test("the warning fires once per variable per process, not per read", () => {
    withEnv({ IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path" }, () => {
      const lines = captureStderr(() => {
        readEnv("COMPANION_PATH");
        readEnv("COMPANION_PATH");
        readEnv("COMPANION_PATH");
      });
      assert.equal(lines.length, 1);
    });
  });

  await t.test("each variable gets its own latch", () => {
    withEnv(
      {
        IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path",
        IOS_SIMULATOR_MCP_COMPANION_CACHE: "/old/cache",
      },
      () => {
        const lines = captureStderr(() => {
          readEnv("COMPANION_PATH");
          readEnv("COMPANION_CACHE");
        });
        assert.equal(lines.length, 2);
      }
    );
  });

  await t.test("neither set returns undefined", () => {
    withEnv({}, () => {
      assert.equal(readEnv("COMPANION_PATH"), undefined);
    });
  });

  await t.test("an empty string is treated as unset", () => {
    withEnv({ SIMGADGET_COMPANION_PATH: "" }, () => {
      assert.equal(readEnv("COMPANION_PATH"), undefined);
    });

    withEnv({ SIMGADGET_COMPANION_PATH: "", IOS_SIMULATOR_MCP_COMPANION_PATH: "/old/path" }, () => {
      assert.equal(readEnv("COMPANION_PATH"), "/old/path");
    });

    withEnv({ IOS_SIMULATOR_MCP_COMPANION_PATH: "" }, () => {
      assert.equal(readEnv("COMPANION_PATH"), undefined);
    });
  });
});

test("assertIdbPathUnset", async (t) => {
  await t.test("does nothing when neither spelling is set", () => {
    withEnv({}, () => {
      assert.doesNotThrow(() => assertIdbPathUnset());
    });
  });

  await t.test("throws for the old spelling, naming the replacement variable", () => {
    withEnv({ IOS_SIMULATOR_MCP_IDB_PATH: "/some/idb" }, () => {
      assert.throws(() => assertIdbPathUnset(), /SIMGADGET_COMPANION_PATH/);
    });
  });

  await t.test("throws for the new spelling too, naming the replacement variable", () => {
    withEnv({ SIMGADGET_IDB_PATH: "/some/idb" }, () => {
      assert.throws(() => assertIdbPathUnset(), /SIMGADGET_COMPANION_PATH/);
    });
  });

  await t.test("the error is a plain Error, not a SimGadgetError", () => {
    withEnv({ SIMGADGET_IDB_PATH: "/some/idb" }, () => {
      try {
        assertIdbPathUnset();
        assert.fail("expected a throw");
      } catch (error) {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).constructor, Error);
      }
    });
  });

  await t.test("an empty string does not count as set", () => {
    withEnv({ IOS_SIMULATOR_MCP_IDB_PATH: "" }, () => {
      assert.doesNotThrow(() => assertIdbPathUnset());
    });
  });
});
