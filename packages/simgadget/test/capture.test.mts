/**
 * Capture — SIMGADGET_PLAN.md step 6. Two layers in one file, because the
 * subject is one pipeline:
 *
 *  - **The argument builders**, table-driven. These are the point of the step.
 *    A missing `--` separator or a transposed `-z` produces a plausible, wrong
 *    image rather than an error, and would otherwise only be caught by looking
 *    at a screenshot from a real device and noticing it was subtly the wrong
 *    shape.
 *  - **The methods**, against the fake deps. What only this layer can show is
 *    which passes ran and in what order — that a landscape hint costs a
 *    rotation and a portrait one costs nothing, that the resize is computed
 *    from the portrait point dimensions, that `SIGINT` and not `SIGKILL` is
 *    what stops a recording, and that the per-call temp directory is gone
 *    whichever way the call ended.
 *
 * `sips` and `simctl` are never actually invoked here. The fake `run` writes
 * the files a real one would, so the pipeline's own reads and its `finally`
 * are exercised against a real temp directory, and answers `sips -g` with
 * whatever pixel dimensions the test wants the finished image to have.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Simulator } from "../src/simulator.ts";
import {
  parseSipsDimensions,
  pointDimensions,
  recordingArgs,
  rotationForOrientation,
  screenshotArgs,
  sipsArgs,
  sipsQueryArgs,
} from "../src/capture.ts";
import { SimGadgetError, SimulatorNotFoundError } from "../src/errors.ts";
import type { Orientation as OrientationHint } from "../src/ax/orientation.ts";
import {
  FakeChildProcess,
  createFakeDeps,
  type FakeDeps,
  type RunHandler,
} from "./fakes/deps.ts";
import { createFakeIdbClient, screenTree, targetDescription } from "./fakes/idb.ts";

const UDID = "UDID";

// ---- the argument builders -------------------------------------------------

test("rotationForOrientation", async (t) => {
  // Clockwise, which is what `sips --rotate` does; a comment in this repository
  // once claimed otherwise and was wrong about sips rather than about the code.
  const cases: Array<[string, number | null]> = [
    ["portrait", null],
    ["landscape_right", 90],
    ["landscape_left", 270],
    ["upside_down", 180],
    // `Orientation` is an open union, so a name nothing recognises reaches this
    // far. No rotation is the only answer that cannot make things worse.
    ["face_up", null],
  ];

  for (const [orientation, degrees] of cases) {
    await t.test(`${orientation} → ${degrees}`, () => {
      assert.equal(rotationForOrientation(orientation), degrees);
    });
  }
});

test("pointDimensions normalises a logical frame to portrait", async (t) => {
  const cases: Array<[{ width: number; height: number }, { width: number; height: number }]> = [
    [{ width: 390, height: 844 }, { width: 390, height: 844 }],
    [{ width: 874, height: 402 }, { width: 402, height: 874 }],
    [{ width: 500, height: 500 }, { width: 500, height: 500 }],
  ];

  for (const [frame, expected] of cases) {
    await t.test(`${frame.width}x${frame.height}`, () => {
      assert.deepEqual(pointDimensions(frame), expected);
    });
  }
});

test("screenshotArgs", async (t) => {
  await t.test("carries every option simctl takes, with `--` before the path", () => {
    assert.deepEqual(
      screenshotArgs({
        udid: UDID,
        outputPath: "/tmp/shot.png",
        format: "png",
        display: "external",
        mask: "black",
      }),
      [
        "simctl",
        "io",
        UDID,
        "screenshot",
        "--type=png",
        "--display=external",
        "--mask=black",
        "--",
        "/tmp/shot.png",
      ]
    );
  });

  await t.test("omits the flags it was not given", () => {
    assert.deepEqual(screenshotArgs({ udid: UDID, outputPath: "/tmp/shot.png" }), [
      "simctl",
      "io",
      UDID,
      "screenshot",
      "--",
      "/tmp/shot.png",
    ]);
  });

  await t.test("a path that looks like an option stays a path", () => {
    const args = screenshotArgs({ udid: UDID, outputPath: "--force.png" });
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "--force.png");
  });
});

test("sipsArgs", async (t) => {
  await t.test("`-z` takes the height first", () => {
    // The whole reason this function exists: swapping these two produces an
    // image of a plausible size that is wrong, on a device, silently.
    assert.deepEqual(
      sipsArgs({
        input: "/tmp/a.png",
        output: "/tmp/b.png",
        resize: { width: 390, height: 844 },
      }),
      ["-z", "844", "390", "/tmp/a.png", "--out", "/tmp/b.png"]
    );
  });

  await t.test("re-encodes with the format before the format options", () => {
    assert.deepEqual(
      sipsArgs({
        input: "/tmp/a.png",
        output: "/tmp/b.jpg",
        resize: { width: 390, height: 844 },
        format: "jpeg",
        quality: 80,
      }),
      [
        "-z",
        "844",
        "390",
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "80",
        "/tmp/a.png",
        "--out",
        "/tmp/b.jpg",
      ]
    );
  });

  await t.test("rotates clockwise, input and output last", () => {
    assert.deepEqual(sipsArgs({ input: "/tmp/a.png", output: "/tmp/b.png", rotate: 270 }), [
      "--rotate",
      "270",
      "/tmp/a.png",
      "--out",
      "/tmp/b.png",
    ]);
  });
});

test("sips dimension reads", async (t) => {
  await t.test("ask for both pixel dimensions of one file", () => {
    assert.deepEqual(sipsQueryArgs("/tmp/a.png"), [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      "/tmp/a.png",
    ]);
  });

  await t.test("parse the file name and indented properties sips answers with", () => {
    assert.deepEqual(
      parseSipsDimensions("/tmp/a.png\n  pixelWidth: 1206\n  pixelHeight: 2622\n"),
      { width: 1206, height: 2622 }
    );
  });

  await t.test("answer null for output that carries neither", () => {
    assert.equal(parseSipsDimensions("/tmp/a.png\n  format: png\n"), null);
  });
});

test("recordingArgs", async (t) => {
  await t.test("carries every option, with `--` before the path", () => {
    assert.deepEqual(
      recordingArgs({
        udid: UDID,
        outputPath: "/tmp/clip.mp4",
        codec: "h264",
        display: "internal",
        mask: "alpha",
        force: true,
      }),
      [
        "simctl",
        "io",
        UDID,
        "recordVideo",
        "--codec=h264",
        "--display=internal",
        "--mask=alpha",
        "--force",
        "--",
        "/tmp/clip.mp4",
      ]
    );
  });

  await t.test("omits `--force` when it was not asked for", () => {
    const args = recordingArgs({ udid: UDID, outputPath: "/tmp/clip.mp4", force: false });
    assert.deepEqual(args, ["simctl", "io", UDID, "recordVideo", "--", "/tmp/clip.mp4"]);
  });
});

// ---- the screenshot pipeline ----------------------------------------------

/**
 * Reaches the orientation hint, which is `protected` and written only by
 * `rotate()` and `detectOrientation()`. Setting it directly is what keeps these
 * tests about capture rather than about a probe `rotation.test.mts` already
 * owns.
 */
