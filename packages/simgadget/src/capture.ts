/**
 * Screenshots and video recording — SIMGADGET_PLAN.md step 6, porting the
 * `ui_view` pipeline (index.ts:2171-2288) and the `screenshot` / `record_video`
 * / `stop_recording` tool bodies (index.ts:2352, :2430, :2539).
 *
 * `screenshot()`, `startRecording()` and `stopRecording()` are methods on
 * `Simulator` and stay there, because all three need handle state the class
 * owns — the orientation hint, the cached portrait point dimensions, the
 * one-recording-per-handle slot. What lives here is everything underneath
 * them: the argument builders, the temp-file pipeline and the recording's
 * start/stop protocol, all of which are about `simctl`, `sips` and a child
 * process rather than about a simulator. That is the split `lifecycle.ts`
 * already uses, and it is what makes a mis-ordered `-z` or a missing `--`
 * checkable without a device.
 *
 * Two facts govern the whole screenshot pipeline, and neither is obvious:
 *
 *  - **`simctl io ... screenshot` always captures in physical portrait pixel
 *    orientation**, whatever the interface is doing. Everything below — the
 *    portrait-normalised resize, the rotation at the end — follows from that
 *    one sentence.
 *  - **It reports success on stderr, with stdout blank.** Reading stdout looks
 *    like the fix and is the bug.
 */

import type { Orientation } from "./lifecycle.ts";
import type { SimulatorDeps } from "./internal/deps.ts";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import type { ChildProcess } from "child_process";
import os from "os";
import path from "path";

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "tiff" | "bmp" | "gif"; // default "png"
  /** JPEG quality 1–100, default 80. Ignored for other formats. */
  quality?: number;
  /** Resize before returning. "points" = the screen's logical point
   * dimensions (what an agent's coordinates live in). Default: no resize,
   * native pixels. */
  resizeTo?: "points" | { width: number; height: number };
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
  /** Also write the final image here (absolute path). */
  path?: string;
}

export interface Screenshot {
  data: Buffer;
  format: string;
  width: number; // pixels of the returned image
  height: number;
  /** The capture is always rotated to match the interface orientation —
   * simctl captures in physical portrait regardless, and shipping sideways
   * screenshots would re-ship a bug this repository already fixed. */
  orientation: Orientation;
}

export interface RecordingOptions {
  codec?: "h264" | "hevc";
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
  force?: boolean;
}

/** The default JPEG quality, as `ui_view` has always used. */
const DEFAULT_JPEG_QUALITY = 80;

/**
 * How long to wait for `simctl io ... recordVideo` to say it started before
 * assuming it did. Ported with its behaviour from index.ts:2495: a process that
 * is still alive at this point is recording, whatever it has or has not said on
 * stderr, and the caller is better served by a recording than by an error about
 * a greeting.
 */
const RECORDING_START_TIMEOUT_MS = 3_000;

/**
 * The pause after `SIGINT` that lets simctl finalize the file (index.ts:2554).
 * Returning before the container is written hands the caller a path to a file
 * that is not a video yet.
 */
const RECORDING_FINALIZE_MS = 1_000;

// ---- pure argument builders ------------------------------------------------
//
// These exist because a `--` separator or a mis-ordered `-z` is invisible in
// review, produces a plausible wrong image rather than an error, and otherwise
// only shows up on a real device.

/**
 * How far to turn a portrait capture, clockwise, for the interface to look
 * upright — or `null` when it already does.
 *
 * `sips --rotate` turns the image **clockwise**; an earlier comment in this
 * repository claimed counter-clockwise, and was wrong about sips rather than
 * about the code. The mapping is the one `transformPointToPortrait` implies,
 * which is what keeps a screenshot and a tap agreeing about where things are.
 */
export function rotationForOrientation(orientation: Orientation): number | null {
  switch (orientation) {
    case "landscape_right":
      return 90;
    case "landscape_left":
      return 270;
    case "upside_down":
      return 180;
    default:
      // "portrait", and — `Orientation` being an open union — anything else a
      // caller has invented. No rotation is the right answer for both.
      return null;
  }
}

/**
 * A logical screen rectangle as **portrait** point dimensions.
 *
 * The screenshot arrives in physical portrait whatever the interface is doing,
 * so the resize that follows it is in portrait too: min is the width and max is
 * the height, regardless of which way round the frame reported them. Ports
 * index.ts:2183-2184.
 */
export function pointDimensions(frame: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.min(frame.width, frame.height),
    height: Math.max(frame.width, frame.height),
  };
}

export interface ScreenshotArgs {
  udid: string;
  outputPath: string;
  format?: string;
  display?: "internal" | "external";
  mask?: "ignored" | "alpha" | "black";
}

