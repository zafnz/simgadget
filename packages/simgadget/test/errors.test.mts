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
  UnsupportedArchitectureError,
  UntypeableTextError,
  type ErrorCode,
} from "../src/errors.ts";
import type { AXElement } from "../src/ax/tree.ts";

const button: AXElement = { AXLabel: "Continue", type: "Button", enabled: false };
const otherButton: AXElement = { AXLabel: "Cancel", type: "Button" };
const searchField: AXElement = { AXValue: "search text", type: "SearchField" };
const toggle: AXElement = { AXLabel: "Airplane Mode", type: "Switch" };

/**
 * One row per subclass, plus the five payload-less codes thrown as plain
 * `SimGadgetError`. `mustContain` are substrings the *default* message must
 * carry — the thing that makes "each subclass builds its own message from
 * its payload" a real, checkable claim rather than a comment.
 */
const cases: Array<{
  className: string;
  code: ErrorCode;
  error: SimGadgetError;
  mustContain: string[];
  payloadCheck: () => void;
}> = [
  {
    className: "UnsupportedArchitectureError",
    code: "unsupported-architecture",
    error: new UnsupportedArchitectureError("x64"),
    mustContain: ["x64"],
    payloadCheck: () => {},
  },
  {
    className: "CompanionDownloadError",
    code: "companion-download-failed",
    error: new CompanionDownloadError("checksum mismatch"),
    mustContain: ["checksum mismatch"],
    payloadCheck: () => {},
  },
  {
    className: "CompanionStartError",
    code: "companion-start-failed",
    error: new CompanionStartError(["fatal: bind failed: address in use"]),
    mustContain: ["bind failed"],
    payloadCheck: () => {
      const err = new CompanionStartError(["a", "b"]);
      assert.deepEqual(err.stderrTail, ["a", "b"]);
    },
  },
  {
    className: "SimulatorNotFoundError",
    code: "simulator-not-found",
    error: new SimulatorNotFoundError("ABCD-1234"),
    mustContain: ["ABCD-1234"],
    payloadCheck: () => {
      const err = new SimulatorNotFoundError("ABCD-1234");
      assert.equal(err.udid, "ABCD-1234");
    },
  },
  {
    className: "DeviceTypeNotFoundError",
    code: "device-type-not-found",
    error: new DeviceTypeNotFoundError("iPhone 99", ["iPhone 16", "iPhone 16 Pro"]),
    mustContain: ["iPhone 99", "iPhone 16", "iPhone 16 Pro"],
    payloadCheck: () => {
      const err = new DeviceTypeNotFoundError("iPhone 99", ["iPhone 16"]);
      assert.equal(err.keyword, "iPhone 99");
      assert.deepEqual(err.available, ["iPhone 16"]);
    },
  },
  {
    className: "SimulatorNotAnsweringError",
    code: "not-answering",
    error: new SimulatorNotAnsweringError(true),
    mustContain: [],
    payloadCheck: () => {
      const tried = new SimulatorNotAnsweringError(true);
      const untried = new SimulatorNotAnsweringError(false);
      assert.equal(tried.recoveryTried, true);
      assert.equal(untried.recoveryTried, false);
      assert.notEqual(tried.message, untried.message);
    },
  },
  {
    className: "AccessibilityUnreadableError",
    code: "accessibility-unreadable",
    error: new AccessibilityUnreadableError("booting"),
    mustContain: ["booting"],
    payloadCheck: () => {
      const booting = new AccessibilityUnreadableError("booting");
      const unrecoverable = new AccessibilityUnreadableError("unrecoverable");
      assert.equal(booting.verdict, "booting");
      assert.equal(unrecoverable.verdict, "unrecoverable");
      assert.notEqual(booting.message, unrecoverable.message);
    },
  },
  {
    className: "ElementNotFoundError",
    code: "element-not-found",
    error: new ElementNotFoundError("Continue"),
    mustContain: ["Continue"],
    payloadCheck: () => {
      const err = new ElementNotFoundError("Continue");
      assert.equal(err.query, "Continue");
    },
  },
  {
    className: "ElementDisabledError",
    code: "element-disabled",
    error: new ElementDisabledError(button),
    mustContain: ["Continue"],
    payloadCheck: () => {
      const err = new ElementDisabledError(button);
      assert.deepEqual(err.element, button);
    },
  },
  {
    className: "TapObstructedError",
    code: "tap-obstructed",
    error: new TapObstructedError(button, otherButton, { x: 10, y: 20 }),
    mustContain: ["Continue", "Cancel", "10", "20"],
    payloadCheck: () => {
      const err = new TapObstructedError(button, null, { x: 1, y: 2 });
      assert.deepEqual(err.element, button);
      assert.equal(err.obstruction, null);
      assert.deepEqual(err.point, { x: 1, y: 2 });
      // The "nothing there" case must read differently from a named obstruction.
      const named = new TapObstructedError(button, otherButton, { x: 1, y: 2 });
      assert.notEqual(err.message, named.message);
    },
  },
  {
    className: "ToggleGestureError",
    code: "toggle-needs-plain-tap",
    error: new ToggleGestureError(toggle, "hold"),
    mustContain: ["Airplane Mode", "hold"],
    payloadCheck: () => {
      const err = new ToggleGestureError(toggle, "multi-tap");
      assert.deepEqual(err.element, toggle);
      assert.equal(err.gesture, "multi-tap");
    },
  },
  {
    className: "UntypeableTextError",
    code: "untypeable-text",
    error: new UntypeableTextError(["é", "€"]),
    mustContain: ["é", "€"],
    payloadCheck: () => {
      const err = new UntypeableTextError(["é", "€"]);
      assert.deepEqual(err.characters, ["é", "€"]);
    },
  },
  // The five codes with no payload: thrown as plain SimGadgetError, per the spec.
  {
    className: "SimGadgetError(no-ios-runtime)",
    code: "no-ios-runtime",
    error: new SimGadgetError("no-ios-runtime", "No available iOS runtime was found."),
    mustContain: [],
    payloadCheck: () => {},
  },
  {
    className: "SimGadgetError(element-unusable-frame)",
    code: "element-unusable-frame",
    error: new SimGadgetError(
      "element-unusable-frame",
      "The element was found, but has no usable frame to aim at."
    ),
    mustContain: [],
    payloadCheck: () => {},
  },
  {
    className: "SimGadgetError(recording-already-active)",
    code: "recording-already-active",
    error: new SimGadgetError("recording-already-active", "A recording is already in progress."),
    mustContain: [],
    payloadCheck: () => {},
  },
  {
    className: "SimGadgetError(no-active-recording)",
    code: "no-active-recording",
    error: new SimGadgetError("no-active-recording", "There is no recording to stop."),
    mustContain: [],
    payloadCheck: () => {},
  },
  {
    className: "SimGadgetError(app-bundle-not-found)",
    code: "app-bundle-not-found",
    error: new SimGadgetError("app-bundle-not-found", "No app bundle exists at the given path."),
    mustContain: [],
    payloadCheck: () => {},
  },
];