class Hinted extends Simulator {
  setHint(hint: OrientationHint): void {
    this.orientationHint = hint;
  }
}

interface ImageToolOptions {
  /** What `sips -g` reports for the finished image. */
  pixels?: { width: number; height: number };
  /** Make every transforming `sips` pass fail, for the cleanup test. */
  sipsFails?: boolean;
}

/**
 * A `run` that writes the files `simctl` and `sips` would, so the pipeline's
 * own reads, its `writeFile` and its `finally` all run against a real temp
 * directory. Each pass appends its own arguments to the file it writes, so the
 * bytes that come back identify which stage produced them.
 */
function imageTools(options: ImageToolOptions = {}): RunHandler {
  const pixels = options.pixels ?? { width: 1206, height: 2622 };

  return async (cmd, args) => {
    if (cmd === "xcrun") {
      const output = args.at(-1)!;
      await writeFile(output, Buffer.from("capture"));
      // On stderr, with stdout blank, exactly as simctl does it.
      return { stdout: "", stderr: `Wrote screenshot to: ${output}` };
    }
    if (args[0] === "-g") {
      return {
        stdout: `${args.at(-1)}\n  pixelWidth: ${pixels.width}\n  pixelHeight: ${pixels.height}\n`,
        stderr: "",
      };
    }
    if (options.sipsFails) throw new Error("sips: fake failure");

    const output = args.at(-1)!;
    const input = args.at(-3)!;
    const source = await readFile(input);
    await writeFile(output, Buffer.concat([source, Buffer.from(`|${args.slice(0, -3).join(" ")}`)]));
    return { stdout: "", stderr: "" };
  };
}

