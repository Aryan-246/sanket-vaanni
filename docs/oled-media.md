# OLED Media — constraint, workflow, and what is NOT implemented

> ## ⚠️ Status: not implemented
>
> **No image and no frame sequence can be converted, previewed or stored in this
> build.** There is no decoder, no dithering step, and no frame-conversion
> library installed. The OLED Studio's *Images and animations* card carries a
> `Not implemented` badge for exactly this reason.
>
> Nothing in this file describes working code. It records what the hardware
> fixes, what the workflow has to be, and what has to be verified before any of
> it is written — so that a later milestone does not start by re-deriving it, and
> so that no one mistakes the badge for a placeholder that will fill itself in.

---

## 1. What the hardware fixes

These numbers come from the panel, not from a measurement of this app.

| Property | Value | Consequence |
|---|---|---|
| Resolution | 128 × 64 px | The whole design space. There is no scaling to a larger canvas. |
| Colour | 1 bit per pixel, monochrome | A pixel is on or off. Grey exists only as a dither pattern. |
| Full frame | **1024 bytes** | `128 × 64 / 8`. This is the uncompressed payload of one whole screen. |
| Addressable window | 8 pages of 128 bytes | The SSD1306's native layout, if the transport sends raw pages. |
| Controller | SSD1306 | The command set is public; the *transport* to it is not. See §5. |

What this means in practice, and what the brief requires the app to say plainly:
**the panel cannot play ordinary full-resolution or full-colour video.** It can
show a sequence of 128×64 one-bit images, and only as fast as the transport can
carry them. A phone-quality clip is not a lossy version of what the panel can do
— it is a different kind of thing.

A 1024-byte frame is arithmetic, and it is the only size figure quoted anywhere
in the app. How many frames fit, and how fast they can be sent, depends on a
firmware transport that has not been verified, so the app promises neither a
frame count nor a playback rate.

---

## 2. What the workflow has to be

Written out here so that the UI, the storage shape and the converter agree when
they are built, rather than being negotiated three ways later.

```
media picker  →  crop / fit  →  resize to 128×64  →  monochrome  →  preview  →  budget check  →  save
                 (aspect preserved)   (or 128 tall × N wide for a strip)
                                                       threshold | dither
```

1. **Selection.** Android's own picker, through a media-picker module — not a
   hand-rolled file browser. The app has no picker dependency today.
2. **Crop or fit, aspect preserved.** Offer both; never stretch. A 16:9 source
   squeezed to 2:1 is a distortion the user will blame on the panel.
3. **Resize to the panel.** 128×64 for a still. For a sequence, the frame is
   still 128×64 and the *count* varies — a "strip" of frames is app-side
   storage, not a wider panel image.
4. **Monochrome conversion.** Two routes, both offered:
   - **Threshold** — one level, hard edges. Correct for line art, text, logos.
   - **Dithering** (Floyd–Steinberg or ordered Bayer) — perceived greys, at the
     cost of texture. Correct for photographs, and visibly worse for text.
   The choice matters more than any other step; a thresholded photograph and a
   dithered one are unrecognisably different at this size.
5. **Exact-output preview.** The preview must be the literal 128×64 one-bit
   result at a legible scale — the same renderer the layout preview already
   uses — not a filtered approximation of the source.
6. **Readability and clipping warnings.** Warn on: detail finer than one pixel
   (which mangles), a subject that falls outside the crop, and a source whose
   contrast collapses to a single tone after thresholding.
7. **Budget check.** Show frames × 1024 bytes and the time that takes at the
   verified transfer rate — *once there is one*. Until then, show the byte total
   and say the rate is unknown (see §5). Warn when a sequence would exceed a
   budget, and offer the still image instead.

### Trimming, for a video source

A clip needs trim points, a target frame rate and frame timing, and a derived
frame count. None of that exists yet. Frame timing is a firmware question as
much as an app question: the panel holds one frame until the next arrives, so
*when* to send the next frame is decided by the transport, not by the video's
original frame rate.

---

## 3. Why no conversion library was installed

The brief asked for this to be inspected before a library was added, and the
inspection is the reason the feature is absent rather than half-present.

