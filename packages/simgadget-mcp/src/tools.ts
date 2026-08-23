/**
 * All seventeen tool registrations, side by side, and nothing else that runs.
 *
 * This file is the surviving half of the old single-file rule (CLAUDE.md's
 * Design Principles, SIMGADGET.md's "The MCP on top"). The registrations stay
 * together because they are repetitive and are read side by side: seventeen
 * descriptions that must agree about what a session is, seventeen schemas that
 * must spell `id` identically, and one wrong `readOnlyHint` is invisible in a
 * file of its own and obvious in a column of sixteen others.
 *
 * ## What a tool body is allowed to be
 *
 * One library call and one render. That is not a style preference, it is the
 * split rule: the old `ui_tap` body was 215 lines of element resolution,
 * coordinate transformation, hit-testing and toggle detection, and every one
 * of those lines is now `sim.tap()`, tested against a fake companion in the
 * package next door. **A tool body that starts branching on element types,
 * computing coordinates or deciding what a toggle is has crossed into the
 * library**, and the fix is a library commit, never a second copy here.
 *
 * What is left, and legitimately lives here:
 *
 *  - **Zod validation** — the shapes below, which are the agent-facing
 *    contract and are copied verbatim from the captured baseline.
 *  - **Session lookup**, via the registry, because a session id is a server
 *    concept the library has never heard of.
 *  - **Path resolution**, for the two tools that take an output path: the
 *    library takes absolute paths only and `~/Downloads` is host policy
 *    (DECISIONS.md #12).
 *  - **Rendering**, all of it delegated to `render.ts`.
 *  - **The MCP wire shapes**: a text block, or in `ui_view`'s case a base64
 *    image block, which is the one thing here with no JavaScript use at all.
 *
 * ## Three quirks that are load-bearing
 *
 * **Filtering removes a tool, it does not disable it.** `SIMGADGET_FILTERED_TOOLS`
 * is read once per `registerTools` call and a filtered name is never
 * registered, so it is absent from `tools/list` — an agent cannot call what it
 * cannot see, which is the whole point of the variable.
 *
 * **Descriptions and schemas are the baseline's, verbatim.** They are what an
 * agent reads and what it validates against, and a tidied sentence is a
 * behaviour change wearing a typo fix's clothes.
 * `test/fixtures/tools-list.baseline.json` is the authority and
 * `test/tools.test.mts` diffs every registration against it.
 *
 * **`handleToolError` gets `{sessionId: id}` from every body.** Two error rows
 * — `simulator-not-found` and `no-active-recording` — say something materially
 * more useful when they can name the session, and this is the only way that
 * fact reaches them: the library has no concept of a session and must not be
 * given one.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";

import { filteredTools } from "./env.ts";
import { ensureAbsolutePath } from "./paths.ts";
import {
  handleToolError,
  renderAppInstalled,
  renderAppLaunched,
  renderAttached,
  renderDestroyed,
  renderDetectedOrientation,
  renderElement,
  renderNoElementFound,
  renderRecordingStarted,
  renderRecordingStopped,
  renderResumed,
  renderRotate,
  renderScreen,
  renderScreenshotCaptured,
  renderScreenshotSaved,
  renderStarted,
  renderSwiped,
  renderTap,
  renderTyped,
  textResult,
} from "./render.ts";
import type { SessionRegistry } from "./sessions.ts";

import { SimulatorNotFoundError, type ReadyResult, type TapTarget } from "simgadget";

/**
 * Sent to every client at handshake, so it is the only guidance most agents
 * ever get. Kept dense: it costs tokens in every session.
 *
 * Verbatim from index.ts:680; `index.ts` passes it to the `McpServer`
 * constructor. It names tools, not library methods, which is why it lives in
 * the server and could not live in `simgadget`.
 */
