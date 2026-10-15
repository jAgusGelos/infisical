import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { TVerifiedVideoObject } from "@app/hooks/api/pam/web-app-replay";

import { isMseTypeSupported, startMsePlayback } from "./msePlayer";

export type TMseVideoPlayerHandle = {
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => void;
  // ms on the video timeline, 0 = first buffered frame
  seek: (videoMs: number) => void;
  setRate: (rate: number) => void;
  getCurrentTimeMs: () => number;
};

type Props = {
  mime: string;
  objects: TVerifiedVideoObject[];
  onTimeUpdate?: (videoMs: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onReady?: (durationMs: number) => void;
  onError: (message: string) => void;
  className?: string;
};

export const MseVideoPlayer = forwardRef<TMseVideoPlayerHandle, Props>(
  ({ mime, objects, onTimeUpdate, onPlayingChange, onReady, onError, className }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const originRef = useRef(0);
    const callbacks = useRef({ onTimeUpdate, onPlayingChange, onReady, onError });
    callbacks.current = { onTimeUpdate, onPlayingChange, onReady, onError };

    useImperativeHandle(
      ref,
      () => ({
        play: async () => {
          await videoRef.current?.play();
        },
        pause: () => videoRef.current?.pause(),
        toggle: () => {
          const v = videoRef.current;
          if (!v) return;
          if (v.paused) v.play().catch(() => undefined);
          else v.pause();
        },
        seek: (videoMs: number) => {
          const v = videoRef.current;
          if (!v) return;
          v.currentTime = originRef.current + Math.max(0, videoMs) / 1000;
        },
        setRate: (rate: number) => {
          if (videoRef.current) videoRef.current.playbackRate = rate;
        },
        getCurrentTimeMs: () =>
          videoRef.current ? (videoRef.current.currentTime - originRef.current) * 1000 : 0
      }),
      []
    );

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return undefined;
      if (!isMseTypeSupported(mime)) {
        callbacks.current.onError(`This browser cannot play ${mime}`);
        return undefined;
      }
      const playback = startMsePlayback({
        video,
        mime,
        objects,
        onReady: (origin) => {
          originRef.current = origin;
          const end = video.buffered.length
            ? video.buffered.end(video.buffered.length - 1)
            : origin;
          callbacks.current.onReady?.((end - origin) * 1000);
        },
        onError: (message) => callbacks.current.onError(message)
      });
      return () => playback.destroy();
    }, [mime, objects]);

    return (
      <video
        ref={videoRef}
        className={className}
        muted
        playsInline
        onTimeUpdate={(e) =>
          callbacks.current.onTimeUpdate?.((e.currentTarget.currentTime - originRef.current) * 1000)
        }
        onPlay={() => callbacks.current.onPlayingChange?.(true)}
        onPause={() => callbacks.current.onPlayingChange?.(false)}
      />
    );
  }
);

MseVideoPlayer.displayName = "MseVideoPlayer";
