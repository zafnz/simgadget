# Testing the tools

Exercises every MCP tool against one simulator. Part 1 covers portrait, Part 2 verifies coordinates after rotation, Part 3 covers views hosted by another process, Part 4 covers controls whose frame is not the thing you can touch, Part 5 checks what we assume idb_companion does, Part 6 times the server.

**Run this through the `mcp__simgadget__*` tools, one call at a time.
Do not script it without explicit permission.**

With the users permission you have `scripts/imsmd.sh start|stop|restart` that can
control the mcp for your dev and testing.

For transports, multiple sessions on one server and process lifecycle — none of which an agent can drive — see [TESTING_SERVER.md](TESTING_SERVER.md).

Session ID used throughout: `test-session`

Parts 1 and 2 use `testapp/`, a fixture built for this guide. It has no first-run wizards, and every control appears twice — once in the plain view hierarchy and once inside system chrome (nav bar, toolbar). The chrome copies are the interesting ones: their contents are absent from the default accessibility tree, so they exercise the paths that work around that. A status label reports each interaction, so a toolbar tap can be confirmed without reading the toolbar, and an orientation label reports what the app itself believes about rotation — the one fact no tool outside the app can observe.

Build it first:

```bash
testapp/build.sh
```

**Expected strings changed with the two-package split**, and only where a row
of SIMGADGET_PLAN_SERVER.md's "Deliberate behaviour changes" authorises it. The
ones that show up below: `launch_app` now reports a pid (row 12), `screenshot`
answers with the absolute path the server resolved rather than simctl's stderr
(row 9), `ui_describe_point` on empty space answers rather than erroring
(row 5), and the wedge message says whether a bridge restart was actually
attempted (row 10). **If a reply differs from this document and no row above
explains it, that is a finding for TODO.md — not a string to bring into line
mid-run.**

Two items that were open when this document was last revised are now fixed, and
their fixes are what you should see:

- **TODO #92** — `ui_describe_point` on empty space answers *"No accessibility
  element at (x, y). The simulator is answering normally, so that point is
  empty or covered — check the coordinates against ui_describe_all."*, as a
  successful result. A bare `null` means that fix has been reverted.
- **TODO #93** — `screenshot` and `record_video` describe their `output_path`
  in terms of `SIMGADGET_DEFAULT_OUTPUT_DIR`. The old spelling still works
  through the shim; only the advice moved (deliberate change 15).

**Boot time.** `start_simulator` does not return until the simulator is driveable, so no polling is needed between steps.

**If a step fails with "not answering accessibility requests"**, that is the boot wedge, not the step under test. See [BOOT_BUG.md](../devs/BOOT_BUG.md).

---

## Part 1 — Portrait

### #1 start_simulator

```
start_simulator(id: "test-session", type: "iPhone")
```

**Expected:** Simulator is created and driveable —
`Simulator started: "test-session_iphone" (<newest iPhone>, <udid>). Ready after 41s.`
The model is whatever `simctl` lists first, so it tracks Xcode rather than this
document — an iPhone 17 Pro here is the same pass as the 16 Pro that was current
when this was written.
Note the UDID; later steps need it. Continue straight to the next step.

### #2 ui_view — home screen

```
ui_view(id: "test-session")
```

**Expected:** A screenshot of the iOS home screen.

### #3 ui_describe_all — accessibility tree

```
ui_describe_all(id: "test-session")
```

**Expected:** A JSON tree whose root has a non-zero frame matching the device's logical size. Contains the home screen's app icons, the dock and the status bar.

### #4 ui_describe_point — query a coordinate

Using the centre of any app icon from step #3:

```
ui_describe_point(id: "test-session", x: <icon_x>, y: <icon_y>)
```

**Expected:** The element at that point, with an `AXLabel` matching the icon's name.

### #5 ui_swipe — swipe to the second home screen page

```
ui_swipe(id: "test-session", x_start: 350, y_start: 550, x_end: 50, y_end: 550, duration: "0.3")
```

**Expected:** "Swiped successfully".

### #6 ui_view — verify the swipe

```
ui_view(id: "test-session")
```

**Expected:** A different set of icons from step #2, confirming the page changed.

### #7 install_app

```
install_app(id: "test-session", app_path: "<repo>/testapp/build/MCPTestApp.app")
```

**Expected:** "App installed successfully from: ...".

### #8 launch_app

```
launch_app(id: "test-session", bundle_id: "com.example.mcptestapp")
```

**Expected:** `App com.example.mcptestapp launched successfully with PID: <pid>`.

> The pid is new, and it is a fix rather than an addition (deliberate change
> 12). `simctl launch` answers `com.example.mcptestapp: 18900`, and the old
> parse was anchored at the start of that line — so it never matched, and
> *every* successful launch used to answer without a pid. A reply with no
> `with PID:` now means the parse has regressed, not that simctl was quiet.

### #9 ui_view — verify the app rendered

```
ui_view(id: "test-session")
```