export const SERVER_INSTRUCTIONS =
  "iOS Simulator MCP server. Every tool takes an `id` identifying your session, which owns one simulator. " +
  "Choose a distinctive id for yourself (e.g. \"qa-login-flow\", not \"test\") and reuse it for every call — other agents may be driving their own simulators on this same server, and sharing an id means taking over each other's. Calling start_simulator again with the same id resumes your existing simulator. Call destroy_simulator when finished.\n" +
  "Do not use `xcrun simctl`, `idb`, or other shell commands to control simulators; this server owns their lifecycle and cannot see changes made behind its back.\n" +
  "Navigation: if you know what you want, tap it by name — ui_tap {label} resolves the element on the simulator and operates it, costing a few hundred bytes and no coordinate handling. ui_find {label} locates an element, or reports it absent as a normal answer. Only use ui_describe_all when you do not know what is on screen: it returns the whole tree and is several kilobytes. Labels match by case-sensitive substring, against an element's label, its visible text or its accessibility identifier, and curly quotes, apostrophes and dashes are treated as their plain equivalents — ask for what you see on screen. The first match wins, so name things precisely; ui_tap tells you which element it acted on.\n" +
  "ui_tap can refuse, and the refusal is the useful answer: it checks the touch will reach the element before sending it, so a control that is covered, scrolled out of view or disabled is reported instead of silently missed. Scroll it into view, or read its real position from ui_view and use ui_tap {x, y}. A switch is switched rather than touched, and ui_tap answers with the state it read back — so if it says the state did not change, it did not.\n" +
  "start_simulator does not return until the simulator answers, so you can use it immediately; it says so if it gave up waiting.\n" +
  "ui_describe_all reads the app's real view hierarchy, so it includes controls in tab bars, nav bars and toolbars, and is pruned to elements you can act on. It and a failed ui_find each cost ~300ms, so do not poll either in a tight loop.\n" +
  "Coordinates are logical screen space. ui_describe_all frames feed directly into ui_tap, ui_swipe and ui_describe_point.\n" +
  "Visual checks: if asked whether something looks right — layout, colour, alignment, anything about appearance — call ui_view and look at the screenshot. The accessibility tree shows what exists, not how it renders; an element can be present and correctly labelled while looking completely wrong. Do not derive tap coordinates from a screenshot: those are pixel space and stop matching logical space once the device is rotated.";

// ---- the one schema every tool shares --------------------------------------

/**
 * The session id, on all seventeen tools.
 *
 * Verbatim from index.ts:399, down to the regex and the `max(128)`, because
 * this is the single most-read schema in the server: it appears in every
 * `tools/list` entry an agent sees. The character class is the reason it is a
 * schema at all — an id reaches a `simctl` device name, and a permissive one
 * would put caller-supplied text into an argument list.
 */
export const sessionIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "Session ID must contain only alphanumeric characters, hyphens, and underscores")
  .describe("Unique identifier for your session");

/**
 * What `start_simulator` reports when the handle has no boot result at all.
 *
 * Unreachable through this tool — `createSimulator` boots by default and
 * records the outcome — but `lastBoot` is honestly optional, and the fallback
 * has to pick a direction. It picks the one that never claims a readiness
 * nobody measured: no wait, not ready, tell the caller to poll.
 */
const NEVER_BOOTED: ReadyResult = {
  ready: false,
  waitedMs: 0,
  recoveryTried: false,
  recovered: false,
};

// ---- registration ----------------------------------------------------------

/**
 * Registers every tool the environment has not filtered out.
 *
 * **`sessions` is a parameter, not a module global.** That is what lets the
 * whole surface be driven against fake handles in milliseconds; a registry
 * reached for at import time would make every test below need a simulator.
 * `index.ts` constructs the one real registry and passes it here — and in HTTP
 * mode passes the *same* one to a fresh `McpServer` per request, which is what
 * makes a session outlive the connection that created it.
 */
