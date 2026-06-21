import { useEffect, useRef } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

type PlaybackStatus = "checking" | "active" | "inactive";

type Props = {
    src?: string;
    onStatusChange?: (src: string, status: PlaybackStatus) => void;
};

export default function VideoPlayer({ src, onStatusChange }: Props) {
    const videoEl = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<ReturnType<typeof videojs> | null>(null);
    const initializedRef = useRef(false);
    const onStatusChangeRef = useRef(onStatusChange);

    useEffect(() => {
        onStatusChangeRef.current = onStatusChange;
    }, [onStatusChange]);

    useEffect(() => {
        if (!videoEl.current) return;
        if (initializedRef.current) return;
        initializedRef.current = true;

        playerRef.current = videojs(videoEl.current, {
            controls: true,
            autoplay: false,
            preload: "auto",
            responsive: true,
            fluid: false,
            liveui: true,
        });

        return () => {
            try {
                playerRef.current?.dispose();
                playerRef.current = null;
            } catch {
                // ignore dispose failures
            }
        };
    }, []);

    useEffect(() => {
        const player = playerRef.current;
        if (!player) return;

        const reportStatus = (status: PlaybackStatus) => {
            if (src) onStatusChangeRef.current?.(src, status);
        };

        if (!src) {
            try {
                player.pause();
            } catch {
                return;
            }
            return;
        }

        const handlePlaying = () => reportStatus("active");
        const handleError = () => reportStatus("inactive");

        player.on("playing", handlePlaying);
        player.on("error", handleError);

        try {
            reportStatus("checking");
            player.src({ src, type: "application/x-mpegURL" });
            void player.play()?.catch(() => undefined);
        } catch {
            reportStatus("inactive");
        }

        return () => {
            player.off("playing", handlePlaying);
            player.off("error", handleError);
        };
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