**Expected:** A screenshot showing a nav bar with **Nav Button**, a text field, **Plain Button**, a greyed-out **Disabled Button**, a status label reading `status: ready`, an orientation label reading `orientation: interface=portrait device=portrait`, **Show Login**, **Show Picker**, a Settings-shaped **Settings Switch** row and a plain **Split Switch** row, **Show In-App Modal**, **Ask Permission**, and a row of one-of-each controls (search bar, switch, slider, stepper, segmented control), and a bottom toolbar with **Toolbar Button** and a search field.

The tail of that list runs past the fold — the stepper and segmented control sit below the toolbar and are not visible without scrolling. They are in the tree, which is what the steps below need.

### #10 ui_describe_all — the whole tree, including system chrome

```
ui_describe_all(id: "test-session")
```

**Expected:** Every control is present, and — the point of this step — the `NavigationBar` and `Toolbar` groups **have children**:

- `NavButton`, inside the nav bar
- `PlainField`, `PlainButton`, `DisabledButton` (with `"enabled": false`), `StatusLabel`, `OrientationLabel`, `InAppModalButton`, `SystemModalButton`, `SearchBar`, `PlainSwitch`, `PlainSlider`, `PlainStepper`, `PlainSegmented` in the plain hierarchy
- `ToolbarButton` and a text field, inside the toolbar

A nav bar or toolbar coming back with no children means the tree has regressed to the incomplete read, and everything below will fail.

### #11 ui_find — a control in the plain hierarchy

```
ui_find(id: "test-session", label: "Plain Button")
```

**Expected:** A single element with that label and a usable frame. This is the fast path.

### #12 ui_find — a control inside the toolbar

```
ui_find(id: "test-session", label: "Toolbar Button")
```

**Expected:** The same shape of answer. This one is resolved by the fallback, so it takes noticeably longer than #11 — see Part 6.

### #13 ui_tap — tap a toolbar control by name

```
ui_tap(id: "test-session", label: "Toolbar Button")
ui_find(id: "test-session", label: "status:")
```

**Expected:** `Tapped "Toolbar Button" (Button) at (<x>, 822).` — the x follows the toolbar's layout on the device in front of you (76 on an iPhone 17 Pro, 102 on a 16 Pro); the y and the element named are what matter., then a status label reading `status: tapped Toolbar Button`. The reply names the element it acted on, so a lookup that resolved the wrong thing is visible here rather than in the aftermath. The status label lives in the plain hierarchy, so this confirms the toolbar tap without reading the toolbar.

### #14 ui_tap — a control that has no label

The toolbar's text field carries its visible text in `AXValue` and has no `AXLabel`:

```
ui_tap(id: "test-session", label: "Toolbar Search")
```

**Expected:** `Tapped "Toolbar Search" (TextField) at (x, y)`, where the coordinates are the centre of `ToolbarField`'s frame from step #10, and the field is focused. This is matching on value rather than label — and the reply naming a `TextField` is what confirms it matched the field and not some text saying the same thing.

> This step said `(298, 822)` until 2026-08-30, when a run reported `(324, 822)` — correct, because the toolbar's field had moved and 298 was true of an older layout. Nothing was wrong except the number in this document. Coordinates that track layout are derived from a frame here rather than written down; see TODO #107 for the same lesson learned in the e2e.

### #15 ui_type — type into the focused field

```
ui_type(id: "test-session", text: "hello")
ui_find(id: "test-session", label: "status:")
```

**Expected:** "Typed successfully", then `status: Toolbar Search = "hello"`.

### #16 ui_describe_point — hit-test a chrome control

Using the centre of the `Toolbar Button` frame from step #12:

```
ui_describe_point(id: "test-session", x: <x>, y: <y>)
```

**Expected:** The toolbar button. Point reads hit-test rather than walking the tree, so this is the control case when a name-based lookup disagrees.

### #17 screenshot — save to file

```
screenshot(id: "test-session", output_path: "/tmp/mcp-test-screenshot.png")
```

**Expected:** `Wrote screenshot to: /tmp/mcp-test-screenshot.png`. The file
exists and is a valid PNG, in physical pixels — larger than the logical frame by
the device's scale factor.

> The path said back is the **absolute** one that was resolved, composed by the
> server (deliberate change 9). It used to be whatever `simctl` printed on
> stderr.

### #18 record_video — start recording

```
record_video(id: "test-session")
```

**Expected:** `Recording started. The video will be saved to: <path>` followed
by `To stop recording, use the stop_recording command.` The path defaults under
`~/Downloads` unless `SIMGADGET_DEFAULT_OUTPUT_DIR` is set.

The tool's own `output_path` **description** names that same variable, which is
deliberate change 15 and what the parity baseline substitutes for the old
spelling. It named `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` until TODO #93 was
closed; a reply or a schema still saying so means that change has been reverted.

### #19 ui_tap — activity while recording

