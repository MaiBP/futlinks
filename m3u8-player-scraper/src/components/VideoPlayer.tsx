import { useEffect, useRef } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

type Props = { src?: string };

export default function VideoPlayer({ src }: Props) {
    const videoEl = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<any>(null);
    const initializedRef = useRef(false);

    // Init ONCE
    useEffect(() => {
        if (!videoEl.current) return;
        if (initializedRef.current) return; // ✅ evita doble init en StrictMode DEV
        initializedRef.current = true;

        playerRef.current = videojs(videoEl.current, {
            controls: true,
            autoplay: false, // mejor: controlamos play en el effect de src
            preload: "auto",
            responsive: true,
            fluid: false,
            liveui: true,
        });

        return () => {
            // ✅ dispose safe
            try {
                if (playerRef.current) {
                    playerRef.current.dispose();
                    playerRef.current = null;
                }
            } catch {
                // ignore
            }
        };
    }, []);

    // Update src
    useEffect(() => {
        const player = playerRef.current;
        if (!player) return;

        if (!src) {
            try {
                player.pause();
            } catch { }
            return;
        }

        try {
            player.src({ src, type: "application/x-mpegURL" });
            player.play().catch(() => { });
        } catch {
            // ignore
        }
    }, [src]);

    return (
        <div data-vjs-player style={{ width: "100%", height: "100%" }}>
            <video
                ref={videoEl}
                className="video-js vjs-big-play-centered"
                playsInline
                style={{ width: "100%", height: "100%" }}
            />
        </div>
    );
}