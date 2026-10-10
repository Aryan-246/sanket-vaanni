"use client";

import { useEffect, useRef, useState } from "react";
import "./SanketVaaniIntro.css";

/** Full-screen Sanket Vaani intro. Plays its soundtrack when browser policy permits. */
export default function SanketVaaniIntro({
  onComplete,
  src = "/videos/sanket-vaani-intro.mp4",
  poster = "/images/sanket-vaani-intro-poster.png",
}) {
  const videoRef = useRef(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const [showSoundButton, setShowSoundButton] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const finish = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current?.();
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Try autoplay with soundtrack first. Browsers may block audible autoplay.
    video.muted = false;
    video.volume = 0.9;
    const audiblePlay = video.play();
    if (audiblePlay?.then) {
      audiblePlay.then(() => {
        setSoundEnabled(true);
        setShowSoundButton(false);
      }).catch(() => {
        if (completedRef.current) return;
        video.muted = true;
        setShowSoundButton(true);
        const mutedPlay = video.play();
        if (mutedPlay?.catch) mutedPlay.catch(() => finish());
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enableSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.volume = 0.9;
    const attempt = video.play();
    if (attempt?.catch) {
      attempt.catch(() => {
        video.muted = true;
        setSoundEnabled(false);
        setShowSoundButton(true);
      });
    }
    setSoundEnabled(true);
    setShowSoundButton(false);
  };

  return (
    <div className="sv-intro" role="presentation">
      <video
        ref={videoRef}
        className="sv-intro__video"
        playsInline
        preload="auto"
        poster={poster}
        onEnded={finish}
        onError={finish}
        aria-label="Sanket Vaani opening animation"
      >
        <source src={src} type="video/mp4" />
      </video>
      {showSoundButton && !soundEnabled && (
        <button className="sv-intro__sound" type="button" onClick={enableSound}>
          <span aria-hidden="true">♪</span> Tap for sound
        </button>
      )}
    </div>
  );
}
