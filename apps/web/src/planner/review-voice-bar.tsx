import {
  Loader2Icon,
  MessageCircleIcon,
  MicIcon,
  MicOffIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlannerGoalsStrings } from "./goals-strings";
import type { PlannerVoiceState } from "./review-voice";

// The voice bar that stands in for the answer box while Talk is on (fork,
// docs/fork-review-voice.md). Coral bars are the coach's voice, dark bars are
// yours, flat bars mean nobody is speaking. While you talk, pauses never end
// your turn: the send bubble does.

const BARS = [0.3, 0.7, 1, 0.55, 0.8, 0.4, 0.65, 0.25, 0.5];

export function PlannerReviewVoiceBar({
  state,
  notice,
  level,
  seconds = 0,
  paused = false,
  strings,
  onDone,
  onMic,
  onSkip,
  onRetry,
  onType,
}: {
  state: PlannerVoiceState;
  notice: string | null;
  level: number;
  /** How long you have been talking, while listening. */
  seconds?: number;
  /** While listening: the mic is paused, the turn still open. */
  paused?: boolean;
  strings: PlannerGoalsStrings;
  onDone: () => void;
  /** The mic button: pause or resume recording. */
  onMic?: () => void;
  onSkip: () => void;
  onRetry: () => void;
  onType: () => void;
}) {
  const copy = strings.review.voice;
  const label =
    state === "speaking"
      ? copy.speaking
      : state === "listening"
        ? paused
          ? copy.paused
          : copy.listening
        : state === "hearing"
          ? copy.hearing
          : state === "thinking"
            ? copy.thinking
            : state === "error"
              ? notice === "mic"
                ? copy.noMic
                : copy.failed
              : copy.waiting;
  const moving = state === "speaking" || (state === "listening" && !paused);
  const message =
    state === "error" ? (notice === "mic" ? null : notice) : notice;

  return (
    <div
      className="flex flex-col gap-2.5 p-3"
      data-state={state}
      data-testid="planner-review-voice"
    >
      <div className="flex items-center justify-between gap-2 text-sm font-semibold">
        <span
          aria-live="polite"
          className={cn(
            "flex items-center gap-1.5",
            state === "error" && "text-destructive",
          )}
        >
          {(state === "hearing" || state === "thinking") && (
            <Loader2Icon className="size-3.5 animate-spin" />
          )}
          {label}
        </span>
        {state === "listening" && (
          <span
            className="font-mono text-[13px] font-normal text-muted-foreground tabular-nums"
            data-testid="planner-review-voice-time"
          >
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="flex h-[34px] items-center gap-1">
        {BARS.map((height, index) => {
          const scale =
            state === "listening"
              ? Math.max(0.12, Math.min(1, level * 1.6 * height + 0.1))
              : height;
          return (
            <i
              className={cn(
                "flex-1 rounded-[3px] transition-[height] duration-150",
                state === "speaking"
                  ? "planner-voice-bar bg-brand-500"
                  : state === "listening" && !paused
                    ? "bg-foreground"
                    : "bg-border",
              )}
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative bars
              key={index}
              style={{
                height: moving ? `${Math.round(scale * 100)}%` : "5px",
                animationDelay: `${index * 90}ms`,
              }}
            />
          );
        })}
      </div>
      {state === "listening" && !message && (
        <p className="text-[13px] text-muted-foreground">
          {paused ? copy.pausedHint : copy.listeningHint}
        </p>
      )}
      {message && (
        <p className="text-[13px] text-muted-foreground">{message}</p>
      )}
      <div className="flex gap-2">
        {state === "speaking" && (
          <Button className="flex-1" variant="outline" onClick={onSkip}>
            {copy.skip}
          </Button>
        )}
        {state === "listening" && onMic && (
          <Button
            aria-label={paused ? copy.micResume : copy.micPause}
            aria-pressed={paused}
            className={cn(paused && "border-brand-500 text-brand-500")}
            data-testid="planner-review-voice-mic"
            size="icon"
            title={paused ? copy.micResume : copy.micPause}
            variant="outline"
            onClick={onMic}
          >
            {paused ? <MicOffIcon /> : <MicIcon />}
          </Button>
        )}
        {state === "listening" && (
          <Button
            aria-label={copy.done}
            className="flex-1"
            data-testid="planner-review-voice-done"
            onClick={onDone}
          >
            <MessageCircleIcon />
            {copy.done}
          </Button>
        )}
        {state === "error" && notice !== "mic" && (
          <Button className="flex-1" variant="outline" onClick={onRetry}>
            {copy.again}
          </Button>
        )}
        <Button
          className="flex-1"
          data-testid="planner-review-voice-type"
          variant="outline"
          onClick={onType}
        >
          {copy.type}
        </Button>
      </div>
    </div>
  );
}
