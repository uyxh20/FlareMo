import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/api/client";

// The weekly review's voice (fork-owned add-on, docs/fork-review-voice.md).
// Talk turns the answer box into a voice bar: the coach's newest words are
// read out, then the microphone listens, and what was heard goes in as an
// ordinary typed answer. The Worker does the hearing and the speaking on
// Workers AI (apps/worker/src/routes/planner-voice-api.ts); the review's model
// stays the brain. Nothing is recorded or kept.

const VOICE_API = "/api/app/planner/voice";

export type PlannerVoiceMode = "natural" | "basic" | "off";

export function plannerFetchVoiceMode() {
  return apiRequest<{ mode: PlannerVoiceMode }>(VOICE_API);
}

let modeRequest: Promise<PlannerVoiceMode> | null = null;

/**
 * The Worker's voice, asked once per page load: Talk shows only when it is
 * not "off". Until the answer comes, and if the ask fails, it is "off".
 */
export function usePlannerVoiceMode(): PlannerVoiceMode {
  const [mode, setMode] = useState<PlannerVoiceMode>("off");
  useEffect(() => {
    if (typeof fetch === "undefined") return;
    let live = true;
    modeRequest ??= plannerFetchVoiceMode()
      .then((answer) => answer.mode)
      .catch(() => {
        modeRequest = null;
        return "off" as const;
      });
    void modeRequest.then((answer) => {
      if (live) setMode(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  return mode;
}

export async function plannerVoiceTranscribe(clip: Blob) {
  const type = (clip.type || "audio/webm").split(";")[0] ?? "audio/webm";
  return apiRequest<{ text: string; voice: "natural" | "basic" }>(
    `${VOICE_API}/transcribe`,
    { method: "POST", body: clip, headers: { "content-type": type } },
  );
}

export async function plannerVoiceSpeak(text: string, signal?: AbortSignal) {
  const response = await fetch(`${VOICE_API}/speak`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {}
    throw new ApiError(message, response.status);
  }
  return response.blob();
}

export type PlannerVoiceState =
  | "off"
  | "speaking"
  | "listening"
  | "hearing"
  | "thinking"
  | "waiting"
  | "error";

/** Listening ends on its own after this much quiet once you have spoken. */
const SILENCE_MS = 1_800;
/** Speech louder than this (RMS of the signal, 0 to 1) counts as talking. */
const VOICE_LEVEL = 0.03;
/** The longest one answer may run. */
const MAX_LISTEN_MS = 170_000;
function preferredClipType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

/**
 * The voice bar's loop. `lines` is the chat as it should be read out: one
 * entry per chat message, empty for what is not read (your own answers,
 * cards). Turning Talk on reads the newest message; every message that arrives
 * after is read too. Listening starts only when `canAnswer`, and `busy` (the
 * coach writing) shows as thinking.
 */
export function usePlannerReviewVoice({
  lines,
  busy,
  canAnswer,
  onHeard,
  notHeard,
}: {
  lines: readonly string[];
  busy: boolean;
  canAnswer: boolean;
  onHeard: (text: string) => void;
  notHeard: string;
}) {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<PlannerVoiceState>("off");
  const [notice, setNotice] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const props = useRef({ lines, busy, canAnswer, onHeard, notHeard });
  props.current = { lines, busy, canAnswer, onHeard, notHeard };

  const phase = useRef<PlannerVoiceState>("off");
  const spoken = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  const stopSpeaking = useRef<(() => void) | null>(null);
  const timers = useRef<number[]>([]);
  const again = useRef<() => Promise<void>>(async () => {});

  const go = useCallback((next: PlannerVoiceState) => {
    phase.current = next;
    setState(next);
  }, []);

  const stopRecorder = useCallback((keep: boolean) => {
    discard.current = !keep;
    for (const id of timers.current) window.clearInterval(id);
    timers.current = [];
    setLevel(0);
    const active = recorder.current;
    if (active && active.state !== "inactive") active.stop();
  }, []);

  const speak = useCallback(async (text: string) => {
    const controller = new AbortController();
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let halt: () => void = () => {};
    stopSpeaking.current = () => {
      controller.abort();
      halt();
      finish();
    };
    try {
      const clip = await plannerVoiceSpeak(text, controller.signal);
      if (controller.signal.aborted) return;
      const ctx = context.current;
      if (ctx) {
        // Played through the AudioContext the Talk tap unlocked, so a phone
        // lets each later reply play without another tap.
        const buffer = await ctx.decodeAudioData(await clip.arrayBuffer());
        if (controller.signal.aborted) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => finish();
        halt = () => {
          try {
            source.stop();
          } catch {}
        };
        source.start();
        await ended;
        return;
      }
      const element = audio.current ?? new Audio();
      audio.current = element;
      const url = URL.createObjectURL(clip);
      element.onended = () => finish();
      element.onerror = () => finish();
      halt = () => element.pause();
      element.src = url;
      await element.play();
      await ended;
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      stopSpeaking.current = null;
    }
  }, []);

  const listen = useCallback(() => {
    const source = stream.current;
    if (!source || typeof MediaRecorder === "undefined") {
      go("error");
      return;
    }
    const type = preferredClipType();
    const active = type
      ? new MediaRecorder(source, { mimeType: type })
      : new MediaRecorder(source);
    recorder.current = active;
    discard.current = false;
    const chunks: Blob[] = [];
    let spokeAt = 0;
    let quietSince = 0;
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    active.onstop = () => {
      recorder.current = null;
      if (discard.current || phase.current !== "listening") return;
      const clip = new Blob(chunks, {
        type: active.mimeType || type || "audio/webm",
      });
      go("hearing");
      plannerVoiceTranscribe(clip)
        .then(({ text }) => {
          if (phase.current !== "hearing") return;
          if (!text.trim()) {
            setNotice(props.current.notHeard);
            go("listening");
            listen();
            return;
          }
          setNotice(null);
          spoken.current = props.current.lines.length;
          go("thinking");
          props.current.onHeard(text.trim());
          // An answer the coach does not reply to changes nothing the loop
          // watches; look again shortly so listening resumes.
          window.setTimeout(() => void again.current(), 600);
        })
        .catch((error: unknown) => {
          if (phase.current !== "hearing") return;
          setNotice(error instanceof Error ? error.message : String(error));
          go("error");
        });
    };
    go("listening");
    active.start(250);

    // Ends the answer after a quiet spell, once something was said.
    const ctx = context.current;
    if (ctx) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(source).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const started = Date.now();
      const id = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        setLevel(Math.min(1, rms * 8));
        const now = Date.now();
        if (rms > VOICE_LEVEL) {
          spokeAt = now;
          quietSince = 0;
        } else if (spokeAt && !quietSince) {
          quietSince = now;
        }
        if (
          (spokeAt && quietSince && now - quietSince > SILENCE_MS) ||
          now - started > MAX_LISTEN_MS
        ) {
          stopRecorder(true);
        }
      }, 100);
      timers.current.push(id);
    }
  }, [go, stopRecorder]);

  // The loop: read out what is new, then listen when an answer is wanted.
  const advance = useCallback(async () => {
    if (!on) return;
    const now = phase.current;
    if (now === "speaking" || now === "hearing" || now === "error") return;
    if (now === "off") return;
    const { lines: all, busy: writing, canAnswer: open } = props.current;
    if (writing) {
      if (now === "listening") stopRecorder(false);
      go("thinking");
      return;
    }
    if (now === "listening") return;
    const pending = all.slice(spoken.current).filter(Boolean).join(" ");
    spoken.current = all.length;
    if (pending) {
      go("speaking");
      try {
        await speak(pending);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
        go("error");
        return;
      }
      if (phase.current !== "speaking") return;
      go("waiting");
      void advance();
      return;
    }
    if (open) listen();
    else go("waiting");
  }, [on, go, speak, listen, stopRecorder]);
  again.current = advance;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the chat or the stage moves
  useEffect(() => {
    void advance();
  }, [advance, lines.length, busy, canAnswer]);

  const release = useCallback(() => {
    stopSpeaking.current?.();
    stopRecorder(false);
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
  }, [stopRecorder]);

  useEffect(() => release, [release]);

  /** Talk: must run inside the tap, so playback and the mic are allowed. */
  const start = useCallback(async () => {
    setNotice(null);
    try {
      const Context =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Context) {
        context.current = new Context();
        void context.current.resume();
      }
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      release();
      setOn(true);
      go("error");
      setNotice("mic");
      return;
    }
    const all = props.current.lines;
    let last = all.length - 1;
    while (last >= 0 && !all[last]) last--;
    spoken.current = Math.max(0, last);
    phase.current = "waiting";
    setOn(true);
  }, [go, release]);

  const stop = useCallback(() => {
    release();
    setOn(false);
    setNotice(null);
    go("off");
  }, [go, release]);

  /** Done: stop listening and send what was said. */
  const finish = useCallback(() => {
    if (phase.current === "listening") stopRecorder(true);
  }, [stopRecorder]);

  /** Skip: stop reading out and go straight to listening. */
  const skip = useCallback(() => {
    if (phase.current === "speaking") stopSpeaking.current?.();
  }, []);

  /** Try again after a failure. */
  const retry = useCallback(() => {
    setNotice(null);
    if (!stream.current) {
      setOn(false);
      go("off");
      return;
    }
    go("waiting");
    void advance();
  }, [go, advance]);

  return { on, state, notice, level, start, stop, finish, skip, retry };
}