```
ui_tap(id: "test-session", label: "Plain Button")
ui_tap(id: "test-session", label: "Nav Button")
```

**Expected:** Both succeed; the status label reports each in turn.

### #20 stop_recording

```
stop_recording(id: "test-session")
```

**Expected:** "Recording stopped successfully." The video file exists at the path from #18, is at least a few seconds long, and is at least 100KB. Do not expect megabytes: the fixture is a mostly white, mostly static screen, which HEVC compresses very well — a 12-second recording of it came to 468KB.

### #21 destroy_simulator, then attach to a new one

```
destroy_simulator(id: "test-session")
start_simulator(id: "owner-session", type: "iPhone")
attach_simulator(id: "attach-test", udid: "<udid from owner-session>")
```

**Expected:** `Simulator destroyed: "<name>" (<udid>)`, then a new simulator,
then `Attached to simulator: "<name>" (<udid>)`.

### #22 Verify the attached session, then clean up

```
ui_view(id: "attach-test")
destroy_simulator(id: "attach-test")
destroy_simulator(id: "owner-session")
```

**Expected:** A screenshot from the same simulator; then
`Detached from simulator: "<name>" (<udid>)` for the attached session
(owned=false), and `Simulator destroyed: "<name>" (<udid>)` for the owner
(owned=true). The two verbs are the whole check: an attached session must not
delete a simulator it did not create.

---

## Part 2 — Coordinates after rotation

Verifies that coordinates read in landscape are usable in landscape. Uses the same fixture, which supports both orientations.

### #23 Start a simulator and launch the fixture

```
start_simulator(id: "landscape-test", type: "iPhone")
install_app(id: "landscape-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "landscape-test", bundle_id: "com.example.mcptestapp")
```

### #24 ui_view — confirm portrait

```
ui_view(id: "landscape-test")
```

**Expected:** The fixture in portrait: nav bar at the top, toolbar at the bottom.

### #25 ui_describe_all — note the portrait geometry

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame taller than it is wide. Note it, to compare after rotating.

### #26 Rotate to landscape

```
rotate(id: "landscape-test", orientation: "landscape_left")
```

**Expected:** `Rotated to "landscape_left" for session "landscape-test".` — the tool rotates the device and then reads the orientation back, so this wording means the interface actually adopted it. A reply of the form *"Asked the device to rotate to X, but the interface is Y"* is a real answer too, not an error: the app declined, and coordinates follow Y.

> This used to be a manual step, and Part 2 could not be run by an agent at all. Doing it by hand still works — **Device > Rotate Left** — and should give the same result, which is worth checking occasionally since it is the ground truth the tool is imitating.

### #27 detect_rotation

```
detect_rotation(id: "landscape-test")
```

**Expected:** `Detected orientation: "landscape_left" for session "landscape-test".`
after a Rotate Left, or `landscape_right` if you rotated the other way — the
same words the Simulator's own menus use.

Cross-check it against what the app itself believes:

```
ui_find(id: "landscape-test", label: "orientation:")
```

**Expected:** `orientation: interface=landscapeRight device=landscapeLeft` after a Rotate Left. The two disagree **by design** — `UIOrientation.h` defines `UIInterfaceOrientationLandscapeLeft` as `UIDeviceOrientationLandscapeRight` — and we report the orientation the *interface* is in, named in the *device* vocabulary. Do not read the mismatch as a fault; read a *match* between `device` and our answer, and a mirrored `interface`.

Upside down is not testable here: a Face ID iPhone moves the device but never gives the app an upside-down interface, so `device=portraitUpsideDown` while the interface stays where it was. Use an iPad for that case.

### #28 ui_view — confirm landscape

```
ui_view(id: "landscape-test")
```

**Expected:** A landscape screenshot of the fixture.

### #29 ui_describe_all — landscape geometry

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame now wider than tall, the reverse of #25. All five controls still present, with frames in landscape space. Note the centre of `Toolbar Button` and of `Nav Button`.

### #30 ui_tap — tap a toolbar control by landscape coordinate

```
ui_tap(id: "landscape-test", x: <toolbar_button_x>, y: <toolbar_button_y>)
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: tapped Toolbar Button`. This is the real assertion of Part 2: a coordinate taken from a landscape tree hit the element it pointed at.

### #31 ui_view — see the result

```
ui_view(id: "landscape-test")
```

**Expected:** The status label on screen reflects the tap.

### #32 ui_tap — a second control, elsewhere on screen

```
ui_tap(id: "landscape-test", x: <nav_button_x>, y: <nav_button_y>)
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: tapped Nav Button`, confirming the transformation holds in a different region.

### #33 ui_type — type in landscape

```
ui_tap(id: "landscape-test", label: "Toolbar Search")
ui_type(id: "landscape-test", text: "landscape")
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: Toolbar Search = "landscape"`.

### #34 Clean up

```
destroy_simulator(id: "landscape-test")
```

**Expected:** `Simulator destroyed: "<name>" (<udid>)`.

---