interface CaptureHarness {
  sim: Hinted;
  deps: FakeDeps;
}

function captureHarness(
  options: ImageToolOptions & {
    hint?: OrientationHint;
    /** The portrait points `describe` reports, or `null` for a companion that
     * omits them. */
    points?: [number, number] | null;
    /** The logical root frame a screen read answers with. */
    screen?: [number, number];
  } = {}
): CaptureHarness {
  const points = options.points === undefined ? ([390, 844] as [number, number]) : options.points;
  const client = createFakeIdbClient({
    describe: () => (points ? targetDescription(points[0], points[1]) : {}),
    screen: () => screenTree(...(options.screen ?? [390, 844])),
  });
  const deps = createFakeDeps({ client, run: imageTools(options) });
  deps.recovery.markAnswered(UDID);
  const sim = new Hinted(UDID, "iPhone", deps);
  if (options.hint) sim.setHint(options.hint);
  return { sim, deps };
}

/** The `sips` invocations that transformed the image; the measurement is not one. */
const sipsPasses = (deps: FakeDeps): string[][] =>
  deps.calls.run.filter((call) => call.cmd === "sips" && call.args[0] !== "-g").map((c) => c.args);

/** Where the capture was written, and so which temp directory was made for it. */
const capturePath = (deps: FakeDeps): string =>
  deps.calls.run.find((call) => call.cmd === "xcrun")!.args.at(-1)!;

