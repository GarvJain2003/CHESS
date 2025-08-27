import { useEffect, useRef, useState } from "react";

export default function S_Screen({ onFinish, src = "/intro.mp4" }) {
  const videoRef = useRef(null);
  const [hasInteracted, setHasInteracted] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnded = () => onFinish?.();
    v.addEventListener("ended", onEnded);
    const t = setTimeout(() => onFinish?.(), 15000);
    return () => { v.removeEventListener("ended", onEnded); clearTimeout(t); };
  }, [onFinish]);

  const enableSoundAndFullscreen = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.muted = false;
      setHasInteracted(true);
      await v.play();
      if (v.requestFullscreen) await v.requestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    } catch {}
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#000",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        src={src}
        autoPlay
        muted
        playsInline
        // FORCE full-viewport cover:
        style={{
          width: "100vw",
          height: "100vh",
          objectFit: "cover",
          display: "block",
        }}
      />

      {/* Skip */}
      <button
        onClick={() => onFinish?.()}
        style={{
          position: "absolute",
          right: "1rem",
          bottom: "1rem",
          padding: ".6rem .9rem",
          border: 0,
          borderRadius: "999px",
          background: "rgba(255,255,255,.9)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Skip Intro
      </button>

      {/* Unmute / fullscreen */}
      {!hasInteracted && (
        <button
          onClick={enableSoundAndFullscreen}
          style={{
            position: "absolute",
            left: "50%",
            bottom: "1rem",
            transform: "translateX(-50%)",
            padding: ".6rem .9rem",
            border: 0,
            borderRadius: "999px",
            background: "rgba(255,255,255,.9)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Tap to enable sound
        </button>
      )}
    </div>
  );
}