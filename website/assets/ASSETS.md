# Graphics the site needs

One thing is missing and one is a placeholder. Everything else is real and
finished.

| Asset | Status | Blocking? |
|---|---|---|
| `demo.mp4` | ❌ missing — CSS stand-in plays instead | No, but it's the hero |
| `og-image.png` | ✅ done — rasterised from `og-image.svg` | — |
| `demo-poster.svg` | ⚠️ placeholder | Only matters once `demo.mp4` exists |
| `logo.png` | ✅ done — the mark, used in the site nav/footer | — |
| `banner.png` | ✅ done — 1600×400 README banner, from `banner.svg` | — |
| `logo-source.png` | ✅ the untrimmed original `logo.png` was delivered as | — |
| `favicon.png`, `apple-touch-icon.png` | ✅ done — derived from `logo.png` | — |
| `favicon.svg`, `logo.svg` | ⚪ superseded by the PNG mark, kept unreferenced | — |

---

## 1. `demo.mp4` — the hero video

**This is the one that matters.** It is the only place on the site where
someone sees the product actually work, and the whole pitch is "it does what
it says it did".

### What it should show

A short loop of an agent driving a real simulator. The story, in order:

1. A tool call goes out — `ui_tap { label: "Sound" }`.
2. The switch on the simulator flips.
3. The reply comes back naming the state it read: `Toggled Sound off -> on.`
4. `ui_tap { label: "Sign Up" }` → the button presses, the screen changes.

If you can fit a fifth beat, **make it a refusal** — tap something covered
and let it come back with `Refused: "Stepper" is covered by "Search"`. That
is the single most distinctive thing SimGadget does and no competitor's demo
can show it.

Do not speed it up or cut between takes. The point is that it is this fast
unedited. Per the pitch: a cheap fast model is quick enough to record this in
real time, so use one.

### Format

| | |
|---|---|
| **Framing** | The simulator screen only — crop out the Simulator.app window chrome, the bezel and the macOS desktop. The page draws its own device frame around it. |
| **Aspect** | Portrait, the device's own. The box is `300 × 620` CSS px with `object-fit: cover`, so anything from 0.45 to 0.52 fits without visible cropping. |
| **Resolution** | 600 × 1240 or larger (2× the display box). Downscaling the native recording is fine; don't upscale. |
| **Duration** | 10–20 s. It loops, so the last frame should sit comfortably next to the first — end back on the Settings screen if you can. |
| **Codec** | H.264 in MP4, `-movflags +faststart`. |
| **Audio** | None. The element is `muted` and browsers require it for autoplay. |
| **Size** | Under 3 MB. It loads on first paint. |

### Capturing it

The server records its own screen:

```
record_video { id: "demo", path: "/tmp/demo.mov" }
…drive the simulator…
stop_recording { id: "demo" }
```

Then crop and encode:

```bash
ffmpeg -i /tmp/demo.mov -vf "crop=iw:ih:0:0,scale=600:-2" \
  -c:v libx264 -crf 24 -preset slow -an -movflags +faststart \
  website/assets/demo.mp4
```

### After you add it

- The page needs **no other change** — `site.js` detects the video and hides
  the stand-in automatically.
- Replace `demo-poster.svg` with a real first frame (`demo-poster.jpg`,
  same dimensions) and update the `poster=` attribute in `index.html`.

---

## 2a. `banner.png` — the README banner

`banner.svg` is the source, with `logo.png` embedded as a data URI the same way
the social card does it. 1600 × 400 (4:1): GitHub's README column renders at
about 900px wide whatever the window size, so the asset is 2x that for retina.

```bash
rsvg-convert -w 1600 -h 400 website/assets/banner.svg \
  -o website/assets/banner.png
```

Judge any change at 900 × 225, not at full size — that is what a reader sees.

---

## 2. `og-image.png` — the social card

`og-image.svg` in this directory is the source: the mark, the wordmark, the
headline, the two install commands, on the dark ground. `logo.png` is embedded
in it as a base64 data URI, so the file rasterises standalone. **Re-export
after editing it**, because no Open Graph consumer renders SVG.

```bash
# 1200 × 630, which is what the meta tag already points at
rsvg-convert -w 1200 -h 630 website/assets/og-image.svg \
  -o website/assets/og-image.png
```

or, without rsvg:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --window-size=1200,630 --default-background-color=0 \
  --screenshot=website/assets/og-image.png \
  file://$PWD/website/assets/og-image.svg
```

Check the result renders the system font stack the way you want — if the
export box substitutes something ugly, convert the two headline lines to
paths first.

---

## 3. Optional, if you want them

Nothing below is referenced by the site; these would each need markup added.

- **`apple-touch-icon.png`** (180 × 180) — the favicon on a solid dark
  square. One line in each `<head>`.
- **A real multi-agent screenshot** for `mcp.html` — three simulators side by
  side on one desktop, three agent panes driving them. The SVG diagram
  already carries the *idea*; a photo of it actually happening would carry
  the proof. Same argument as the demo video.
- **A terminal capture of a refusal** — the `Refused: … is covered by …`
  message in a real client. Currently rendered as styled HTML on `mcp.html`,
  which is sharper and themes correctly, so a screenshot is a downgrade
  unless it's showing a real client's UI around it.