- **A full FFmpeg binding** (`ffmpeg-kit-react-native` and its forks) is a
  multi-megabyte native dependency with its own NDK build. The upstream project,
  FFmpegKit, was **retired with no further releases**, and its prebuilt binaries
  were **withdrawn during 2025** — versions below 6.0 until 1 February 2025,
  version 6.0 until 1 April 2025 — after which the package was deprecated on npm
  and its remote pod and Maven sources stopped resolving. Adoption today means
  adopting an unmaintained native blob, or self-hosting a fork's binaries, which
  is a supply-chain decision rather than a build step. It is also a licence
  question: the retired binaries shipped in LGPL and GPL variants depending on
  which codecs were compiled in.
- **Anything requiring the New Architecture** has to be checked against RN
  **0.87.1** specifically, which this app runs on (bridgeless, Fabric, Hermes).
  A library that has not been exercised on 0.87 is an unknown, and an unverified
  native dependency inside a build that currently compiles is a poor trade for a
  feature whose transport does not exist yet.
- **A decoder is not the hard part, and not the useful part.** Thresholding and
  dithering are a few dozen lines of pure TypeScript over a pixel buffer — they
  need no native code and are easy to test. What is missing is the *decode* step,
  and a decode step without a verified transport produces bitmaps that can go
  nowhere.

So the honest position: the arithmetic, the preview and the constraint text are
implemented; the conversion is not; and the missing piece is documented rather
than stubbed. A button that opened a picker and produced nothing would be worse
than a badge that says so.

---

## 4. What the storage shape will have to hold

Not yet written. Recorded because it constrains the profile model, which is
already written.

A profile's hand config holds `layout` and `intro` today. A media item adds:

- a reference to the converted asset (a key, not the bytes inline),
- its own per-frame dimensions and frame count,
- the conversion settings that produced it (threshold or dither, threshold
  value, crop rectangle, trim points, target rate),

and the asset itself is stored **once**, outside the profile, with profiles
pointing at it. Two profiles showing the same logo must not store it twice, and
deleting the last profile that references an asset should be what makes the
asset collectable — not a save that duplicating a profile triggers, which would
be a silent way to lose an image another profile still uses.

`featureKeys.oledProfiles` is where the profile data lives; the asset store will
need its own key and its own size ceiling, because AsyncStorage is not a media
store. Sizing that, and choosing whether converted frames go to the filesystem
instead, is part of the work, not an afterthought.

---

## 5. What must be verified before any of this ships

The blocking list, in order. Each item is an open question, and each answer has
to come from the firmware or a measurement — never from inference.

| # | Question | Why it blocks |
|---|---|---|
| 1 | Does the firmware accept image/frame data at all, or only layout commands? | If not, nothing in this document is buildable. |
| 2 | What is the transfer rate over the actual link (BLE, or otherwise)? | Decides the frame-count budget and whether a sequence is worth offering. |
| 3 | How are frames framed — raw pages, a length-prefixed packet, a run-length scheme? | Decides the encoder. `docs/ble-protocol.md` records the same gap for sensor data. |
| 4 | Does the panel buffer frames, or must the host pace them? | Decides who owns timing. |
| 5 | Is there flash on the device to hold a sequence, or must it stream from the phone? | A stored sequence and a streamed one are different products. |
| 6 | What is the device's free-space budget, if it has storage? | Decides the sequence length ceiling. |

Until 1–4 are answered, a converter would be writing into an interface that does
not exist. `docs/ble-protocol.md` states the same rule for the sensor path, and
it applies here unchanged: **no guessed constant may be turned into a shipped
one.**

---

## 6. Summary

| Part | Status |
|---|---|
| 128×64, 1bpp constraint stated in the app | **Implemented** (the card's copy, `FRAME_BYTES`) |
| 1024-bytes-per-frame arithmetic | **Implemented** — arithmetic, not a measurement |
| Exact-output preview renderer | **Implemented** — shared with the layout preview (`OledCanvas`) |
| Frame-budget warning | **Not implemented** — needs the transfer rate (§5 item 2) |
| Media picker / crop / fit | **Not implemented** |
| Threshold and dither conversion | **Not implemented** — deliberately pure-TS work for later |
| Video trim / frame timing / frame count | **Not implemented** |
| Converted-asset storage and collection | **Not implemented** |
| Any write of a converted frame to a device | **Not implemented, and not claimed** |

No control in the OLED Studio claims any of the unimplemented rows. The screen
says the conversion is absent, quotes the one figure the hardware fixes, and
stops there.
