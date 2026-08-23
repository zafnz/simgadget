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

import type { ReadyResult, TapTarget } from "simgadget";

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
              const state = await existing.sim.state();
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
              // Stale: the simulator is shut down or gone. Drop it and create
              // below — `create` deliberately does not check for an existing
              // session, so resolving this one is the caller's job.
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
          },
          { sessionId: id }
        )
    );
  }

  // ---- end of registrations -------------------------------------------------
}
