import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBranding } from "@/branding";

const POSITION_KEY_PREFIX = "flaremo-audio-position:";

export type ReadingAudioTrack = {
  id: string;
  filename: string;
  src: string;
  downloadUrl: string;
  sizeBytes: number;
  /** Uploaded duration from the attachment payload; metadata refines it. */
  durationSeconds?: number;
  contentType?: string | null;
};

type ReadingAudioContextValue = {
  track: ReadingAudioTrack | null;
  /** All tracks available in this memo, so the bar can switch between them. */
  tracks: ReadingAudioTrack[];
  selectTrack: (id: string) => void;
  playing: boolean;
  /** True when the audio source failed to load (dead link / removed file). */
  errored: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  follow: boolean;
  toggle: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
  setFollow: (follow: boolean) => void;
  /**
   * Fires on every playback tick. The transcript subscribes here instead of
   * reading `currentTime` from context so a long body is never re-rendered
   * once per second.
   */
  subscribeTime: (listener: (seconds: number) => void) => () => void;
};

const ReadingAudioContext = createContext<ReadingAudioContextValue | null>(
  null,
);

export function useReadingAudio() {
  return useContext(ReadingAudioContext);
}

/** Playback position survives navigation, keyed per attachment. */
export function readSavedPosition(id: string): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(`${POSITION_KEY_PREFIX}${id}`);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Ogg streams without a known trailing granule report `Infinity` here, and the
 * clock formatter would render that as "Infinity:NaN:NaN". An unknown length
 * shows as 0 (the bar then falls back to the position readout) until the
 * element reports a real value.
 */
function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function savePosition(id: string, seconds: number) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      `${POSITION_KEY_PREFIX}${id}`,
      String(Math.floor(seconds)),
    );
  } catch {
    // Storage can be unavailable (private mode, quota); playback still works.
  }
}