export function registerTools(server: McpServer, sessions: SessionRegistry): void {
  // Read once per call rather than at module load, so a test can set the
  // variable and see it take effect. Absent from `tools/list` is the whole
  // point: an agent cannot call a tool it cannot see.
  const filtered = filteredTools();
  const isToolFiltered = (toolName: string): boolean => filtered.includes(toolName);

  // ---- lifecycle -----------------------------------------------------------

  if (!isToolFiltered("start_simulator")) {
    server.tool(
      "start_simulator",
      "Creates, boots, and opens an iOS simulator for the given session. Each session can have one simulator — call destroy_simulator first to switch types.",
      {
        id: sessionIdSchema,
        type: z
          .string()
          .optional()
          .describe(
            'Device type keyword (e.g. "iPhone", "iPad", "iPhone 16 Pro"). Defaults to the latest iPhone.'
          ),
      },
      { title: "Start Simulator", readOnlyHint: false, openWorldHint: true },
      async ({ id, type }) =>
        handleToolError(
          "Error starting simulator",
          async () => {
            // Resume, and the reason this tool owns its own branching rather
            // than using `withSession`: an agent that disconnected and came
            // back with the same id should pick up exactly where it left off,
            // and an id whose simulator is gone should quietly get a new one.
            // Neither is a failure, so neither can be a refusal.
            const existing = sessions.get(id);
            if (existing) {
              // `state()` throws for a simulator that no longer exists, and
              // "no longer exists" is one of the two stale cases this branch
              // is here to absorb — the old server asked `findDevice`, which
              // answered `null` for a deleted device and for a shut-down one
              // alike (index.ts:1219-1235). Letting the throw out would refuse
              // to start a simulator *because* the last one was deleted, and
              // the refusal would advise calling destroy_simulator, which has
              // no session left to destroy. TODO #91.
              const state = await existing.sim.state().catch((error: unknown) => {
                if (error instanceof SimulatorNotFoundError) return "Gone" as const;
                throw error;
              });
              if (state === "Booted") {
                // Raise the window for the returning agent. `showWindow()`
                // exists for exactly this: `boot()` would be correct too and
                // would cost an unconditional 8s settle on a simulator that is
                // already up (SIMGADGET_PLAN_SERVER.md, "The library gap").
                await existing.sim.showWindow();
                return textResult(
                  renderResumed(id, existing.sim.name, existing.sim.udid)
                );
              }
              // Stale: the simulator is shut down, or gone entirely. Drop it
              // and create below — `create` deliberately does not check for an
              // existing session, so resolving this one is the caller's job.
              sessions.drop(id);
            }

            const keyword = type || "iPhone";
            // The device name is the server's to compose: it carries the
            // session id, which is a server concept the library has never
            // heard of (SIMGADGET.md, "The split rule"). index.ts:1253.
            const deviceName = `${id}_${keyword.toLowerCase().replace(/\s+/g, "-")}`;

            const { sim } = await sessions.create(id, {
              deviceType: keyword,
              name: deviceName,
            });

            return textResult(
              renderStarted({
                deviceName: sim.name,
                // The friendly model name ("iPhone 16 Pro"), which the handle
                // keeps from the create that resolved it. `undefined` only on
                // an attached handle, which cannot reach this line; the
                // keyword is the honest fallback if that ever changes, since
                // it is what the caller asked for.
                deviceTypeName: sim.deviceType?.name ?? keyword,
                udid: sim.udid,
                boot: sim.lastBoot ?? NEVER_BOOTED,
              })
            );
          },
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("destroy_simulator")) {
    server.tool(
      "destroy_simulator",
      "Shuts down and deletes the simulator for the given session. Call start_simulator afterwards to create a new one.",
      {
        id: sessionIdSchema,
      },
      { title: "Destroy Simulator", readOnlyHint: false, openWorldHint: true },
      async ({ id }) =>
        handleToolError(
          "Error destroying simulator",
          async () => {
            // `destroy` reads the three facts before the teardown, because a
            // deleted handle is stale and only its plain fields stay safe to
            // touch. `owned` is what decides delete-or-detach, and saying
            // which happened is the only signal an agent gets that a simulator
            // it did not create is still running.
            const { name, udid, owned } = await sessions.destroy(id);
            return textResult(renderDestroyed(name, udid, owned));
          },
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("attach_simulator")) {
    server.tool(
      "attach_simulator",
      "Attaches to an existing, already-booted iOS simulator by UDID. Use this instead of start_simulator when you want to control a simulator that was created externally.",
      {
        id: sessionIdSchema,
        udid: z
          .string()
          .regex(
            /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
          )
          .describe("UDID of the simulator to attach to"),
      },
      { title: "Attach Simulator", readOnlyHint: false, openWorldHint: true },
      async ({ id, udid }) =>
        handleToolError(
          "Error attaching to simulator",
          async () => {
            // Both refusals — an id that already has a simulator, and a
            // simulator that is not booted — are the registry's, so that it
            // can never come to hold a session whose handle was never
            // driveable. The wait is not: it takes up to a minute and produces
            // the numbers this answer is built from.
            const { sim } = await sessions.attach(id, udid);

            // "Booted" is reported well before the accessibility bridge
            // answers, so attaching to a simulator that has only just come up
            // has the same problem as creating one. Costs nothing when it is
            // already up.
            const boot = await sim.waitReady();

            return textResult(renderAttached({ name: sim.name, udid: sim.udid, boot }));
          }
          // Deliberately no `{sessionId}`, alone among the seventeen. The
          // context exists so `simulator-not-found` can add "session X can no
          // longer use it — call destroy_simulator, then start_simulator",
          // and on this path the session never held the simulator in the
          // first place: nothing has been registered when the udid turns out
          // not to exist, and the registry refuses before it registers if it
          // is not booted. The old server answered `No simulator found with
          // UDID "..."` and nothing else, which is exactly right and exactly
          // what dropping the context restores. Raised by agent C at 3.4.
        )
    );
  }

  // ---- reads ---------------------------------------------------------------

  if (!isToolFiltered("rotate")) {
    server.tool(
      "rotate",
      "Rotates the simulated device. Orientation names follow the device, exactly as the Simulator's own Device > Orientation menu does: rotating the device left is `landscape_left`. Note that UIKit's *interface* orientation names are the mirror of these for the two landscapes, so an app reporting `UIInterfaceOrientationLandscapeRight` is in `landscape_left` here — both are correct. Reads the orientation back afterwards and reports what the interface actually adopted, which is not always what was asked for.",
      {
        id: sessionIdSchema,
        orientation: z
          .enum(["portrait", "upside_down", "landscape_left", "landscape_right"])
          .describe("The orientation to rotate the device to"),
      },
      { title: "Rotate Device", readOnlyHint: false, openWorldHint: true },
      async ({ id, orientation }) =>
        handleToolError(
          "Error rotating the device",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // The settle, the probe and the invalidated screen dimensions
              // are all `rotate()`'s now. What is left here is the one thing
              // the library cannot know: which session to name.
              const result = await sim.rotate(orientation);
              return textResult(renderRotate(id, result));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("detect_rotation")) {
    server.tool(
      "detect_rotation",
      "Detects the current device rotation by probing the simulator's accessibility tree. Call this after the device has been rotated to update the coordinate mapping. Returns the detected orientation (portrait, landscape_right, landscape_left, or upside_down).",
      {
        id: sessionIdSchema,
      },
      {
        title: "Detect Rotation",
        readOnlyHint: true,
        openWorldHint: false,
      },
      async ({ id }) =>
        handleToolError(
          "Error detecting rotation",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              const detected = await sim.detectOrientation();
              return textResult(renderDetectedOrientation(id, detected));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("ui_describe_all")) {
    server.tool(
      "ui_describe_all",
      "Describes accessibility information for the entire screen in the iOS Simulator",
      {
        id: sessionIdSchema,
      },
      { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
      async ({ id }) =>
        handleToolError(
          "Error describing all of the ui",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // The degenerate-tree ladder — restart the companion, restart the
              // bridge, ask again, and diagnose if it is still empty — is all
              // inside `describeScreen()` now, and reaches here as a typed
              // `AccessibilityUnreadableError` if it fails. What is left is the
              // read and the elements.
              const read = await sim.describeScreen();
              return textResult(renderScreen(read));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("ui_find")) {
    server.tool(
      "ui_find",
      "Find a single UI element by its accessibility label, without fetching the whole screen. Matches any element whose label contains the given text. Much cheaper than ui_describe_all when you already know what you are looking for.",
      {
        id: sessionIdSchema,
        label: z
          .string()
          .min(1)
          .max(200)
          .describe("Label text to look for (substring match, case sensitive)"),
      },
      { title: "Find UI Element", readOnlyHint: true, openWorldHint: true },
      async ({ id, label }) =>
        handleToolError(
          `Error finding element labelled "${label}"`,
          () =>
            sessions.withSession(id, async ({ sim }) => {
              const element = await sim.findByLabel(label);
              // Absent is an answer, not a failure — the library's rule
              // reaching the agent unchanged. `isError` here would make an
              // ordinary "it is not on screen yet" indistinguishable from a
              // simulator that has stopped answering.
              return textResult(
                element ? renderElement(element) : renderNoElementFound(label)
              );
            }),
          { sessionId: id, label }
        )
    );
  }

  if (!isToolFiltered("ui_describe_point")) {
    server.tool(
      "ui_describe_point",
      "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
      {
        id: sessionIdSchema,
        x: z.number().describe("The x-coordinate"),
        y: z.number().describe("The y-coordinate"),
      },
      { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
      async ({ id, x, y }) =>
        handleToolError(
          `Error describing point (${x}, ${y})`,
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // Logical coordinates in, logical coordinates out: the transform
              // into the companion's portrait space, and the remote-hosted
              // frame correction that follows it, are both inside
              // `describePoint()`. Empty space answers `null` rather than
              // failing, which JSON renders as `null` exactly as before.
              const element = await sim.describePoint(x, y);
              return textResult(renderElement(element));
            }),
          { sessionId: id }
        )
    );
  }

  // ---- actions -------------------------------------------------------------

  if (!isToolFiltered("ui_tap")) {
    server.tool(
      "ui_tap",
      "Tap on the screen in the iOS Simulator. Give either a label to tap the element with that accessibility label, or explicit x and y coordinates.",
      {
        id: sessionIdSchema,
        duration: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional()
          .describe(
            "Press duration in seconds. Every tap is held for at least 0.1s, which is what makes it land; raise this for a long press."
          ),
        label: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Accessibility label of the element to tap (substring match). Resolves to the centre of that element. Use instead of x and y."
          ),
        x: z.number().optional().describe("The x-coordinate (omit if using label)"),
        y: z.number().optional().describe("The y-coordinate (omit if using label)"),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(1)
          .describe("Number of taps to perform (default 1). Use 2 for double-tap."),
      },
      { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
      async ({ id, duration, x, y, count, label }) =>
        handleToolError(
          "Error tapping on the screen",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // The whole of this tool that is still the server's: choosing
              // which of the two things a tap can be aimed at was asked for.
              // A label wins when both are given, as it always has —
              // resolving a name and then ignoring it would be the worse
              // surprise.
              let target: TapTarget;
              if (label !== undefined) {
                target = { label };
              } else if (x !== undefined && y !== undefined) {
                target = { x, y };
              } else {
                // The one refusal that is genuinely about arguments rather
                // than about the screen: `TapTarget` is a union, so a caller
                // who names neither has not described a tap at all.
                throw new Error(
                  "ui_tap needs either a label, or both x and y coordinates."
                );
              }

              // `undefined` and not `0`: asking for a duration *at all* is
              // what marks a caller as wanting a real press, and a real press
              // at a toggle is refused because the centre of its row is not
              // the control. Substituting a zero would silently turn every
              // plain tap on a switch into that refusal.
              const result = await sim.tap(target, {
                durationSeconds: duration !== undefined ? Number(duration) : undefined,
                count,
              });

              return textResult(renderTap(result, label));
            }),
          { sessionId: id, label }
        )
    );
  }

  if (!isToolFiltered("ui_type")) {
    server.tool(
      "ui_type",
      "Input text into the iOS Simulator",
      {
        id: sessionIdSchema,
        text: z
          .string()
          .max(500)
          .regex(/^[\x20-\x7E]+$/)
          .describe("Text to input"),
      },
      { title: "UI Type", readOnlyHint: false, openWorldHint: true },
      async ({ id, text }) =>
        handleToolError(
          "Error typing text into the iOS Simulator",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // Exclusivity — so another session's taps cannot land mid-string
              // — is the handle's, along with the keymap and the refusal for
              // characters the companion cannot send.
              await sim.typeText(text);
              return textResult(renderTyped());
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("ui_swipe")) {
    server.tool(
      "ui_swipe",
      "Swipe on the screen in the iOS Simulator",
      {
        id: sessionIdSchema,
        duration: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional()
          .default("1")
          .describe("Swipe duration in seconds. Longer duration is a more controlled swipe."),
        x_start: z.number().describe("The starting x-coordinate"),
        y_start: z.number().describe("The starting y-coordinate"),
        x_end: z.number().describe("The ending x-coordinate"),
        y_end: z.number().describe("The ending y-coordinate"),
        delta: z
          .number()
          .optional()
          .describe("The size of each step in the swipe (default is 1)")
          .default(1),
      },
      { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
      async ({ id, duration, x_start, y_start, x_end, y_end, delta }) =>
        handleToolError(
          "Error swiping on the screen",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // Both endpoints go through one transform inside the handle, so
              // they cannot end up in different coordinate spaces — which is
              // exactly the bug two separate conversions here invited.
              //
              // The defaults are this host's to choose (DECISIONS.md #15) and
              // are the schema's, above. `|| undefined` keeps the old body's
              // shape: a zero delta means "say nothing about it", not "step by
              // nothing".
              await sim.swipe(
                { x: x_start, y: y_start },
                { x: x_end, y: y_end },
                {
                  delta: delta || undefined,
                  durationSeconds: duration ? Number(duration) : undefined,
                }
              );
              return textResult(renderSwiped());
            }),
          { sessionId: id }
        )
    );
  }

  // ---- capture and apps ----------------------------------------------------

  if (!isToolFiltered("ui_view")) {
    server.tool(
      "ui_view",
      "Get the image content of a compressed screenshot of the current simulator view",
      {
        id: sessionIdSchema,
      },
      { title: "View Screenshot", readOnlyHint: true, openWorldHint: true },
      async ({ id }) =>
        handleToolError(
          "Error capturing screenshot",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // The whole pipeline — capture in physical portrait, resize to
              // the screen's logical point dimensions, compress, and rotate to
              // match the interface — is `screenshot()`. These three options
              // are what made it the *compressed view* rather than a file:
              // JPEG at 80, and point dimensions so that what a model sees is
              // the space its coordinates live in.
              const shot = await sim.screenshot({
                format: "jpeg",
                quality: 80,
                resizeTo: "points",
              });

              // The one MCP wire format in this server with no JavaScript use
              // at all, which is exactly why it is here and not in the
              // library: a base64 image block is a thing an agent's transport
              // understands, and a `Buffer` is what every other caller wants.
              return {
                isError: false as const,
                content: [
                  {
                    type: "image" as const,
                    data: shot.data.toString("base64"),
                    mimeType: "image/jpeg",
                  },
                  { type: "text" as const, text: renderScreenshotCaptured() },
                ],
              };
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("screenshot")) {
    server.tool(
      "screenshot",
      "Takes a screenshot of the iOS Simulator",
      {
        id: sessionIdSchema,
        output_path: z
          .string()
          .max(1024)
          .describe(
            "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
          ),
        type: z
          .enum(["png", "tiff", "bmp", "gif", "jpeg"])
          .optional()
          .describe(
            "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
          ),
        display: z
          .enum(["internal", "external"])
          .optional()
          .describe(
            "Display to capture (internal or external). Default depends on device type."
          ),
        mask: z
          .enum(["ignored", "alpha", "black"])
          .optional()
          .describe(
            "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
          ),
      },
      { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
      async ({ id, output_path, type, display, mask }) =>
        handleToolError(
          "Error taking screenshot",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // Resolved here and nowhere else: the library takes absolute
              // paths only, on purpose, because guessing at a caller's home
              // directory is host policy (DECISIONS.md #12). What crosses into
              // `simgadget` is always already absolute.
              const absolutePath = ensureAbsolutePath(output_path);
              await sim.screenshot({ format: type, display, mask, path: absolutePath });
              // Composed rather than echoed. The old server read simctl's own
              // "Wrote screenshot to:" line off *stderr*, where simctl reports
              // success; the path said back here is the one we resolved, which
              // is the same path and a more useful one to have said.
              return textResult(renderScreenshotSaved(absolutePath));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("record_video")) {
    server.tool(
      "record_video",
      "Records a video of the iOS Simulator using simctl directly",
      {
        id: sessionIdSchema,
        output_path: z
          .string()
          .max(1024)
          .optional()
          .describe(
            `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
          ),
        codec: z
          .enum(["h264", "hevc"])
          .optional()
          .describe(
            'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
          ),
        display: z
          .enum(["internal", "external"])
          .optional()
          .describe(
            'Display to capture: "internal" or "external". Default depends on device type.'
          ),
        mask: z
          .enum(["ignored", "alpha", "black"])
          .optional()
          .describe(
            'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Force the output file to be written to, even if the file already exists."
          ),
      },
      { title: "Record Video", readOnlyHint: false, openWorldHint: true },
      async ({ id, output_path, codec, display, mask, force }) =>
        handleToolError(
          "Error starting recording",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // One recording per handle is the library's rule now, and it is
              // the same rule the `activeRecordings` map enforced per session,
              // because a session owns exactly one simulator. The refusal
              // still names the session, which is what an agent driving
              // several needs to hear — that comes from the RenderContext.
              const outputFile = ensureAbsolutePath(
                output_path ?? `simulator_recording_${Date.now()}.mp4`
              );
              await sim.startRecording(outputFile, { codec, display, mask, force });
              return textResult(renderRecordingStarted(outputFile));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("stop_recording")) {
    server.tool(
      "stop_recording",
      "Stops the simulator video recording",
      {
        id: sessionIdSchema,
      },
      { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
      async ({ id }) =>
        handleToolError(
          "Error stopping recording",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // SIGINT rather than SIGKILL, and the wait for the file to
              // finalize, are the handle's — a killed `simctl io recordVideo`
              // leaves a file that exists, has a plausible size, and will not
              // play.
              await sim.stopRecording();
              return textResult(renderRecordingStopped());
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("install_app")) {
    server.tool(
      "install_app",
      "Installs an app bundle (.app or .ipa) on the iOS Simulator",
      {
        id: sessionIdSchema,
        app_path: z
          .string()
          .max(1024)
          .describe(
            "Path to the app bundle (.app directory or .ipa file) to install"
          ),
      },
      { title: "Install App", readOnlyHint: false, openWorldHint: true },
      async ({ id, app_path }) =>
        handleToolError(
          "Error installing app",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              // `path.resolve` and **not** `ensureAbsolutePath`, which is the
              // old server's behaviour and deliberate: an app bundle is
              // something the caller built, so a relative path means "from
              // here", where a relative *output* path means "somewhere I will
              // find it later". Resolving here rather than leaving it to the
              // library — which resolves identically — is what makes the path
              // in the answer provably the path that was installed.
              const absolutePath = path.resolve(app_path);
              await sim.installApp(absolutePath);
              return textResult(renderAppInstalled(absolutePath));
            }),
          { sessionId: id }
        )
    );
  }

  if (!isToolFiltered("launch_app")) {
    server.tool(
      "launch_app",
      "Launches an app on the iOS Simulator by bundle identifier",
      {
        id: sessionIdSchema,
        bundle_id: z
          .string()
          .max(256)
          .describe(
            "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
          ),
        terminate_running: z
          .boolean()
          .optional()
          .describe(
            "Terminate the app if it is already running before launching"
          ),
      },
      { title: "Launch App", readOnlyHint: false, openWorldHint: true },
      async ({ id, bundle_id, terminate_running }) =>
        handleToolError(
          "Error launching app",
          () =>
            sessions.withSession(id, async ({ sim }) => {
              const { pid } = await sim.launchApp(bundle_id, {
                terminateRunning: terminate_running,
              });
              return textResult(renderAppLaunched(bundle_id, pid));
            }),
          { sessionId: id }
        )
    );
  }

  // ---- end of registrations -------------------------------------------------
}