/** `xcrun`'s arguments for one capture. */
export function screenshotArgs(opts: ScreenshotArgs): string[] {
  return [
    "simctl",
    "io",
    opts.udid,
    "screenshot",
    ...(opts.format ? [`--type=${opts.format}`] : []),
    ...(opts.display ? [`--display=${opts.display}`] : []),
    ...(opts.mask ? [`--mask=${opts.mask}`] : []),
    // `--` separates simctl's options from the positional path, so a path that
    // begins with a dash is a path rather than an unknown option.
    "--",
    opts.outputPath,
  ];
}

export interface SipsArgs {
  input: string;
  output: string;
  /** Exact pixel dimensions. **`-z` takes the height first**: that is sips'
   * argument order, and getting it backwards produces a plausible, wrong
   * image rather than an error. */
  resize?: { width: number; height: number };
  /** Clockwise degrees. */
  rotate?: number;
  /** Re-encode to this format on the way out. */
  format?: string;
  /** JPEG quality, 1–100. Meaningless for the other formats. */
  quality?: number;
}

/**
 * One `sips` invocation.
 *
 * The pipeline never asks for a resize and a rotation in the same call, though
 * this builder can express it: which order sips would apply them in is not
 * something this repository has measured, and `-z`'s exact dimensions mean
 * getting that order wrong would silently transpose the result. Two calls, as
 * `ui_view` has always made them.
 *
 * No `--` separator, because sips has no such thing — which is safe only
 * because every path handed to sips is one this file made in its own temp
 * directory. A caller's own `path` is written with `fs`, never passed here.
 */
export function sipsArgs(opts: SipsArgs): string[] {
  const args: string[] = [];
  if (opts.resize) args.push("-z", String(opts.resize.height), String(opts.resize.width));
  if (opts.rotate !== undefined) args.push("--rotate", String(opts.rotate));
  if (opts.format) args.push("-s", "format", opts.format);
  if (opts.quality !== undefined) args.push("-s", "formatOptions", String(opts.quality));
  args.push(opts.input, "--out", opts.output);
  return args;
}

/** `sips`' arguments for reading an image's pixel dimensions back. */
export function sipsQueryArgs(file: string): string[] {
  return ["-g", "pixelWidth", "-g", "pixelHeight", file];
}

/**
 * The pixel dimensions out of `sips -g`'s output, which is the file name
 * followed by one indented `key: value` line per property.
 */
export function parseSipsDimensions(
  stdout: string
): { width: number; height: number } | null {
  const width = stdout.match(/pixelWidth:\s*(\d+)/);
  const height = stdout.match(/pixelHeight:\s*(\d+)/);
  if (!width || !height) return null;
  return { width: Number(width[1]), height: Number(height[1]) };
}

export interface RecordingArgs extends RecordingOptions {
  udid: string;
  outputPath: string;
}

/** `xcrun`'s arguments for one recording. */
export function recordingArgs(opts: RecordingArgs): string[] {
  return [
    "simctl",
    "io",
    opts.udid,
    "recordVideo",
    ...(opts.codec ? [`--codec=${opts.codec}`] : []),
    ...(opts.display ? [`--display=${opts.display}`] : []),
    ...(opts.mask ? [`--mask=${opts.mask}`] : []),
    ...(opts.force ? ["--force"] : []),
    // As above: `--` so a path is a path.
    "--",
    opts.outputPath,
  ];
}

// ---- the screenshot pipeline -----------------------------------------------

/** What the handle has resolved before the pipeline can run. */
export interface CaptureGeometry {
  /** The interface orientation the image must be rotated to match. */
  orientation: Orientation;
  /** Exact pixel dimensions to resample to, or `null` for native pixels. */
  resize: { width: number; height: number } | null;
}

/**
 * Capture, resize, rotate, measure — and clean up after itself.
 *
 * **The rotation always happens**, not only for the compressed-view path it was
 * written for: simctl captures in physical portrait whatever the interface is
 * doing, so a landscape screenshot that skipped this step would arrive on its
 * side. That is a bug this repository has already fixed once, and the
 * `Screenshot.orientation` field is what says which way up the returned image
 * is.
 *
 * A **per-call** temp directory, removed in a `finally`. The server this ports
 * made one directory at startup and removed it at shutdown; a library has no
 * shutdown to hang that on, and leaking capture-sized files into a long-lived
 * host until it exits is not a trade worth making for one `mkdtemp`.
 */