## Part 3 — Remote-hosted views

iOS draws some UI from a **separate process** hosted inside the app's window: the "Use Strong Password?" autofill sheet, photo and document pickers, share sheets. Their elements arrive in the same tree as the app's own, with nothing naming them as different, and their frames are measured from the hosting window rather than the screen.

This is the regression test for that. It is worth running carefully, because the failure mode is the worst kind this server has: `ui_tap {label}` resolves the name, taps a plausible-looking coordinate, and reports success while the touch lands somewhere else entirely. Nothing in the reply said otherwise, and the tree that would contradict it is the same tree that is wrong. Before the fix, tapping `Fill Strong Password` pressed **Login Submit**.

Both halves matter and they check opposite things. The sheet's window sits partway down the screen, so its contents need translating; the picker's window sits at the screen origin, so its contents are **already correct** and must be left alone. A fix that shifts everything hosted passes the first half and fails the second.

### #35 Start a simulator and open the login screen

```
start_simulator(id: "remote-test", type: "iPhone")
install_app(id: "remote-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "remote-test", bundle_id: "com.example.mcptestapp")
ui_tap(id: "remote-test", label: "Show Login")
ui_tap(id: "remote-test", label: "Login Password")
```

**Expected:** The **"Use Strong Password?"** sheet slides up across the bottom of the screen.

No device preparation is needed — no saved password, no Settings change, no software keyboard. If the sheet does not appear, the entitlement is missing from the build rather than the simulator being wrong; check with `otool -l testapp/build/MCPTestApp.app/MCPTestApp | grep -A2 __entitlements` and rebuild. A simulator whose password store has entries can also suppress it, by answering with a *fill* suggestion for a fuzzy-matched credential instead of generating one.

### #36 ui_view — see where the sheet actually is

```
ui_view(id: "remote-test")
```

**Expected:** The sheet occupies roughly the bottom half of the screen. On a 402x874 device its "Fill Strong Password" button is near y≈737 and its ✕ near y≈507. **Read these off the screenshot** — they are the ground truth the next step is checked against, and the whole point is that the tree cannot be trusted to supply them.

Let the sheet settle before believing the screenshot. A read taken during the presentation animation shows the sheet mid-flight and will not match a tree read taken a moment later.

### #37 ui_find — the frame must be in screen space

```
ui_find(id: "remote-test", label: "Fill Strong Password")
```

**Expected:** A frame whose centre matches the screenshot — on a 402x874 device, `y: 715.33`, `height: 44`, so a centre of **737**.

**The regression looks like `y: 239.33`**: the same rectangle measured from the sheet's own origin instead of the screen's, about 476 points too high. That number is not a magic constant to assert on — it is the hosting window's origin and moves with the sheet — so check the frame against the screenshot rather than against 715.33.

### #38 ui_describe_point — the two tools must agree

Using the centre of the frame step #37 reported — the same point you read off the screenshot:

```
ui_describe_point(id: "remote-test", x: <centre_x>, y: <centre_y>)
```

**Expected:** `Fill Strong Password`, with **the same frame `ui_find` reported**.