test("Simulator.screenshot", async (t) => {
  await t.test("resizes to the portrait point dimensions and rotates for a landscape hint", async () => {
    const { sim, deps } = captureHarness({
      hint: "landscape_right",
      pixels: { width: 844, height: 390 },
    });

    const shot = await sim.screenshot({ resizeTo: "points" });

    const passes = sipsPasses(deps);
    assert.equal(passes.length, 2);
    // Height first, and portrait — the capture is in physical portrait pixels
    // whatever the interface is doing.
    assert.deepEqual(passes[0].slice(0, 3), ["-z", "844", "390"]);
    assert.deepEqual(passes[1].slice(0, 2), ["--rotate", "90"]);
    // The rotation's input is the resize's output: two passes, in that order.
    assert.equal(passes[1][2], passes[0].at(-1));

    assert.equal(shot.orientation, "landscape_right");
    assert.equal(shot.format, "png");
    // The pixels of the returned image, which is the rotated one — not the
    // dimensions the resize asked for.
    assert.equal(shot.width, 844);
    assert.equal(shot.height, 390);
  });

  await t.test("a portrait hint performs no rotation pass at all", async () => {
    const { sim, deps } = captureHarness({ hint: "portrait" });

    const shot = await sim.screenshot({ resizeTo: "points" });

    const passes = sipsPasses(deps);
    assert.equal(passes.length, 1);
    assert.ok(!passes.flat().includes("--rotate"));
    assert.equal(shot.orientation, "portrait");
  });

  await t.test("a native capture makes no sips pass but the measurement", async () => {
    const { sim, deps } = captureHarness({ hint: "portrait" });

    const shot = await sim.screenshot();

    assert.deepEqual(sipsPasses(deps), []);
    assert.equal(shot.width, 1206);
    assert.equal(shot.height, 2622);
  });

  await t.test("takes the resize dimensions a caller gives verbatim", async () => {
    const { sim, deps } = captureHarness({ hint: "portrait" });

    await sim.screenshot({ resizeTo: { width: 200, height: 400 } });

    assert.deepEqual(sipsPasses(deps)[0].slice(0, 3), ["-z", "400", "200"]);
  });

  await t.test("jpeg is captured as png and encoded by sips at the requested quality", async () => {
    const { sim, deps } = captureHarness({ hint: "portrait" });

    const shot = await sim.screenshot({ format: "jpeg", quality: 60 });

    // simctl's own `--type=jpeg` takes no quality argument, so the capture is a
    // png and sips does the encoding — which is the only reason `quality` can
    // mean anything at all.
    assert.ok(deps.calls.run[0].args.includes("--type=png"));
    const pass = sipsPasses(deps)[0];
    assert.deepEqual(pass.slice(0, 6), ["-s", "format", "jpeg", "-s", "formatOptions", "60"]);
    assert.equal(shot.format, "jpeg");
  });

  await t.test("falls back to the root frame when the companion reports no points", async () => {
    const { sim, deps } = captureHarness({
      hint: "landscape_right",
      points: null,
      screen: [874, 402],
    });

    await sim.screenshot({ resizeTo: "points" });

    // The logical frame is landscape; the resize that follows a portrait
    // capture is not.
    assert.deepEqual(sipsPasses(deps)[0].slice(0, 3), ["-z", "874", "402"]);
  });

  await t.test("writes the final image to `path`, and leaves no temp directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "simgadget-capture-test-"));
    const destination = path.join(directory, "shot.png");
    const { sim, deps } = captureHarness({ hint: "landscape_left" });

    try {
      const shot = await sim.screenshot({ resizeTo: "points", path: destination });

      // The *final* image: the bytes each fake pass appends make a rotated file
      // distinguishable from the resized one it came from.
      assert.deepEqual(readFileSync(destination), shot.data);
      assert.ok(shot.data.toString().includes("--rotate 270"));
      assert.equal(existsSync(path.dirname(capturePath(deps))), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("removes the temp directory even when a pass throws", async () => {
    const { sim, deps } = captureHarness({ hint: "portrait", sipsFails: true });

    await assert.rejects(sim.screenshot({ resizeTo: "points" }), /fake failure/);

    // A library has no shutdown hook to sweep these up later, so the `finally`
    // is the only thing standing between a long-lived host and a temp directory
    // per screenshot.
    assert.equal(existsSync(path.dirname(capturePath(deps))), false);
  });

  await t.test("a simctl 'Invalid device' failure surfaces as SimulatorNotFoundError", async () => {
    const deps = createFakeDeps({
      run: () => {
        throw new Error("Invalid device: UDID");
      },
    });
    const sim = new Hinted(UDID, "iPhone", deps);
    sim.setHint("portrait");

    await assert.rejects(sim.screenshot(), (error: unknown) => {
      assert.ok(error instanceof SimulatorNotFoundError);
      return true;
    });
  });
});

// ---- recording -------------------------------------------------------------

interface RecordingHarness {
  sim: Simulator;
  deps: FakeDeps;
  children: FakeChildProcess[];
}

function recordingHarness(): RecordingHarness {
  const children: FakeChildProcess[] = [];
  const deps = createFakeDeps({
    spawn: () => {
      const child = new FakeChildProcess();
      children.push(child);
      return child;
    },
  });
  return { sim: new Simulator(UDID, "iPhone", deps), deps, children };
}

/**
 * Starts a recording and lets the child say so.
 *
 * The greeting is emitted synchronously after the call, which is deterministic
 * rather than lucky: `startRecording` spawns and attaches its listeners before
 * its first `await`, precisely so nothing said in that window is missed.
 */
function startRecording(
  harness: RecordingHarness,
  outputPath = "out.mp4"
): Promise<void> {
  const started = harness.sim.startRecording(outputPath);
  harness.children.at(-1)!.emitStderr("Recording started\n");
  return started;
}

test("Simulator.startRecording", async (t) => {
  await t.test("spawns simctl recordVideo with `--` before the resolved path", async () => {
    const harness = recordingHarness();

    await startRecording(harness, "clip.mp4");

    assert.deepEqual(harness.deps.calls.spawn[0], {
      cmd: "xcrun",
      // DECISIONS.md #12: `path.resolve` and nothing more — no `~/Downloads`,
      // which is host policy.
      args: ["simctl", "io", UDID, "recordVideo", "--", path.resolve("clip.mp4")],
    });
  });

  await t.test("a second recording throws recording-already-active, spawning nothing", async () => {
    const harness = recordingHarness();
    await startRecording(harness);

    await assert.rejects(harness.sim.startRecording("second.mp4"), (error: unknown) => {
      assert.ok(error instanceof SimGadgetError);
      assert.equal(error.code, "recording-already-active");
      return true;
    });
    assert.equal(harness.deps.calls.spawn.length, 1);
  });

  await t.test("a process that stays silent is assumed to be recording", async () => {
    const harness = recordingHarness();

    // No greeting at all: simctl's is not something to depend on, and a caller
    // who asked for a recording and got one is not helped by an error about a
    // missing line of stderr.
    const started = harness.sim.startRecording("out.mp4");

    // The fallback only fires because this test fires it. That is the point of
    // it being a cancellable timer rather than a sleep: nothing resolves this
    // wait on its own, in a test or in production.
    const fallback = harness.deps.calls.timers.at(-1)!;
    assert.equal(fallback.ms, 3_000);
    fallback.fire();

    await started;
  });

  // The other half of the same rule, and the one that costs a user something
  // when it is wrong. A `setTimeout` nobody clears keeps Node's event loop
  // alive, so an uncancelled fallback put a silent three-second tail on the
  // exit of every script that recorded anything — measured at 3001ms. It never
  // showed up in the server, which outlived the timer by hours.
  await t.test("a start that announces itself cancels the fallback timer", async () => {
    const harness = recordingHarness();

    const started = harness.sim.startRecording("out.mp4");
    harness.children[0].emitStderr("Recording started\n");
    await started;

    const fallback = harness.deps.calls.timers.at(-1)!;
    assert.equal(fallback.cancelled, true);
  });

  await t.test("a start that fails cancels the fallback timer too", async () => {
    const harness = recordingHarness();

    const started = harness.sim.startRecording("out.mp4");
    harness.children[0].emitStderr("The output file already exists\n");
    harness.children[0].emitClose(1);
    await assert.rejects(started);

    assert.equal(harness.deps.calls.timers.at(-1)!.cancelled, true);
  });

  await t.test("a process that exits early rejects with what it wrote to stderr", async () => {
    const harness = recordingHarness();

    const started = harness.sim.startRecording("out.mp4");
    harness.children[0].emitStderr("The output file already exists\n");
    harness.children[0].emitClose(1);

    await assert.rejects(started, /already exists/);
    // The failed start left no recording behind, so the handle can try again.
    await assert.rejects(harness.sim.stopRecording(), (error: unknown) => {
      assert.ok(error instanceof SimGadgetError);
      assert.equal(error.code, "no-active-recording");
      return true;
    });
  });

  await t.test("a recording that dies on its own releases the handle", async () => {
    const harness = recordingHarness();
    await startRecording(harness);

    harness.children[0].emitClose(0);
    await startRecording(harness, "second.mp4");

    assert.equal(harness.deps.calls.spawn.length, 2);
  });

  await t.test("a recording that dies the instant it starts releases the handle too", async () => {
    // The narrow window: the child announces itself and then closes before
    // `startRecording` has published it. Both halves of the guard are needed
    // for this — the listener has to exist already (it is attached with the
    // spawn, not after `await started`), and the close it sees has to stop
    // the publish, because at that moment there is nothing yet to clear.
    // Without either, the handle ends up holding a process that has already
    // gone and refuses every later recording until someone stops a corpse.
    const harness = recordingHarness();

    const started = harness.sim.startRecording("out.mp4");
    const child = harness.children.at(-1)!;
    child.emitStderr("Recording started\n");
    child.emitClose(0);
    await started;

    await assert.doesNotReject(startRecording(harness, "second.mp4"));
    assert.equal(harness.deps.calls.spawn.length, 2);
  });
});

test("Simulator.stopRecording", async (t) => {
  await t.test("throws no-active-recording when nothing is running", async () => {
    const harness = recordingHarness();

    await assert.rejects(harness.sim.stopRecording(), (error: unknown) => {
      assert.ok(error instanceof SimGadgetError);
      assert.equal(error.code, "no-active-recording");
      return true;
    });
  });

  await t.test("interrupts with SIGINT, waits, and returns the path it started with", async () => {
    const harness = recordingHarness();
    await startRecording(harness, "clip.mp4");

    const stopped = await harness.sim.stopRecording();

    // SIGINT, never SIGKILL: the interrupt is what lets simctl finalize the
    // container. A killed recording leaves a file that exists, has a plausible
    // size, and will not play.
    assert.deepEqual(harness.children[0].signals, ["SIGINT"]);
    assert.equal(harness.deps.calls.sleep.at(-1), 1_000);
    assert.deepEqual(stopped, { path: path.resolve("clip.mp4") });
  });

  await t.test("leaves nothing to stop a second time", async () => {
    const harness = recordingHarness();
    await startRecording(harness);
    await harness.sim.stopRecording();

    await assert.rejects(harness.sim.stopRecording(), (error: unknown) => {
      assert.ok(error instanceof SimGadgetError);
      assert.equal(error.code, "no-active-recording");
      return true;
    });
    assert.deepEqual(harness.children[0].signals, ["SIGINT"]);
  });
});

/**
 * Deleting the device does not stop `simctl io ... recordVideo`.
 *
 * Watched happen: a script started a recording, deleted its simulator, and
 * exited; six minutes later the recorder was still running against a udid that
 * `simctl list devices` no longer knew, writing to a file nothing would ever
 * finalize. So `delete()` stops its handle's recording first — which is also
 * the only ordering that can finalize the file, since after the delete there is
 * nothing left to record.
 */
test("Simulator.delete stops a recording it would otherwise orphan", async (t) => {
  await t.test("signals the recorder before the device goes away", async () => {
    const harness = recordingHarness();
    await startRecording(harness);

    await harness.sim.delete();

    assert.deepEqual(harness.children[0].signals, ["SIGINT"]);
    // Order is the assertion, not just the signal: a stop after the delete
    // would be signalling a recorder whose device had already gone.
    const stopIndex = harness.deps.calls.order.findIndex((c) => c.startsWith("sleep:1000"));
    const deleteIndex = harness.deps.calls.order.findIndex((c) =>
      c.includes("simctl delete")
    );
    assert.ok(stopIndex >= 0 && deleteIndex >= 0);
    assert.ok(
      stopIndex < deleteIndex,
      `expected the recording to be stopped before the delete, got ${harness.deps.calls.order.join(" | ")}`
    );
  });

  await t.test("deletes anyway when the recording cannot be stopped", async () => {
    const harness = recordingHarness();
    await startRecording(harness);
    harness.children[0].kill = () => {
      throw new Error("no such process");
    };

    // A recorder that will not die must not strand the caller with a simulator
    // they asked to have deleted. The exit hook is the backstop for it.
    await harness.sim.delete();

    assert.ok(harness.deps.calls.order.some((c) => c.includes("simctl delete")));
  });
});