export async function captureScreenshot(
  deps: SimulatorDeps,
  udid: string,
  opts: ScreenshotOptions,
  geometry: CaptureGeometry
): Promise<Screenshot> {
  const format = opts.format ?? "png";
  // JPEG is captured as PNG and encoded by sips, because `quality` has no other
  // way in: simctl's own `--type=jpeg` takes no quality argument. This is what
  // `ui_view` has always done, and the extra pass is the price of the option.
  const captureFormat = format === "jpeg" ? "png" : format;

  const directory = await mkdtemp(path.join(os.tmpdir(), "simgadget-capture-"));
  try {
    const raw = path.join(directory, `capture.${captureFormat}`);
    const { stderr } = await deps.run(
      "xcrun",
      screenshotArgs({
        udid,
        outputPath: raw,
        format: captureFormat,
        display: opts.display,
        mask: opts.mask,
      })
    );
    // The command is weird: it reports success on stderr and leaves stdout
    // blank. Anything else on stderr is the failure it forgot to exit non-zero
    // for.
    if (stderr && !stderr.includes("Wrote screenshot to")) throw new Error(stderr);

    let current = raw;

    if (geometry.resize || format !== captureFormat) {
      const resized = path.join(directory, `resized.${format}`);
      await deps.run(
        "sips",
        sipsArgs({
          input: current,
          output: resized,
          resize: geometry.resize ?? undefined,
          format,
          quality: format === "jpeg" ? (opts.quality ?? DEFAULT_JPEG_QUALITY) : undefined,
        })
      );
      current = resized;
    }

    const degrees = rotationForOrientation(geometry.orientation);
    if (degrees !== null) {
      const rotated = path.join(directory, `rotated.${format}`);
      await deps.run("sips", sipsArgs({ input: current, output: rotated, rotate: degrees }));
      current = rotated;
    }

    const data = await readFile(current);
    const size = await measureImage(deps, current);
    // The caller's own path is written here rather than handed to simctl or
    // sips: it is the one path in this function that did not come from
    // `mkdtemp`, and nothing in the pipeline needs it to be a command argument.
    if (opts.path) await writeFile(path.resolve(opts.path), data);

    return {
      data,
      format,
      width: size.width,
      height: size.height,
      orientation: geometry.orientation,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The pixels of the finished image, measured rather than predicted.
 *
 * The one fact `Screenshot` promises that no earlier step knows: a native
 * capture's size belongs to the device, a resize is only exactly what was asked
 * for if `-z` means what we think it does, and a 90° rotation transposes
 * whichever it was. Measuring costs one ~15ms process and cannot be wrong; the
 * arithmetic can.
 */
async function measureImage(
  deps: SimulatorDeps,
  file: string
): Promise<{ width: number; height: number }> {
  const { stdout } = await deps.run("sips", sipsQueryArgs(file));
  const size = parseSipsDimensions(stdout);
  if (!size) {
    throw new Error(`Could not read the captured image's dimensions from sips: ${stdout}`);
  }
  return size;
}

// ---- recording -------------------------------------------------------------

/**
 * Resolves once the recording is under way, and rejects if it never starts.
 *
 * Ported whole from index.ts:2460-2509, including the part that reads like a
 * bug and is not: a process that is still alive after
 * `RECORDING_START_TIMEOUT_MS` without having said "Recording started" is
 * treated as recording. simctl's greeting is not something to depend on, and a
 * caller who asked for a recording and got one is not helped by an error about
 * a missing line of stderr.
 *
 * **Every listener is attached synchronously**, before this function's first
 * `await`, so nothing the child says can be missed between spawning it and
 * listening to it.
 */
export function waitForRecordingStart(
  deps: SimulatorDeps,
  child: ChildProcess
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let errorOutput = "";
    let settled = false;

    let cancelFallback = () => {};

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        // Whichever way this resolved, the fallback below has lost its race and
        // must not keep the process alive waiting to fire. See
        // `SimulatorDeps.setTimer`: an uncancelled timer here put a silent
        // three-second tail on the exit of every script that recorded anything.
        cancelFallback();
        fn();
      }
    };

    child.stderr?.on("data", (data: unknown) => {
      const message = String(data);
      if (message.includes("Recording started")) {
        settle(resolve);
      } else {
        errorOutput += message;
      }
    });

    child.on("close", (code) => {
      settle(() =>
        reject(new Error(errorOutput.trim() || `Recording process exited with code ${code}`))
      );
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });

    // `simctl` does not always announce itself. A process still alive after
    // this long without having said "Recording started" is taken to be
    // recording; one that has exited by then failed and never said why.
    //
    // Through `deps.setTimer` rather than `deps.sleep` so that settling can
    // call the timer off — see that method for what an uncancelled one costs.
    cancelFallback = deps.setTimer(RECORDING_START_TIMEOUT_MS, () =>
      settle(() => {
        if (child.exitCode !== null) {
          reject(new Error(errorOutput.trim() || "Recording process exited unexpectedly"));
        } else {
          resolve();
        }
      })
    );
  });
}

/**
 * Stops a recording and waits for the file to be finished.
 *
 * **`SIGINT`, never `SIGKILL`.** The interrupt is what lets `simctl io
 * recordVideo` finalize the container; killing it outright leaves a file that
 * exists, has a plausible size, and will not play.
 */
export async function stopRecordingProcess(
  deps: SimulatorDeps,
  child: ChildProcess
): Promise<void> {
  child.kill("SIGINT");
  await deps.sleep(RECORDING_FINALIZE_MS);
}