test("every error case sets its code", () => {
  for (const { className, code, error } of cases) {
    assert.equal(error.code, code, `${className} should carry code "${code}"`);
  }
});

test("every error case is instanceof SimGadgetError and Error", () => {
  for (const { className, error } of cases) {
    assert.equal(error instanceof SimGadgetError, true, `${className} instanceof SimGadgetError`);
    assert.equal(error instanceof Error, true, `${className} instanceof Error`);
  }
});

test("err.name is the class name", () => {
  for (const { className, error } of cases) {
    const expected = className.startsWith("SimGadgetError") ? "SimGadgetError" : className;
    assert.equal(error.name, expected, `${className}.name`);
  }
});

test("payloads survive construction", () => {
  for (const { className, payloadCheck } of cases) {
    assert.doesNotThrow(payloadCheck, `${className} payload check threw`);
  }
});

test("the default message mentions the payload", () => {
  for (const { className, error, mustContain } of cases) {
    for (const fragment of mustContain) {
      assert.ok(
        error.message.includes(fragment),
        `${className}.message should contain "${fragment}", got: ${error.message}`
      );
    }
  }
});

// Design rule 5: messages are host-agnostic. Neither an MCP tool name nor a
// URL may leak into library prose — those belong to `simgadget-mcp`, which
// renders its own guidance from `code` and the payload.
const MCP_TOOL_NAMES = [
  "ui_tap",
  "ui_view",
  "ui_describe_all",
  "ui_describe_point",
  "ui_find",
  "ui_type",
  "ui_swipe",
  "start_simulator",
  "destroy_simulator",
  "attach_simulator",
  "rotate",
  "detect_rotation",
  "screenshot",
  "record_video",
  "stop_recording",
  "install_app",
  "launch_app",
];

test("no error message names an MCP tool", () => {
  for (const { className, error } of cases) {
    for (const tool of MCP_TOOL_NAMES) {
      assert.equal(
        error.message.includes(tool),
        false,
        `${className}.message should not name MCP tool "${tool}", got: ${error.message}`
      );
    }
  }
});

test("no error message contains a URL", () => {
  for (const { className, error } of cases) {
    assert.doesNotMatch(error.message, /https?:\/\//i, `${className}.message should not contain a URL`);
  }
});
