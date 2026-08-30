import test from "node:test";
import assert from "node:assert/strict";

import {
  AccessibilityUnreadableError,
  CompanionDownloadError,
  CompanionStartError,
  DeviceTypeNotFoundError,
  ElementDisabledError,
  ElementNotFoundError,
  SimGadgetError,
  SimulatorNotAnsweringError,
  SimulatorNotFoundError,
  TapObstructedError,
  ToggleGestureError,
  TypingBlockedError,
  UnsupportedArchitectureError,
  UntypeableTextError,
  type AXElement,
  type ErrorCode,
  type ReadyResult,
  type TapResult,
} from "simgadget";

import {
  describeFrame,
  errorWithTroubleshooting,
  handleToolError,
  renderAlreadyAttached,
  renderAlreadyStarting,
  renderAppInstalled,
  renderAppLaunched,
  renderAttached,
  renderDestroyed,
  renderDetectedOrientation,
  renderedErrorCodes,
  renderElement,
  renderError,
  renderNoElementFound,
  renderNoSession,
  renderNotBooted,
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
  toError,
  troubleshootingLink,
} from "../src/render.ts";

const button: AXElement = {
  AXLabel: "Submit",
  type: "Button",
  frame: { x: 10.4, y: 20.6, width: 100, height: 44 },
};

const toolbar: AXElement = { AXLabel: "Search", type: "SearchField" };

/** The strong-password sheet's accept button, as iOS publishes it. */
const strongPasswordButton: AXElement = {
  AXLabel: "Fill Strong Password",
  AXUniqueId: "GenerateStrongPasswordButton",
  type: "Button",
  frame: { x: 36, y: 715.3, width: 330, height: 44 },
};

/**
 * One representative error per `ErrorCode`.
 *
 * This is the point of the whole file. `Record<ErrorCode, ...>` means adding a
 * code to the library's union stops this test compiling until it has a sample,
 * exactly as it stops `render.ts` compiling until it has a rendering — and the
 * first test below checks the two tables agree, so a code cannot be sampled
 * here and quietly unrendered there.
 */
const SAMPLES: Record<ErrorCode, SimGadgetError> = {
  "unsupported-architecture": new UnsupportedArchitectureError("x64"),
  "companion-download-failed": new CompanionDownloadError("HTTP 404"),
  "companion-start-failed": new CompanionStartError(["dyld: missing symbol"]),
  "simulator-not-found": new SimulatorNotFoundError("1234-ABCD"),
  "device-type-not-found": new DeviceTypeNotFoundError("iPhone 99", [
    "iPhone 16 Pro",
    "iPad Air",
  ]),
  "no-ios-runtime": new SimGadgetError(
    "no-ios-runtime",
    "No available iOS runtimes found. Install one via Xcode."
  ),
  "not-answering": new SimulatorNotAnsweringError(true),
  "accessibility-unreadable": new AccessibilityUnreadableError("booting"),
  "element-not-found": new ElementNotFoundError("Submit"),
  "element-disabled": new ElementDisabledError(button),
  "element-unusable-frame": new SimGadgetError(
    "element-unusable-frame",
    'Found an element matching "Submit", but it has no usable frame to aim at.'
  ),
  "tap-obstructed": new TapObstructedError(button, toolbar, { x: 60, y: 42 }),
  "toggle-needs-plain-tap": new ToggleGestureError(button, "hold"),
  "untypeable-text": new UntypeableTextError(["é"]),
  "typing-blocked": new TypingBlockedError(strongPasswordButton),
  "recording-already-active": new SimGadgetError(
    "recording-already-active",
    "A recording is already in progress for this simulator handle. Stop it first."
  ),
  "no-active-recording": new SimGadgetError(
    "no-active-recording",
    "No recording is in progress for this simulator handle."
  ),
  "app-bundle-not-found": new SimGadgetError(
    "app-bundle-not-found",
    "App bundle not found at: /tmp/Missing.app"
  ),
};

const ALL_CODES = Object.keys(SAMPLES) as ErrorCode[];

