# Sanket Vaani — Final Website Intro Kit (with soundtrack)

This kit contains the final 6.47-second Sanket Vaani opening video with the provided soundtrack mixed in.

## Animation and audio
- The existing 97-frame hand choreography is retained at 15 FPS.
- Three broken monochrome ring arcs grow from a central point, orbit during the hand turn, then contract and disappear.
- The “संकेत वाणी” wordmark fades in once and remains still. The loading dots cycle `...` → `..` → `.` → `..` → `...`.
- The user-provided 3.08-second MP3 is repeated with a short crossfade, lightly time-stretched to fit the intro, faded in at the start and faded out at the end.
- Browsers commonly block autoplay with sound. The component first attempts audible autoplay; if blocked, it plays muted and displays a small “Tap for sound” button. A user tap enables the soundtrack.

## Files
- `public/videos/sanket-vaani-intro.mp4` — 1080×1920 H.264 MP4 with AAC soundtrack; recommended for the website.
- `public/audio/intro-soundtrack-original.mp3` — original uploaded soundtrack, for later mix adjustments.
- `public/images/sanket-vaani-intro-poster.png` — splash poster.
- `src/components/SanketVaaniIntro.jsx` — React/Next.js intro with browser autoplay fallback.
- `src/components/SanketVaaniIntro.css` — responsive full-screen video and sound button styles.
- `sanket-vaani-intro-preview.gif` — silent visual preview.
- `sanket-vaani-intro-montage.jpg` — timeline montage.
- `masters/sanket-vaani-intro-4k-upscaled.mp4` — 4K upscaled master with soundtrack.

## Integrate with React / Next.js App Router
Copy the `public/` folder contents and the component files into your application. Render the intro at the entry point where it should appear:

```jsx
"use client";
import { useState } from "react";
import SanketVaaniIntro from "./components/SanketVaaniIntro";

export default function AppShell() {
  const [introDone, setIntroDone] = useState(false);
  return (
    <>
      {!introDone && <SanketVaaniIntro onComplete={() => setIntroDone(true)} />}
      {introDone && <main>{/* your existing website */}</main>}
    </>
  );
}
```

Replace the placeholder `main` with your website. The component calls `onComplete` at the end or if media playback fails.