export function ReadingAudioProvider({
  children,
  tracks,
}: {
  children: ReactNode;
  tracks: ReadingAudioTrack[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { product } = useBranding();
  // Object refs are detached before passive-effect cleanup runs, so this
  // second ref intentionally survives unmount and lets the last position be
  // saved after React has already cleared audioRef.
  const detachedAudioRef = useRef<HTMLAudioElement | null>(null);
  const trackIdRef = useRef<string | null>(null);
  const listeners = useRef(new Set<(seconds: number) => void>());
  const [activeId, setActiveId] = useState<string | null>(
    tracks[0]?.id ?? null,
  );
  const [playing, setPlaying] = useState(false);
  const [errored, setErrored] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // Seeded from the upload-time duration so the readout is real immediately.
  const [duration, setDuration] = useState(
    finiteDuration(tracks[0]?.durationSeconds ?? 0),
  );
  const [rate, setRateState] = useState(1);
  const [follow, setFollow] = useState(true);

  const track = useMemo(
    () => tracks.find((item) => item.id === activeId) ?? tracks[0] ?? null,
    [tracks, activeId],
  );
  trackIdRef.current = track?.id ?? null;

  const emitTime = useCallback((seconds: number) => {
    for (const listener of listeners.current) listener(seconds);
  }, []);

  const subscribeTime = useCallback((listener: (seconds: number) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // Restore the saved position whenever the active track changes. The element
  // itself is a single node in the DOM, so its source swaps in place. The
  // React state and subscribers are synced too, so the readout and the
  // transcript highlight reflect the restored spot instead of 00:00.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    setDuration(finiteDuration(track.durationSeconds ?? 0));
    const saved = readSavedPosition(track.id);
    const apply = () => {
      if (saved > 0 && audio.duration > saved + 1) {
        audio.currentTime = saved;
        setCurrentTime(saved);
        emitTime(saved);
      }
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener("loadedmetadata", apply, { once: true });
    return () => audio.removeEventListener("loadedmetadata", apply);
  }, [emitTime, track]);

  // Positions are also saved outside explicit pauses: on track switch, on
  // SPA navigation away (unmount) and on tab close (pagehide).
  const selectTrack = useCallback((id: string) => {
    const audio = audioRef.current;
    const outgoing = trackIdRef.current;
    if (audio && outgoing && outgoing !== id && audio.currentTime > 0) {
      savePosition(outgoing, audio.currentTime);
    }
    setErrored(false);
    setActiveId(id);
  }, []);

  useEffect(() => {
    const id = trackIdRef.current;
    return () => {
      const audio = detachedAudioRef.current;
      if (audio && id && audio.currentTime > 0) {
        savePosition(id, audio.currentTime);
      }
    };
    // Unmount-only cleanup: the closure freezes the track that was live when
    // the provider mounted, which is exactly the one to save on the way out.
  }, []);

  useEffect(() => {
    const save = () => {
      const audio = audioRef.current;
      const id = trackIdRef.current;
      if (audio && id && audio.currentTime > 0) {
        savePosition(id, audio.currentTime);
      }
    };
    document.addEventListener("pagehide", save);
    return () => document.removeEventListener("pagehide", save);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = rate;
  }, [rate]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {
        setErrored(true);
        setPlaying(false);
      });
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const target = Math.max(0, Math.min(seconds, audio.duration || seconds));
      audio.currentTime = target;
      setCurrentTime(target);
      emitTime(target);
    },
    [emitTime],
  );

  const setRate = useCallback((next: number) => {
    setRateState(next);
  }, []);

  // OS media session (rollout §5): lock screen / notification controls while
  // the transport is mounted (the provider only mounts alongside the audio
  // bar). Feature-detection guarded; handlers are cleared on unmount so a
  // memo without audio never inherits stale OS controls. No artwork — the
  // manifest icons would mean an extra image fetch per playback.
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || typeof MediaMetadata === "undefined") return;

    mediaSession.metadata = new MediaMetadata({
      title: track?.filename ?? "",
      artist: product,
      album: product,
    });
    mediaSession.playbackState = playing ? "playing" : "paused";

    const safeSet = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported actions throw on some platforms; playback continues.
      }
    };
    safeSet("play", () => {
      const audio = audioRef.current;
      if (audio)
        void audio.play().catch(() => {
          setErrored(true);
          setPlaying(false);
        });
    });
    safeSet("pause", () => {
      audioRef.current?.pause();
    });
    safeSet("seekbackward", (details) => {
      const audio = audioRef.current;
      if (audio)
        seek(Math.max(0, audio.currentTime - (details.seekOffset ?? 10)));
    });
    safeSet("seekforward", (details) => {
      const audio = audioRef.current;
      if (audio) seek(audio.currentTime + (details.seekOffset ?? 10));
    });
    safeSet("seekto", (details) => {
      if (details.seekTime != null) seek(details.seekTime);
    });

    return () => {
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
      const actions = [
        "play",
        "pause",
        "seekbackward",
        "seekforward",
        "seekto",
      ] as const;
      for (const action of actions) safeSet(action, null);
    };
  }, [playing, product, seek, track]);

  // The OS scrubber needs an explicit position state; browsers do not derive
  // it from the media element on their own.
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !Number.isFinite(duration) || duration <= 0) return;
    try {
      mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(Math.max(0, currentTime), duration),
      });
    } catch {
      // Out-of-range states throw on some platforms; playback is unaffected.
    }
  }, [currentTime, duration, rate]);

  const value: ReadingAudioContextValue = {
    errored,
    track,
    tracks,
    selectTrack,
    playing,
    currentTime,
    duration,
    rate,
    follow,
    toggle,
    seek,
    setRate,
    setFollow,
    subscribeTime,
  };

  return (
    <ReadingAudioContext.Provider value={value}>
      {children}
      {track && (
        // biome-ignore lint/a11y/useMediaCaption: user-supplied audio has no caption track.
        <audio
          onDurationChange={(event) =>
            setDuration(finiteDuration(event.currentTarget.duration))
          }
          onEnded={() => setPlaying(false)}
          onError={() => {
            setErrored(true);
            setPlaying(false);
          }}
          onPause={() => {
            setPlaying(false);
            if (track)
              savePosition(track.id, audioRef.current?.currentTime ?? 0);
          }}
          onPlay={() => {
            setErrored(false);
            setPlaying(true);
          }}
          onTimeUpdate={(event) => {
            const seconds = event.currentTarget.currentTime;
            setCurrentTime(seconds);
            emitTime(seconds);
          }}
          preload="metadata"
          ref={(element) => {
            audioRef.current = element;
            if (element) detachedAudioRef.current = element;
          }}
          src={track.src}
        />
      )}
    </ReadingAudioContext.Provider>
  );
}