Two distinct failures hide here. If it returns the wrong *element* — `ScrollArea`, or the login form — then the position is wrong. If it returns the right element with a frame that does not cover the point you asked about, the tools disagree about one element, which is the defect [#58](../devs/TODO.md) was closed to prevent; a point read hit-tests and so is right about identity while having no ancestry to derive position from.

### #39 ui_type — the sheet must refuse, not swallow the text

With the sheet still up, before dismissing it:

```
ui_type(id: "remote-test", text: "hunter2abc")
ui_find(id: "remote-test", label: "Login Password")
```

**Expected:** `ui_type` **fails**, with a message naming the "Use Strong Password?" sheet and offering both ways past it — dismiss it with `ui_tap {label: "Close"}` and type again, or accept iOS's generated password with `ui_tap {label: "Fill Strong Password"}`. `ui_find` then reports `AXValue: "Password"` — the placeholder, so **not one character was typed**.

**The regression is a success line.** While that sheet is up the field holds exactly one character however many are sent — the most recent one — and a second `ui_type` seconds later leaves it at one, so it is a state rather than a race to wait out. The old version reported `Typed successfully` and left `AXValue: "•"`, so an agent believed it had entered a ten-character password when it had entered one letter. A pass here is the refusal *plus* the untouched placeholder; a `Typed successfully` line is the bug, and so is `AXValue: "•"`.

**This is iOS's behaviour, not the companion's.** Reproduced by hand on the Simulator, typing on a real keyboard with no tooling in the loop: the field takes one character and replaces it on every subsequent keystroke. Nothing here can fix that, which is why the tools refuse and name the way out instead — an agent should not have to discover the overlay from a screenshot and dismiss it by coordinate.

`hid` is the only input path the companion has, so there is no way to deliver the keystrokes past the sheet — refusing is the whole remedy.

**The control case is on this same screen.** Below the config line sits `Password Field` (`PasswordField`), `secureTextEntry` and nothing else, which raises no sheet. Dismiss the sheet, tap it, `ui_type` ten characters, and `PasswordEchoLabel` must read `typed: "hunter2abc" (10)`. If that one also loses characters the problem is not the sheet, and nothing in #39 applies.

The check is two stages, and step #15 is what proves the first one stays cheap. A default-backend read (~25–110 ms) asks whether a *masked* field has the keyboard; only if it does is the AXBridge lookup for the sheet (~280–340 ms) worth making, and only AXBridge can see the sheet at all. So an ordinary `ui_type` pays the small number and a password one pays both. If this step starts *failing*, check `typingBlocker()` in [packages/simgadget/src/simulator.ts](../../packages/simgadget/src/simulator.ts) and run `npm run check:companion -- <udid> --password-sheet`, which pins all three beliefs this rests on.

### #40 ui_tap — the tap must land on the button

```
ui_tap(id: "remote-test", label: "Fill Strong Password")
ui_view(id: "remote-test")
```

**Expected:** The sheet dismisses and the password field is **filled with a generated password** (a long row of dots).

This is the step that matters most, because it is the one an agent actually takes. A success line is **not** a pass on its own — the broken version returned one too. Only the screenshot decides. If the login screen is unchanged, or the app has navigated because "Login Submit" was pressed instead, the fix has regressed.

### #41 The control case — a picker must be left alone

```
launch_app(id: "remote-test", bundle_id: "com.example.mcptestapp", terminate_running: true)
ui_tap(id: "remote-test", label: "Show Picker")
ui_find(id: "remote-test", label: "Collections")
```

**Expected:** The photo picker opens, and `Collections` reports a frame **in the nav bar, near the top of the screen** — on the 402x874 device this was written against, `{x: 201, y: 86, width: 95, height: 48}`.

Unlike the coordinates elsewhere in this document, this one is quoted deliberately: what is being checked is that the frame comes back *untranslated*, and a number iOS chose is the only way to say that. Check the shape rather than the digits — a `y` in the tens, inside the nav bar — because a picker laid out differently by a later iOS is not a failure. **A `y` several hundred points down the screen is**, and that is the regression.

The picker is hosted by another process exactly as the sheet is, but its window is at the screen origin, so **these coordinates are already correct and must come back unchanged**. A frame pushed down the screen here means the translation is being applied blindly to anything hosted, rather than by how far the hosting window actually sits from the origin.

### #42 ui_tap — the picker still taps correctly

```
ui_tap(id: "remote-test", label: "Collections")
ui_view(id: "remote-test")
```

**Expected:** The picker switches to its Collections view — "Pinned", "Albums", "Shared Albums".

### #43 Clean up

```
destroy_simulator(id: "remote-test")
```

**Expected:** `Simulator destroyed: "<name>" (<udid>)`.

---

## Part 4 — Toggles, by name and by coordinate

A switch is the one control whose accessibility frame is routinely **not** the thing you can touch. A Settings row publishes one element spanning label and control, so its centre is the gap between them; and even a bare `UISwitch` inherits whatever width its layout gives it. Tapping the centre of either actuates nothing, and it never did — measured 0/6 and 0/8 on the pinned companion and the 2022 one alike.

So `ui_tap {label}` operates a toggle through accessibility instead, the way VoiceOver does, while `ui_tap {x, y}` stays a real touch. **Both are checked here in one place, deliberately**: they are different mechanisms that can regress independently, and when a toggle stops working the first question is which of the two broke.

### #44 Start a simulator and launch the fixture

```
start_simulator(id: "toggle-test", type: "iPhone")
install_app(id: "toggle-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "toggle-test", bundle_id: "com.example.mcptestapp")
```

**Expected:** The fixture, with a Settings-shaped `Settings Switch` row — label left, switch right — a little below `Show Picker`.

### #45 By name — the toggle must flip, and say so

```
ui_tap(id: "toggle-test", label: "Settings Switch")
```

**Expected:** `Toggled Settings Switch off -> on.`

Three distinct failures hide behind this one line:

- **`Tapped "Settings Switch" (Switch) at ...`** means the element was not recognised as a toggle, so it was touched at its centre instead of activated. The state will not have changed. This is the original bug.
- **`Activated Settings Switch through accessibility, but it is still off`** means activation reached the element and the element did nothing with it. That is an app-side gap rather than a tool one — a merged row that never implements activation cannot be worked by VoiceOver either — but check the fixture has not regressed into publishing a cell instead of the switch.
- **`could not read its state back`** means the toggle flipped but the confirming lookup failed. Most likely something else on screen now matches the name.

Run it twice more and confirm it round-trips — `on -> off`, then `off -> on`. The second call is the one that catches a read-back keyed on a label rather than an identifier: by then the status line reads `settings toggle = on`, and a lookup that matches loosely will find that sentence rather than the switch.

### #46 By coordinate — a real touch must also flip it

Read the switch's position off `ui_view` — **not** off the tree, whose frame spans the whole row and whose centre is the gap:

```
ui_view(id: "toggle-test")
ui_tap(id: "toggle-test", x: <switch_x>, y: <switch_y>)
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** a `Tapped ... at (x, y)` line, and the status line changes — `status: settings toggle = ...`, flipped from wherever #45 left it.

This is the half that depends on a tap being **held**. An instantaneous touch actuates a switch about 40% of the time, so a coordinate tap that works once proves little; if this step is flaky, that floor has regressed rather than anything about toggles. See `MIN_TAP_HOLD_SECONDS` in [packages/simgadget/src/ax/tap.ts](../../packages/simgadget/src/ax/tap.ts), where the measurement that fixed the constant sits beside it.

### #47 The boundary: a name that is not a control

```
ui_tap(id: "toggle-test", label: "Split Switch")
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** `Tapped "Split Switch" (StaticText) at ...`, and **the status line does not change**.

The `(StaticText)` in that reply is the useful part: it says plainly that the name resolved to a piece of text rather than a control, which is the whole reason nothing happened.

That is correct, not a bug, and it is here so nobody later "fixes" it. `Split Switch` is a label and a switch in a plain container with nothing merging them, so iOS publishes two elements: a static text carrying the name, and an unnamed switch beside it. The name genuinely refers to the text. A VoiceOver user meets the same wall and moves on to the switch. The rule the tools follow is that they operate what iOS says the element *is* — and no amount of activation makes a label into a control.

### #48 A toggle the action API cannot reach must still be tapped

The fixture's toolbar carries a switch. It lives in system chrome, so the cheap
backend cannot see it — and `AccessibilityActionRequest` has **no `backend`
field**, where the read request does, so a lookup can fall back to AXBridge and
an activation cannot.

```
ui_find(id: "toggle-test", label: "Toolbar Switch")
ui_tap(id: "toggle-test", label: "Toolbar Switch")
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** the find returns the switch; the tap answers `Tapped "Toolbar Switch" (Switch) at (x, y)` — at the centre of the frame the find just reported, and a *tap*, not a toggle — and the status line reads `status: toolbar toggle = on`.

Two failures to watch for, and they are opposite:

- **`INTERNAL: The accessibility backend found no element ...`** is the regression this step exists for. It means the activation path failed and did not hand back to a touch, so `ui_find` and `ui_tap` now contradict each other about an element that is plainly there and plainly operable by coordinate.
- **`Toggled Toolbar Switch ...`** would mean the action API has grown the reach it lacked — welcome news, worth checking `npm run check:companion` and simplifying this path, but not what today's idb does.

Run it twice and confirm the status flips back, then check the ordinary toggle still activates:

```
ui_tap(id: "toggle-test", label: "Settings Switch")
```

**Expected:** `Toggled Settings Switch off -> on.` The two must not converge: `Settings Switch` is activated because its centre is not the control, `Toolbar Switch` is touched because it cannot be activated. A build where both report the same verb has lost one of the two mechanisms.

### #49 A disabled control must refuse, not swallow the tap

```
ui_find(id: "toggle-test", label: "Disabled Button")
ui_tap(id: "toggle-test", label: "Disabled Button")
```

**Expected:** the find reports `"enabled": false`; the tap is an **error**:

> `"Disabled Button" is disabled, so tapping it would do nothing. It is at {x:… y:… w:… h:…}.`

The frame it names must be the one `ui_find` just reported. Then check that the refusal is telling the truth rather than merely being careful — a real touch at the same place must also do nothing, so aim at the centre of that frame:

```
ui_tap(id: "toggle-test", x: <centre_x>, y: <centre_y>)
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** `status: ready`, unchanged. The fixture's disabled button *is* wired to an action, so `status: disabled button fired` would mean something activated a control iOS says is off — a far more interesting failure than the one this step is guarding.

A disabled control is worth its own step because its symptom is identical to every other kind of failed tap: the touch is delivered, nothing happens, and before this check the reply said success.

### #50 A covered control must refuse, not tap something else

`Covered Button` is pinned to the bottom of the view, underneath the toolbar, so it is covered by construction rather than because of how much sits above it. (It used to be the stepper, which was covered only by accident of layout — adding one row to the fixture moved it off the screen entirely and this step started passing for the wrong reason. See TODO #106/#107.)

```
ui_tap(id: "toggle-test", label: "Covered Button")
```

**Expected:** an **error**, naming what is in the way:

> `"Covered Button" is at {x:... y:... w:... h:...}, but "Toolbar Search" is there instead, so a tap at its centre (..., ...) would not reach it — it is covered, off screen, or scrolled out of view. Scroll it into view, or read its real position from ui_view and use ui_tap {x, y}.`

Then confirm nothing was pressed behind the refusal — the covered button is wired to the status line:

```
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** unchanged. `status: covered button fired` would mean the touch went out before the refusal.

**A `Tapped ...` reply here is the regression.** Before this check existed, that call focused the toolbar's search field, opened the keyboard, and reported success. Every frame involved was correct, so no amount of tree work would have caught it — the guard is a single hit-test at the point about to be touched, ~10 ms against a tap that already costs ~110 ms.

Then confirm it has not become over-eager, which would be worse than the bug it prevents:

```
ui_tap(id: "toggle-test", label: "Plain Button")
ui_tap(id: "toggle-test", label: "Toolbar Button")
ui_tap(id: "toggle-test", label: "Nav Button")
```

**Expected:** three `Tapped ... at (x, y)` replies. `Toolbar Button` is the one to watch — it lives in system chrome and is resolved by the AXBridge fallback, so it exercises the verification against an element the cheap backend cannot see.

### #51 A covered *toggle* must refuse too, and press nothing

The step that would have caught TODO #105. A toggle takes the activation path, which used to skip the hit-test on the grounds that an activation names an element rather than a point. It does not behave that way: a covered activation operates whatever is on top.

Relaunch first, so the status line starts from `ready`:

```
launch_app(id: "toggle-test", bundle_id: "com.example.mcptestapp", terminate_running: true)
ui_find(id: "toggle-test", label: "status:")
ui_tap(id: "toggle-test", label: "Covered Switch")
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** `status: ready`, then an **error** naming `Toolbar Button` as what is in the way, then `status: ready` again — unchanged.

**Two different replies are the regression, and the second is the dangerous one:**

- `Toggled Covered Switch off -> on` would mean the hit-test is not gating activations at all.
- `Activated Covered Switch through accessibility, but it is still off` with the status line now reading `status: tapped Toolbar Button` is the original bug exactly: the caller is told to scroll and retry while the toolbar's button has already been pressed. That reply is only correct when the status line has *not* changed.

```
destroy_simulator(id: "toggle-test")
```

---

## Part 5 — What we assume idb_companion does

Everything above tests this server. This part tests the **binary underneath it**, and belongs to a different question: idb is under active development, none of these behaviours is something upstream has promised to keep, and every one of them is load-bearing for a decision in `packages/simgadget/src/`. They are also all invisible while they hold — a companion that changed its mind would leave this server quietly doing the wrong thing rather than failing.

```bash
npm run build && testapp/build.sh
# install and launch the fixture, main screen
npm run check:companion -- <udid>
```

Six assumptions, each named with what depends on it (four more follow, each needing a screen of its own):

| assumption | what breaks if it changes |
|---|---|
| a marker matches a **substring** | every partial name an agent uses stops resolving |
| a marker returns the **first** match, server-side | ambiguity becomes detectable on the fast path, and `matchInTree`'s ranking and `ui_tap`'s naming could be revisited |
| a marker returns **one element**, not a list | `findByLabel` mis-parses the response rather than rejecting it |
| the default backend **cannot** see toolbar contents, AXBridge **can** | the ~300ms fallback is either dead weight or newly essential |
| a point read **hit-tests**, under 100 ms | `ui_tap`'s verification stops being affordable |
| `accessibility_action` **activates** without a touch | tapping a toggle by name has no mechanism at all |

Then, with a remote-hosted view on screen — tap **Show Picker**, or raise the autofill sheet from Part 3:

```bash
npm run check:companion -- <udid> --remote
```

which checks the seventh: that a hosted view still restarts its coordinate space at a node of type `"83"`. If that changes, `translateRemoteSubtrees` silently stops translating and taps inside sheets land hundreds of points away again.

And with the strong-password sheet up — **Show Login**, then tap **Login Password**:

```bash
npm run check:companion -- <udid> --password-sheet
```

which checks the eighth, ninth and tenth: that the **default backend cannot** resolve the sheet's `GenerateStrongPasswordButton` while **AXBridge can**, and that the default backend publishes `IsEditing` and `SecureTextField` in `traits` for the focused password field. The first two are the same backend split as toolbar contents, for a marker query rather than a tree read. The third is the cheap gate in front of it — `ui_type` only pays for the AXBridge lookup once a masked field is known to have the keyboard (#39).

Each fails silently in the same direction: if AXBridge stops seeing the sheet, or either trait name changes, the refusal stops firing and `ui_type` goes back to reporting a password typed that was not typed.

**Run this after bumping `companion.lock.json` or the submodule**, before trusting the new binary. As a demonstration that it bites, run it against the 2022 brew companion, which fails five of the six:

```bash
SIMGADGET_COMPANION_PATH=/opt/homebrew/bin/idb_companion npm run check:companion -- <udid>
```

— reporting, among other things, that `accessibility_action` is `UNIMPLEMENTED` there.

---

## Part 6 — Round-trip timing

Measures how long the **server** takes, with no model in the loop. Driving the tools through an agent measures the agent; this measures the tool.

Needs the server in HTTP mode and a booted simulator in a session named `rtt`. Start one however you like, then:

```bash
call() {
  curl -s -o /tmp/rtt-out.txt -w '%{time_total}' \
    -X POST http://127.0.0.1:8008/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}
med() { sort -n | awk '{a[NR]=$1} END{printf "%.0f ms\n", a[int(NR/2)+1]*1000}'; }

time_tool() {   # time_tool <name> <json args>
  printf '%-24s ' "$1"
  BODY="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
  for _ in $(seq 6); do call "$BODY"; echo; done | med
}
```

Then:

```bash
time_tool ui_tap            '{"id":"rtt","x":200,"y":400}'
time_tool ui_describe_point '{"id":"rtt","x":200,"y":400}'
time_tool ui_find           '{"id":"rtt","label":"Settings"}'
time_tool ui_find           '{"id":"rtt","label":"ZZZnope"}'
time_tool ui_describe_all   '{"id":"rtt"}'
time_tool ui_view           '{"id":"rtt"}'
```

**Expected**, as medians on an M-series Mac. Exact numbers vary with the machine and what else is running; the **ratios** are what matter:

| Call | Order of magnitude |
|---|---|
| `ui_tap` by coordinate | **100–150 ms** — the 100 ms hold, plus the round trip |
| `ui_tap` by label | **150–200 ms** — the above, plus the lookup and the hit-test that verifies it |
| `ui_describe_point` | under 50 ms |
| `ui_find`, name present in the cheap tree | ~25 ms |
| `ui_find`, name absent — falls back | ~300 ms |
| `ui_describe_all` | ~300 ms |
| `ui_view` | ~350 ms |

Two things to check rather than exact figures:

- **`ui_tap` costs its own hold, and nothing else. Expect 100–150 ms.** Every tap is held for 100 ms (`MIN_TAP_HOLD_SECONDS`), because an instantaneous touch actuates a control only about 40% of the time — see Part 4. Everything above the hold is the real round trip, so the healthy band is 100–150 ms and the interesting readings are outside it: **below 100 ms the floor has been lost** and taps are unreliable again, which no other check in this file would notice; well above 150 ms is a slow companion connection rather than the tool.
- **`ui_describe_point` is fast** — single digits on an idle machine, under 50 ms in any case. It scales with what else the machine is doing: a busy Mac was measured at 22 ms, with every other figure in the table up by the same factor.
  - **`ui_describe_point` is the one to watch, and this row has caught a real regression.** It is the only cheap tool that can quietly become an expensive one, because it falls back to a whole-screen read when a frame looks like it belongs to a remote-hosted view (Part 3). Get that condition wrong and every point read pays ~300 ms while still returning the right answer, so nothing fails — the number here is the only thing that notices. A measurement of ~300 ms means the fallback is firing on ordinary elements; `isRemotelyHosted` in [packages/simgadget/src/ax/tree.ts](../../packages/simgadget/src/ax/tree.ts) is the thing to look at. It was measured at 313 ms once, because a hit-test at x=200 returns the home screen's Health icon, whose frame ends at x=188.67.
- **Anything reading the whole screen costs ~300 ms**, because it reads the app's real view hierarchy. A `ui_find` that misses pays the same, since it falls back to that read. This is the reason to tap by name rather than describing the screen and picking coordinates.

**Measure against a screen that does not change.** Three of these tools alter what
is on screen — tapping an app icon launches it, tapping a fixture button that
navigates leaves the screen the next iteration is measured on. A loop that does
that stops measuring what it claims to: a `ui_find` hit becomes a miss and reads
~350 ms instead of ~20 ms, which looks exactly like a regression in the fast
path. It happened three times while writing this table. Tap something inert (the
fixture's `Plain Button`), name something that is definitely on the screen in
front of you rather than one you remember, and check the first call's *reply*
before trusting the other five.

Discard the first call after a simulator starts — it includes connecting to the companion and runs an order of magnitude slower than the rest.

---

## Result

All tools tested:

| Tool | Steps |
|------|-------|
| `start_simulator` | #1, #21, #23, #35, #44 |
| `destroy_simulator` | #21, #22, #34, #43, #50 |
| `attach_simulator` | #21 |
| `rotate` | #26 |
| `detect_rotation` | #27 |
| `ui_describe_all` | #3, #10, #25, #29 |
| `ui_find` | #11, #12, #13, #15, #30, #32, #33, #37, #39, #41, #46, #47, #48, #49 |
| `ui_tap` | #13, #14, #19, #30, #32, #33, #35, #40, #42, #45, #46, #47, #48, #49, #50 |
| `ui_type` | #15, #33, #39 |
| `ui_swipe` | #5 |
| `ui_describe_point` | #4, #16, #38 |
| `ui_view` | #2, #6, #9, #24, #28, #31, #36, #40, #42, #46 |
| `screenshot` | #17 |
| `record_video` | #18 |
| `stop_recording` | #20 |
| `install_app` | #7, #23, #35, #44 |
| `launch_app` | #8, #23, #35, #41, #44 |
