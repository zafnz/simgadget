import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "../src/paths.ts";
import { resetEnvWarnings } from "../src/env.ts";

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

const home = os.homedir();

test("an absolute path is returned untouched", async (t) => {
  await t.test("even when a default output dir is set", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/shots" }, () => {
      assert.equal(ensureAbsolutePath("/var/tmp/x.png"), "/var/tmp/x.png");
    });
  });

  await t.test("and is not normalised on the way through", () => {
    withEnv({}, () => {
      assert.equal(ensureAbsolutePath("/a/b/../c.png"), "/a/b/../c.png");
    });
  });
});

test("~/ expands against the home directory", async (t) => {
  await t.test("in the caller's own path", () => {
    withEnv({}, () => {
      assert.equal(
        ensureAbsolutePath("~/Desktop/shot.png"),
        path.join(home, "Desktop/shot.png")
      );
    });
  });

  await t.test("even when a default output dir is set — the tilde wins", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/shots" }, () => {
      assert.equal(ensureAbsolutePath("~/shot.png"), path.join(home, "shot.png"));
    });
  });

  await t.test("in the default output dir itself", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "~/Movies" }, () => {
      assert.equal(ensureAbsolutePath("clip.mp4"), path.join(home, "Movies/clip.mp4"));
    });
  });

  await t.test("but a bare ~ is treated as a filename, not a home directory", () => {
    withEnv({}, () => {
      assert.equal(ensureAbsolutePath("~"), path.join(home, "Downloads", "~"));
    });
  });
});

test("a relative path joins the default output directory", async (t) => {
  await t.test("~/Downloads when nothing is set", () => {
    withEnv({}, () => {
      assert.equal(ensureAbsolutePath("shot.png"), path.join(home, "Downloads/shot.png"));
    });
  });

  await t.test("the configured directory when one is set", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/shots" }, () => {
      assert.equal(ensureAbsolutePath("shot.png"), "/tmp/shots/shot.png");
    });
  });

  await t.test("keeping any subdirectory the caller asked for", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/shots" }, () => {
      assert.equal(ensureAbsolutePath("run7/shot.png"), "/tmp/shots/run7/shot.png");
    });
  });

  await t.test("and never the process's working directory", () => {
    withEnv({}, () => {
      const resolved = ensureAbsolutePath("shot.png");
      assert.notEqual(resolved, path.resolve("shot.png"));
      assert.ok(resolved.startsWith(path.join(home, "Downloads")));
    });
  });

  await t.test("a ./ prefix is still relative, and still lands in the default dir", () => {
    withEnv({ SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/shots" }, () => {
      assert.equal(ensureAbsolutePath("./shot.png"), "/tmp/shots/shot.png");
    });
  });
});

test("the old spelling of the default output dir still works", async (t) => {
  await t.test("IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR is honoured", () => {
    withEnv({ IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR: "/tmp/legacy" }, () => {
      assert.equal(ensureAbsolutePath("shot.png"), "/tmp/legacy/shot.png");
    });
  });

  await t.test("and the new spelling wins over it", () => {
    withEnv(
      {
        SIMGADGET_DEFAULT_OUTPUT_DIR: "/tmp/new",
        IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR: "/tmp/legacy",
      },
      () => {
        assert.equal(ensureAbsolutePath("shot.png"), "/tmp/new/shot.png");
      }
    );
  });
});