test("every ErrorCode has a rendering", async (t) => {
  await t.test("the renderer table and this test's table name the same codes", () => {
    assert.deepEqual(renderedErrorCodes().slice().sort(), ALL_CODES.slice().sort());
  });

  for (const code of ALL_CODES) {
    await t.test(`${code} renders a sentence`, () => {
      const rendered = renderError(SAMPLES[code]);
      assert.equal(typeof rendered, "string");
      assert.ok(rendered.length > 20, `too short to be an answer: ${rendered}`);
      assert.doesNotMatch(rendered, /undefined|\[object Object\]|NaN/);
    });
  }

  // The sample for a payload-carrying code is deliberately built from the
  // class the library actually throws; if a renderer only ever sees a bare
  // SimGadgetError it must still say something. This is the fallback path in
  // every row, exercised once per code.
  for (const code of ALL_CODES) {
    await t.test(`${code} survives a payload-less error of the same code`, () => {
      const bare = new SimGadgetError(code, "something went wrong");
      const rendered = renderError(bare);
      assert.ok(rendered.length > 0);
      assert.doesNotMatch(rendered, /\[object Object\]/);
    });
  }
});

test("design rule 5: URLs are the server's, never the library's", async (t) => {
  await t.test("no library error message carries a GitHub URL", () => {
    for (const code of ALL_CODES) {
      assert.doesNotMatch(
        SAMPLES[code].message,
        /github\.com/,
        `${code}'s library message names a host-specific URL`
      );
    }
  });

  await t.test("the issue URL appears only where the server chose to add it", () => {
    const withUrl = ALL_CODES.filter((code) =>
      /github\.com/.test(renderError(SAMPLES[code]))
    );
    assert.deepEqual(withUrl, []);

    // ...and the one rendering that does carry it is the unrecoverable tree,
    // which is the failure nobody has ever observed surviving the cure.
    assert.match(
      renderError(new AccessibilityUnreadableError("unrecoverable")),
      /github\.com\/zafnz\/[^ ]*\/issues/
    );
  });

  await t.test("the troubleshooting link offers both a link and a raw URL", () => {
    const link = troubleshootingLink();
    assert.match(link, /\[Troubleshooting Guide\]\(https:\/\/github\.com\//);
    assert.match(link, /https:\/\/raw\.githubusercontent\.com\//);
  });
});

test("renderError: the wedge, which used to be a regex over idb's wording", async (t) => {
  await t.test("a restart that was tried and failed says so", () => {
    const rendered = renderError(new SimulatorNotAnsweringError(true));
    assert.match(rendered, /not answering accessibility requests/);
    assert.match(rendered, /already attempted and did not help/);
  });

  await t.test("a restart the cooldown refused says that instead", () => {
    const rendered = renderError(new SimulatorNotAnsweringError(false));
    assert.match(rendered, /not answering accessibility requests/);
    assert.match(rendered, /too recently to try again/);
    assert.doesNotMatch(rendered, /already attempted and did not help/);
  });

  await t.test("neither mentions a translation object", () => {
    for (const tried of [true, false]) {
      assert.doesNotMatch(
        renderError(new SimulatorNotAnsweringError(tried)),
        /translation object/i
      );
    }
  });
});

test("renderError: an unreadable tree splits by verdict", async (t) => {
  await t.test("booting is short and says to wait", () => {
    assert.equal(
      renderError(new AccessibilityUnreadableError("booting")),
      "Simulator is still booting. Wait a few seconds and try again."
    );
  });

  await t.test("unrecoverable asks for a bug report and names the way out", () => {
    const rendered = renderError(new AccessibilityUnreadableError("unrecoverable"));
    assert.match(rendered, /file a bug/);
    assert.match(rendered, /destroy_simulator then start_simulator/);
    assert.match(rendered, /any installed app must be reinstalled/);
  });
});

test("renderError: element failures", async (t) => {
  await t.test("not found names the query and the tool that answers it", () => {
    assert.equal(
      renderError(new ElementNotFoundError("Submit")),
      'No element found whose label contains "Submit". Use ui_describe_all to see what is on screen.'
    );
  });

  await t.test("disabled names the element and its rectangle", () => {
    assert.equal(
      renderError(new ElementDisabledError(button)),
      '"Submit" is disabled, so tapping it would do nothing. It is at {x:10 y:21 w:100 h:44}.'
    );
  });

  await t.test("obstructed names what is there instead", () => {
    const rendered = renderError(
      new TapObstructedError(button, toolbar, { x: 60, y: 42 })
    );
    assert.match(rendered, /"Submit" is at \{x:10 y:21 w:100 h:44\}/);
    assert.match(rendered, /"Search" is there instead/);
    assert.match(rendered, /a tap at its centre \(60, 42\)/);
    assert.match(rendered, /ui_tap \{x, y\}/);
  });

  await t.test("obstructed by nothing says so, rather than naming null", () => {
    const rendered = renderError(
      new TapObstructedError(button, null, { x: 60, y: 42 })
    );
    assert.match(rendered, /nothing is there/);
    assert.doesNotMatch(rendered, /null/);
  });

  await t.test("a hold at a toggle says to drop the duration", () => {
    const rendered = renderError(new ToggleGestureError(button, "hold"));
    assert.match(rendered, /a hold cannot be delivered to one by name/);
    assert.match(rendered, /with no duration/);
  });

  await t.test("a multi-tap at a toggle says to drop the count", () => {
    const rendered = renderError(new ToggleGestureError(button, "multi-tap"));
    assert.match(rendered, /a multi-tap cannot be delivered to one by name/);
    assert.match(rendered, /with no count/);
  });

  await t.test("an unlabelled element falls back to the caller's label", () => {
    const unlabelled: AXElement = { type: "Switch", frame: { x: 0, y: 0, width: 8, height: 8 } };
    assert.match(
      renderError(new ElementDisabledError(unlabelled), { label: "Wi-Fi" }),
      /^"Wi-Fi" is disabled/
    );
  });
});

test("renderError: device types", async (t) => {
  await t.test("names the keyword and lists what is available", () => {
    assert.equal(
      renderError(new DeviceTypeNotFoundError("iPhone 99", ["iPhone 16 Pro", "iPad Air"])),
      'No device type found matching "iPhone 99". Available types: iPhone 16 Pro, iPad Air'
    );
  });

  await t.test("an empty list does not produce a dangling 'Available types:'", () => {
    const rendered = renderError(new DeviceTypeNotFoundError("iPhone 99", []));
    assert.doesNotMatch(rendered, /Available types: *$/);
    assert.match(rendered, /no device types are available at all/);
  });
});

test("renderError: the session-flavoured rows", async (t) => {
  await t.test("a missing simulator names the session and the way back", () => {
    const rendered = renderError(new SimulatorNotFoundError("ABC-123"), {
      sessionId: "qa-a",
    });
    assert.match(rendered, /No simulator found with UDID "ABC-123"\./);
    assert.match(rendered, /Session "qa-a"/);
    assert.match(rendered, /destroy_simulator, then start_simulator/);
  });

  await t.test("without a session it is just the fact", () => {
    assert.equal(
      renderError(new SimulatorNotFoundError("ABC-123")),
      'No simulator found with UDID "ABC-123".'
    );
  });

  await t.test("no active recording names the session", () => {
    assert.equal(
      renderError(SAMPLES["no-active-recording"], { sessionId: "qa-b" }),
      'No active recording for session "qa-b".'
    );
  });

  await t.test("an already-active recording names the session", () => {
    assert.match(
      renderError(SAMPLES["recording-already-active"], { sessionId: "qa-b" }),
      /already in progress for session "qa-b"/
    );
  });
});

test("renderError: anything that is not a SimGadgetError", async (t) => {
  await t.test("an ordinary Error renders its own message", () => {
    assert.equal(renderError(new Error("simctl exploded")), "simctl exploded");
  });

  await t.test("a missing SIMGADGET_COMPANION_PATH renders through the fallback", () => {
    // Deliberately untyped: adding an ErrorCode for this touches the library's
    // frozen public surface (TODO #82). The message names the variable and the
    // path, which is the whole remedy, so the fallback is adequate.
    const rendered = renderError(
      new Error("SIMGADGET_COMPANION_PATH is set to /nope/idb_companion, which does not exist")
    );
    assert.match(rendered, /SIMGADGET_COMPANION_PATH/);
    assert.match(rendered, /\/nope\/idb_companion/);
  });

  await t.test("a thrown string does not crash the renderer", () => {
    assert.equal(renderError("just a string"), '"just a string"');
  });

  await t.test("a thrown object with a message uses it", () => {
    assert.equal(renderError({ message: "from a duck" }), "from a duck");
  });

  await t.test("a SimGadgetError with a code from a newer library still renders", () => {
    const future = new SimGadgetError(
      "something-invented-later" as ErrorCode,
      "a failure this server has never heard of"
    );
    assert.equal(renderError(future), "a failure this server has never heard of");
  });
});

test("toError", async (t) => {
  await t.test("passes an Error through unchanged", () => {
    const original = new Error("x");
    assert.equal(toError(original), original);
  });

  await t.test("wraps a thrown non-object as its JSON", () => {
    assert.equal(toError(42).message, "42");
    assert.equal(toError(null).message, "null");
  });

  // `JSON.stringify(undefined)` is the value `undefined`, not a string, so the
  // message ends up empty. Pinned rather than fixed: it is what the old server
  // did, and `throw undefined` is not a thing this codebase does — but a
  // renderer that threw *here* would lose whatever real failure was underway.
  await t.test("wraps undefined without throwing", () => {
    assert.equal(toError(undefined).message, "");
  });
});

test("handleToolError", async (t) => {
  await t.test("returns the body's own result when nothing throws", async () => {
    const result = await handleToolError("Error tapping", async () => textResult("ok"));
    assert.deepEqual(result, { isError: false, content: [{ type: "text", text: "ok" }] });
  });

  await t.test("prefixes the failure with what was being attempted", async () => {
    const result = await handleToolError("Error tapping on the screen", async () => {
      throw new ElementNotFoundError("Submit");
    });
    assert.equal(result.isError, true);
    assert.match(
      (result as { content: { text: string }[] }).content[0].text,
      /^Error tapping on the screen: No element found whose label contains "Submit"\./
    );
  });

  await t.test("appends the troubleshooting guide", async () => {
    const result = await handleToolError("Error tapping", async () => {
      throw new Error("boom");
    });
    assert.match(
      (result as { content: { text: string }[] }).content[0].text,
      /For help, see the \[Troubleshooting Guide\]/
    );
  });

  await t.test("passes its context through to the renderer", async () => {
    const result = await handleToolError(
      "Error stopping recording",
      async () => {
        throw SAMPLES["no-active-recording"];
      },
      { sessionId: "qa-c" }
    );
    assert.match(
      (result as { content: { text: string }[] }).content[0].text,
      /No active recording for session "qa-c"\./
    );
  });

  await t.test("survives a body that throws a non-Error", async () => {
    const result = await handleToolError("Error typing", async () => {
      throw 42;
    });
    assert.equal(result.isError, true);
    assert.match((result as { content: { text: string }[] }).content[0].text, /42/);
  });
});

test("errorWithTroubleshooting", async (t) => {
  await t.test("separates the message from the guide with a blank line", () => {
    assert.match(errorWithTroubleshooting("nope"), /^nope\n\nFor help, see the /);
  });
});

test("describeFrame", async (t) => {
  await t.test("rounds, because the caller is about to type these numbers", () => {
    assert.equal(describeFrame(button), "{x:10 y:21 w:100 h:44}");
  });

  await t.test("says so when there is no frame at all", () => {
    assert.equal(describeFrame({ AXLabel: "x" }), "no usable position");
  });
});

// ---- responses -------------------------------------------------------------

const ready: ReadyResult = { ready: true, waitedMs: 41_200, recoveryTried: false, recovered: false };
const notReady: ReadyResult = { ready: false, waitedMs: 55_000, recoveryTried: false, recovered: false };

test("start_simulator", async (t) => {
  await t.test("a ready simulator reports how long it took", () => {
    assert.equal(
      renderStarted({
        deviceName: "qa-a_iphone",
        deviceTypeName: "iPhone 16 Pro",
        udid: "ABC",
        boot: ready,
      }),
      'Simulator started: "qa-a_iphone" (iPhone 16 Pro, ABC). Ready after 41s.'
    );
  });

  await t.test("a recovered one says the bridge had to be restarted", () => {
    const rendered = renderStarted({
      deviceName: "qa-a_iphone",
      deviceTypeName: "iPhone 16 Pro",
      udid: "ABC",
      boot: { ...ready, recoveryTried: true, recovered: true },
    });
    assert.match(rendered, /Ready after 41s\./);
    assert.match(rendered, /recovered by restarting the simulator bridge/);
  });

  await t.test("one that never answered tells the caller to poll", () => {
    const rendered = renderStarted({
      deviceName: "qa-a_iphone",
      deviceTypeName: "iPhone 16 Pro",
      udid: "ABC",
      boot: notReady,
    });
    assert.match(rendered, /^Simulator created and booting: "qa-a_iphone" \(iPhone 16 Pro, ABC\)/);
    assert.match(rendered, /after 55s/);
    assert.match(rendered, /Poll ui_view until it returns a screenshot\./);
    assert.doesNotMatch(rendered, /file a bug/);
  });

  await t.test("one that survived the bridge restart says poll first, report second", () => {
    // TODO #102: this used to open with "which is not expected: that fixes
    // this in every case seen so far" and send the reader to the issue
    // tracker. Two simulators booting at once on one machine blow the budget
    // routinely -- which is the thing this fork exists to do -- and one of the
    // pair in the step-6 run served a screenshot moments later, so it was
    // never wedged. The advice that works comes first now, and the bug report
    // is conditional on the advice failing.
    const rendered = renderStarted({
      deviceName: "qa-a_iphone",
      deviceTypeName: "iPhone 16 Pro",
      udid: "ABC",
      boot: { ...notReady, recoveryTried: true },
    });

    assert.match(rendered, /Poll ui_view/);
    assert.match(rendered, /several are booting on one machine/);
    // Still reachable, but as the second branch rather than the headline.
    assert.match(rendered, /https:\/\/github\.com/);
    assert.match(rendered, /destroy_simulator and start_simulator/);
    assert.doesNotMatch(
      rendered,
      /not expected/,
      "a busy machine is not evidence of the wedge, and must not be reported as it"
    );
    assert.ok(
      rendered.indexOf("Poll ui_view") < rendered.indexOf("github.com"),
      "the advice that usually works has to come before the bug report"
    );
  });

  await t.test("resume names the session, the device and the udid", () => {
    assert.equal(
      renderResumed("qa-a", "qa-a_iphone", "ABC"),
      'Resumed existing simulator for session "qa-a": "qa-a_iphone" (ABC)'
    );
  });

  await t.test("the concurrency refusal tells the second caller to wait", () => {
    assert.equal(
      renderAlreadyStarting("qa-a"),
      'A simulator is already being created for session "qa-a". Wait for it to finish.'
    );
  });
});

test("attach_simulator", async (t) => {
  await t.test("a ready simulator is a one-line answer", () => {
    assert.equal(
      renderAttached({ name: "iPhone 16", udid: "ABC", boot: ready }),
      'Attached to simulator: "iPhone 16" (ABC)'
    );
  });

  await t.test("one that has not answered says how long it waited", () => {
    const rendered = renderAttached({ name: "iPhone 16", udid: "ABC", boot: notReady });
    assert.match(rendered, /has not answered an accessibility read after 55s/);
    assert.match(rendered, /Poll ui_view/);
  });

  await t.test("an already-attached session is told to destroy first", () => {
    assert.equal(
      renderAlreadyAttached("qa-a", "iPhone 16", "ABC"),
      'Session "qa-a" is already attached to simulator "iPhone 16" (ABC). Call destroy_simulator first.'
    );
  });

  await t.test("a simulator that is not booted reports its state", () => {
    assert.equal(
      renderNotBooted("iPhone 16", "ABC", "Shutdown"),
      'Simulator "iPhone 16" (ABC) is not booted (state: Shutdown).'
    );
  });
});

test("destroy_simulator distinguishes deleting from detaching", async (t) => {
  await t.test("owned is destroyed", () => {
    assert.equal(
      renderDestroyed("qa-a_iphone", "ABC", true),
      'Simulator destroyed: "qa-a_iphone" (ABC)'
    );
  });

  await t.test("attached is only detached", () => {
    assert.equal(
      renderDestroyed("iPhone 16", "ABC", false),
      'Detached from simulator: "iPhone 16" (ABC)'
    );
  });
});

test("rotate reports what the interface adopted", async (t) => {
  await t.test("agreement is a single sentence", () => {
    assert.equal(
      renderRotate("qa-a", { requested: "landscape_left", adopted: "landscape_left" }),
      'Rotated to "landscape_left" for session "qa-a".'
    );
  });

  await t.test("a declined orientation says so, and where coordinates now are", () => {
    const rendered = renderRotate("qa-a", {
      requested: "landscape_left",
      adopted: "portrait",
    });
    assert.match(rendered, /Asked the device to rotate to "landscape_left", but the interface is "portrait"\./);
    assert.match(rendered, /The app may not support that orientation\./);
    assert.match(rendered, /Coordinates now follow "portrait"\./);
  });

  await t.test("upside_down gets the Face ID explanation, not the generic one", () => {
    const rendered = renderRotate("qa-a", {
      requested: "upside_down",
      adopted: "portrait",
    });
    assert.match(rendered, /never gives an app an upside-down interface/);
    assert.match(rendered, /use an iPad if you need that orientation/);
    assert.doesNotMatch(rendered, /The app may not support that orientation/);
  });

  await t.test("detect_rotation names the session", () => {
    assert.equal(
      renderDetectedOrientation("qa-a", "landscape_right"),
      'Detected orientation: "landscape_right" for session "qa-a".'
    );
  });
});

test("reads", async (t) => {
  await t.test("ui_describe_all sends the elements, not the screen rectangle", () => {
    const rendered = renderScreen({
      elements: [button],
      screen: { width: 393, height: 852 },
    });
    assert.equal(rendered, JSON.stringify([button]));
    assert.doesNotMatch(rendered, /"screen"/);
  });

  await t.test("ui_find sends one element as JSON", () => {
    assert.equal(renderElement(button), JSON.stringify(button));
  });

  await t.test("an empty point is JSON null, not an error", () => {
    assert.equal(renderElement(null), "null");
  });

  await t.test("ui_find with no match is an answer, and names the next tool", () => {
    assert.equal(
      renderNoElementFound("Submit"),
      'No element found whose label contains "Submit". Use ui_describe_all to see what is on screen.'
    );
  });
});

test("ui_tap names what it acted on", async (t) => {
  await t.test("a coordinate tap names only the coordinates", () => {
    const result: TapResult = {
      acted: "touch",
      x: 100.4,
      y: 200.6,
      count: 1,
      durationSeconds: 0.1,
    };
    assert.equal(renderTap(result), "Tapped at (100, 201).");
  });

  await t.test("a label tap names the element and its role", () => {
    const result: TapResult = {
      acted: "touch",
      x: 60,
      y: 42,
      count: 1,
      durationSeconds: 0.1,
      element: button,
    };
    assert.equal(renderTap(result, "Sub"), 'Tapped "Submit" (Button) at (60, 42).');
  });

  await t.test("a multi-tap says how many", () => {
    const result: TapResult = {
      acted: "touch",
      x: 60,
      y: 42,
      count: 2,
      durationSeconds: 0.1,
      element: button,
    };
    assert.equal(renderTap(result), 'Tapped "Submit" (Button) 2 times at (60, 42).');
  });

  await t.test("an element with no label falls back to its value", () => {
    const result: TapResult = {
      acted: "touch",
      x: 1,
      y: 2,
      count: 1,
      durationSeconds: 0.1,
      element: { AXValue: "hello", type: "StaticText" },
    };
    assert.equal(renderTap(result), 'Tapped "hello" (StaticText) at (1, 2).');
  });

  await t.test("a toggle that flipped reports both states", () => {
    const result: TapResult = {
      acted: "activation",
      element: { AXLabel: "Sound" },
      before: "0",
      after: "1",
    };
    assert.equal(renderTap(result), "Toggled Sound off -> on.");
  });

  await t.test("a toggle that did not flip explains why, and does not claim success", () => {
    const result: TapResult = {
      acted: "activation",
      element: { AXLabel: "Sound" },
      before: "1",
      after: "1",
    };
    const rendered = renderTap(result);
    assert.match(rendered, /but it is still on\./, "it names the state it read back");
    assert.match(rendered, /ui_tap \{x, y\}/, "and the way out");
    assert.doesNotMatch(rendered, /^Toggled/, "it must not read as success");
    // Since #105 the library refuses a covered or off-screen element as
    // tap-obstructed before it activates anything, so this message is only
    // reached for a control that *was* reached. Advising a scroll here would
    // send the caller after a cause that has already been ruled out.
    assert.doesNotMatch(rendered, /scrolled out of view/);
  });

  await t.test("a state that could not be read back says exactly that", () => {
    const result: TapResult = {
      acted: "activation",
      element: { AXLabel: "Sound" },
      before: "0",
    };
    assert.equal(
      renderTap(result),
      "Activated Sound, but could not read its state back to confirm it changed."
    );
  });

  await t.test("a non-binary value is shown as it came", () => {
    const result: TapResult = {
      acted: "activation",
      element: { AXLabel: "Volume" },
      before: "quiet",
      after: "loud",
    };
    assert.equal(renderTap(result), "Toggled Volume quiet -> loud.");
  });
});

test("the fixed-string responses", async (t) => {
  await t.test("ui_type", () => assert.equal(renderTyped(), "Typed successfully"));
  await t.test("ui_swipe", () => assert.equal(renderSwiped(), "Swiped successfully"));
  await t.test("ui_view's text block", () =>
    assert.equal(renderScreenshotCaptured(), "Screenshot captured"));
  await t.test("stop_recording", () =>
    assert.equal(renderRecordingStopped(), "Recording stopped successfully."));
});

test("capture and apps", async (t) => {
  await t.test("screenshot names the resolved absolute path", () => {
    assert.equal(
      renderScreenshotSaved("/Users/x/Downloads/shot.png"),
      "Wrote screenshot to: /Users/x/Downloads/shot.png"
    );
  });

  await t.test("record_video names the file and the tool that ends it", () => {
    const rendered = renderRecordingStarted("/Users/x/Downloads/clip.mp4");
    assert.match(rendered, /will be saved to: \/Users\/x\/Downloads\/clip\.mp4/);
    assert.match(rendered, /stop_recording/);
  });

  await t.test("install_app names where it came from", () => {
    assert.equal(
      renderAppInstalled("/tmp/Fixture.app"),
      "App installed successfully from: /tmp/Fixture.app"
    );
  });

  await t.test("launch_app reports the pid when there is one", () => {
    assert.equal(
      renderAppLaunched("com.example.app", 4321),
      "App com.example.app launched successfully with PID: 4321"
    );
  });

  await t.test("and says nothing about a pid when there is not", () => {
    assert.equal(
      renderAppLaunched("com.example.app", null),
      "App com.example.app launched successfully"
    );
    assert.doesNotMatch(renderAppLaunched("com.example.app", null), /PID/);
  });

  await t.test("a pid of 0 is still a pid", () => {
    assert.match(renderAppLaunched("com.example.app", 0), /PID: 0/);
  });
});

test("a session that was never started", async (t) => {
  await t.test("is told which tool to call", () => {
    assert.equal(
      renderNoSession("qa-a"),
      'No simulator is running for session "qa-a". Call start_simulator first.'
    );
  });
});
