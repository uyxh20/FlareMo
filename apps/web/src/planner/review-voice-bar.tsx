import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlannerGoalsStrings } from "./goals-strings";
import type { PlannerVoiceState } from "./review-voice";

// The voice bar that stands in for the answer box while Talk is on (fork,
// docs/fork-review-voice.md). Coral bars are the coach's voice, dark bars are
// yours, flat bars mean nobody is speaking.

const BARS = [0.3, 0.7, 1, 0.55, 0.8, 0.4, 0.65, 0.25, 0.5];

export function PlannerReviewVoiceBar({
  state,
  notice,
  level,
  strings,
  onDone,
  onSkip,
  onRetry,
  onType,
}: {
  state: PlannerVoiceState;
  notice: string | null;
  level: number;
  strings: PlannerGoalsStrings;
  onDone: () => void;
  onSkip: () => void;
  onRetry: () => void;
  onType: () => void;
}) {
  const copy = strings.review.voice;
  const label =
    state === "speaking"
      ? copy.speaking
      : state === "listening"
        ? copy.listening
        : state === "hearing"
          ? copy.hearing
          : state === "thinking"
            ? copy.thinking
            : state === "error"
              ? notice === "mic"
                ? copy.noMic
                : copy.failed
              : copy.waiting;
  const moving = state === "speaking" || state === "listening";
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
                  : state === "listening"
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
      {message && (
        <p className="text-[13px] text-muted-foreground">{message}</p>
      )}
      <div className="flex gap-2">
        {state === "speaking" && (
          <Button className="flex-1" variant="outline" onClick={onSkip}>
            {copy.skip}
          </Button>
        )}
        {state === "listening" && (
          <Button
            className="flex-1"
            data-testid="planner-review-voice-done"
            onClick={onDone}
          >
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
