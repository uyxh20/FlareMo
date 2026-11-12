import {
  type PlannerGoalResult,
  type PlannerReviewResponse,
  plannerGoalResults,
  plannerJoinAnswers,
  plannerReviewPrompts,
  plannerScoreRubric,
  plannerVerdictKinds,
} from "@flaremo/contracts";
import { Loader2Icon, MicIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PlannerPillarLabel, plannerPillarClass } from "./goal-cards";
import {
  plannerGoalText,
  plannerScoreText,
  plannerWeekNumber,
  plannerWeekRange,
} from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import { PlannerChoice } from "./goals-ui";
import { PlannerScoreChart } from "./review-charts";
import {
  type PlannerBackState,
  type PlannerReviewDrafts,
  type PlannerReviewEntry,
  plannerPastStage,
} from "./review-model";
import { usePlannerReviewVoice, usePlannerVoiceMode } from "./review-voice";
import { PlannerReviewVoiceBar } from "./review-voice-bar";
import { usePlannerChatFiles } from "./use-chat-files";

// Look back, the first part of the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): a chat that walks through last week's
// question, last week's goals, the seven prompts, the scores, the question for
// next Sunday and the verdict, with a side panel of the score history and what
// has been answered so far. The page owns the state and the model calls; this
// file only draws them.

/** A file read for the coach, sent with the answer it was dropped on. */
export type PlannerAnswerFile = { filename: string; text: string };

export type PlannerBackActions = {
  start: () => void;
  answer: (text: string, files?: PlannerAnswerFile[]) => void;
  next: () => void;
  goalResult: (goalId: string, result: PlannerGoalResult) => void;
  stepScore: (kind: "auth" | "ach", delta: number) => void;
  keepScores: () => void;
  writeMemo: () => void;
  openMemo: () => void;
  lookForward: () => void;
};

/**
 * What the review adds around the chat: the counts above the start button and
 * what happened under the recap (review-receipts.tsx), for the week and for a
 * month or quarter run through this chat (period-chat.tsx). A period also
 * names itself in place of the week and says the prompts of the period.
 */
export type PlannerLookBackPeriod = {
  /** "October 2026", where the week's number and days would be; the week's by default. */
  label?: string;
  /** "month" or "quarter": the prompts' "this week" becomes "this month". */
  word?: string;
  /** Above the start button: what the review reads. */
  start?: ReactNode;
  /** Under the recap: what happened, with its receipts. */
  recap?: ReactNode;
};

type Props = {
  review: PlannerReviewResponse;
  period?: PlannerLookBackPeriod;
  back: PlannerBackState;
  drafts: PlannerReviewDrafts;
  /** A coach reply is on its way. */
  busy: boolean;
  /** The coach answers in the chat: there is a model and it has not failed. */
  coach: boolean;
  /** The coach's reply so far while it streams, else null. */
  live: string | null;
  /** Look back was saved (the summary memo exists). */
  done: boolean;
  /** The memo is being written. */
  writing: boolean;
  strings: PlannerGoalsStrings;
  actions: PlannerBackActions;
  /** Under the checklist: an optional card. Empty since 2026-11-12, when the
   * flywheel scorecard card (flywheel-card.tsx) was taken off the review. */
  side?: ReactNode;
};

function AiMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-w-[96%] gap-2.5 self-start sm:max-w-[88%]">
      <span
        aria-hidden="true"
        className="mt-px size-[22px] flex-none rounded-[7px] bg-brand-500 dark:bg-brand-400"
      />
      <div className="flex min-w-0 flex-col gap-2.5 leading-normal">
        {children}
      </div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

function Question({ children }: { children: ReactNode }) {
  return <p className="text-base leading-snug font-semibold">{children}</p>;
}

function Options({
  options,
  live,
  onPick,
}: {
  options: readonly string[];
  live: boolean;
  onPick: (option: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option) => (
        <button
          className="block max-w-[560px] cursor-pointer rounded-[10px] border border-border bg-background px-3 py-2 text-left leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/50 enabled:hover:border-brand-500/55 enabled:hover:bg-brand-500/5 disabled:cursor-default disabled:opacity-50"
          data-testid="planner-review-option"
          disabled={!live}
          key={option}
          type="button"
          onClick={() => onPick(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function rubricLine(kind: "auth" | "ach", value: number): string {
  const whole = Math.floor(value) as 1 | 2 | 3 | 4 | 5;
  return `${whole}${value > whole ? "+" : ""} · ${plannerScoreRubric[kind][whole]}`;
}

function ScoreRow({
  kind,
  name,
  value,
  evidence,
  live,
  strings,
  onStep,
}: {
  kind: "auth" | "ach";
  name: string;
  value: number;
  evidence: string;
  live: boolean;
  strings: PlannerGoalsStrings;
  onStep: (delta: number) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[110px_auto_1fr]">
        <span>{name}</span>
        <span className="inline-flex items-center overflow-hidden rounded-[9px] border border-border">
          <button
            aria-label={strings.review.lower(name)}
            className="size-8 cursor-pointer text-base enabled:hover:bg-muted disabled:cursor-default disabled:opacity-50"
            disabled={!live || value <= 1}
            type="button"
            onClick={() => onStep(-0.5)}
          >
            −
          </button>
          <output className="w-[46px] text-center font-mono font-medium tabular-nums">
            {plannerScoreText(value)}
          </output>
          <button
            aria-label={strings.review.raise(name)}
            className="size-8 cursor-pointer text-base enabled:hover:bg-muted disabled:cursor-default disabled:opacity-50"
            disabled={!live || value >= 5}
            type="button"
            onClick={() => onStep(0.5)}
          >
            +
          </button>
        </span>
        <span className="text-[12.5px] leading-snug text-muted-foreground max-sm:col-span-full">
          {rubricLine(kind, value)}
        </span>
      </div>
      {evidence && (
        <p className="-mt-1 mb-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {evidence}
        </p>
      )}
    </>
  );
}

/** The prompt as this review asks it: a period's says "this month". */
function promptQuestion(
  question: string,
  period: PlannerLookBackPeriod | undefined,
) {
  return period?.word
    ? question.replace(/\bthis week\b/g, `this ${period.word}`)
    : question;
}

/**
 * What Talk reads out for a chat message (docs/fork-review-voice.md): the
 * coach's words and each question; nothing for your answers or the cards.
 */
function voiceLine(entry: PlannerReviewEntry, props: Props): string {
  const { review, drafts, strings, period } = props;
  switch (entry.k) {
    case "coach":
      return entry.text;
    case "recap":
      return drafts.recap;
    case "lastq":
      return review.last_question
        ? `${strings.review.lastQuestion}. ${review.last_question}`
        : "";
    case "prompt": {
      const prompt = plannerReviewPrompts[entry.i];
      return prompt ? promptQuestion(prompt.question, period) : "";
    }
    case "question": {
      const { trajectory } = drafts;
      return [
        trajectory.pattern &&
          `${strings.review.pattern}: ${trajectory.pattern}`,
        trajectory.risk && `${strings.review.risk}: ${trajectory.risk}`,
        trajectory.opportunity &&
          `${strings.review.opportunity}: ${trajectory.opportunity}`,
        strings.review.nextQuestion,
      ]
        .filter(Boolean)
        .join(". ");
    }
    case "verdict":
      return strings.review.verdictTitle;
    default:
      return "";
  }
}

function Entry({ entry, props }: { entry: PlannerReviewEntry; props: Props }) {
  const { review, back, drafts, busy, done, writing, strings, actions } = props;
  const { period } = props;
  const reviewWeek = review.review_week;
  switch (entry.k) {
    case "sys":
      return (
        <div className="self-center text-center text-[13px] text-muted-foreground">
          {entry.text}
        </div>
      );
    case "user":
      return (
        <div className="max-w-[96%] self-end rounded-[14px_14px_4px_14px] bg-muted px-3 py-2 leading-normal whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-w-[88%]">
          {entry.text}
        </div>
      );
    case "coach":
      return (
        <AiMessage>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {entry.text}
          </p>
        </AiMessage>
      );
    case "recap":
      return (
        <AiMessage>
          <Label>
            {period?.label ??
              `${strings.week(plannerWeekNumber(reviewWeek))} · ${plannerWeekRange(reviewWeek, strings)}`}
          </Label>
          <p>{drafts.recap}</p>
          {period?.recap}
        </AiMessage>
      );
    case "lastq":
      return (
        <AiMessage>
          <Label>{strings.review.lastQuestion}</Label>
          <Question>{review.last_question}</Question>
          <Options
            live={
              back.stage === "lastq" && !busy && back.lastAnswer.length === 0
            }
            options={drafts.lastq}
            onPick={actions.answer}
          />
        </AiMessage>
      );
    case "goals":
      return (
        <AiMessage>
          <Label>{strings.review.lastGoals}</Label>
          <div className="flex flex-col gap-2">
            {review.week_goals.map((goal) => (
              <div
                className={cn(
                  "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2.5",
                  plannerPillarClass(goal.pillar),
                )}
                key={goal.id}
              >
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  {goal.pillar && (
                    <PlannerPillarLabel
                      pillar={goal.pillar}
                      short
                      strings={strings}
                    />
                  )}
                  <span className="min-w-0 text-sm leading-snug">
                    {plannerGoalText(goal)}
                  </span>
                </div>
                <PlannerChoice
                  disabled={back.stage !== "goals"}
                  label={plannerGoalText(goal)}
                  options={plannerGoalResults.map((result) => ({
                    value: result,
                    label: strings.result[result],
                  }))}
                  value={back.goalResults[goal.id] ?? null}
                  onChange={(result) => actions.goalResult(goal.id, result)}
                />
              </div>
            ))}
          </div>
        </AiMessage>
      );
    case "prompt": {
      const prompt = plannerReviewPrompts[entry.i];
      if (!prompt) return null;
      return (
        <AiMessage>
          <Label>
            {strings.review.promptOf(entry.i + 1, plannerReviewPrompts.length)}
          </Label>
          <Question>{promptQuestion(prompt.question, period)}</Question>
          <Options
            live={
              back.stage === "p" &&
              back.pi === entry.i &&
              !busy &&
              (back.answers[entry.i]?.length ?? 0) === 0
            }
            options={drafts.prompts[entry.i] ?? []}
            onPick={actions.answer}
          />
        </AiMessage>
      );
    }
    case "scores": {
      const live = back.stage === "scores";
      const scores = back.scores ?? {
        auth: drafts.scores.auth,
        ach: drafts.scores.ach,
      };
      return (
        <AiMessage>
          <Label>{strings.review.scoresTitle}</Label>
          <div className="flex max-w-[560px] flex-col gap-2.5 rounded-xl border border-border bg-background px-3.5 py-3">
            <ScoreRow
              evidence={drafts.scores.auth_evidence}
              kind="auth"
              live={live}
              name={strings.goals.authenticity}
              strings={strings}
              value={scores.auth}
              onStep={(delta) => actions.stepScore("auth", delta)}
            />
            <ScoreRow
              evidence={drafts.scores.ach_evidence}
              kind="ach"
              live={live}
              name={strings.goals.achievement}
              strings={strings}
              value={scores.ach}
              onStep={(delta) => actions.stepScore("ach", delta)}
            />
            <div className="flex justify-between gap-2.5 py-0.5 text-[13px]">
              <span>{strings.goals.gap}</span>
              <span className="font-mono tabular-nums">
                {plannerScoreText(Math.abs(scores.auth - scores.ach))}
              </span>
            </div>
          </div>
          {live && (
            <div>
              <Button
                data-testid="planner-keep-scores"
                size="sm"
                onClick={actions.keepScores}
              >
                {strings.review.keepScores}
              </Button>
            </div>
          )}
        </AiMessage>
      );
    }
    case "question": {
      const { trajectory } = drafts;
      const rows = [
        [strings.review.pattern, trajectory.pattern],
        [strings.review.risk, trajectory.risk],
        [strings.review.opportunity, trajectory.opportunity],
      ].filter(([, text]) => text);
      return (
        <AiMessage>
          {rows.length > 0 && (
            <>
              <Label>{strings.review.trajectory}</Label>
              <div className="flex max-w-[560px] flex-col gap-1.5">
                {rows.map(([name, text]) => (
                  <div
                    className="grid gap-x-2.5 leading-snug sm:grid-cols-[96px_1fr]"
                    key={name}
                  >
                    <span className="pt-px text-[12.5px] text-muted-foreground">
                      {name}
                    </span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <Question>{strings.review.nextQuestion}</Question>
          <Options
            live={back.stage === "question" && !busy}
            options={trajectory.questions}
            onPick={actions.answer}
          />
        </AiMessage>
      );
    }
    case "verdict": {
      const { trajectory } = drafts;
      const first = trajectory.recommended ?? "continue";
      const kinds = [
        first,
        ...plannerVerdictKinds.filter((kind) => kind !== first),
      ];
      return (
        <AiMessage>
          <Label>{strings.review.verdictTitle}</Label>
          <Options
            live={back.stage === "verdict" && !busy}
            options={kinds
              .map((kind) => trajectory.verdicts[kind])
              .filter(Boolean)}
            onPick={actions.answer}
          />
        </AiMessage>
      );
    }
    case "done":
      return (
        <AiMessage>
          <Label>{strings.review.summaryTitle}</Label>
          <div className="flex flex-wrap gap-2">
            {done || back.memo ? (
              <>
                <Button variant="outline" onClick={actions.openMemo}>
                  {strings.review.openSummary}
                </Button>
                <Button
                  data-testid="planner-to-forward"
                  onClick={actions.lookForward}
                >
                  {strings.review.toLookForward}
                </Button>
              </>
            ) : (
              <Button
                data-testid="planner-write-summary"
                disabled={writing}
                onClick={actions.writeMemo}
              >
                {strings.review.writeSummary}
              </Button>
            )}
          </div>
        </AiMessage>
      );
    default:
      return null;
  }
}

function Thinking({ children }: { children: ReactNode }) {
  return (
    <AiMessage>
      <span className="planner-thinking text-[13px] text-muted-foreground">
        {children}
      </span>
    </AiMessage>
  );
}

/**
 * The answer box. With `attach` on (the coach replies to this answer), files
 * can be dropped, pasted or picked: each is read at once into text, shown as
 * a line above the box, and goes with the next answer (fork, "Files in the
 * review", docs/fork-task-attachments.md). The files are not kept.
 */
function Composer({
  disabled,
  attach,
  strings,
  onSend,
  voice,
  upload,
}: {
  disabled: boolean;
  attach: boolean;
  strings: PlannerGoalsStrings;
  onSend: (text: string, files: PlannerAnswerFile[]) => void;
  /** The Upload button beside Send: in view whenever the chat is. */
  upload: boolean;
  /** Talk (docs/fork-review-voice.md): what to read out, and whether voice is on. */
  voice: { available: boolean; lines: readonly string[]; busy: boolean };
}) {
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const copy = strings.review.files;
  const files = usePlannerChatFiles({
    tooLarge: copy.tooLarge,
    tooMany: copy.tooMany,
  });
  const { clear } = files;
  const talk = usePlannerReviewVoice({
    lines: voice.lines,
    busy: voice.busy,
    canAnswer: !disabled,
    notHeard: strings.review.voice.notHeard,
    onHeard: (heard) => onSend(heard, []),
  });

  // Files wait for an answer the coach replies to; a step without one drops them.
  useEffect(() => {
    if (!attach) clear();
  }, [attach, clear]);

  // Grows with what is written, up to a few lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it measures the text
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight + 2, 160)}px`;
  }, [text]);

  // After each step the answer box takes the focus again on a desktop, so the
  // review can be done from the keyboard; a phone keeps its keyboard down.
  useEffect(() => {
    if (disabled) return;
    if (!window.matchMedia?.("(hover: hover)").matches) return;
    area.current?.focus({ preventScroll: true });
  }, [disabled]);

  const attached = attach ? files.ready : [];
  const canSend =
    !disabled &&
    !files.reading &&
    (text.trim().length > 0 || attached.length > 0);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(text, attached);
    setText("");
    clear();
  };

  const add = (list: readonly File[]) => {
    if (attach && list.length > 0) files.add(list);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!attach) return;
    event.preventDefault();
    setOver(false);
    add(Array.from(event.dataTransfer?.files ?? []));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(event.clipboardData?.files ?? []);
    if (!attach || list.length === 0) return;
    event.preventDefault();
    add(list);
  };

  if (talk.on) {
    return (
      <div className="border-t border-border">
        <PlannerReviewVoiceBar
          level={talk.level}
          notice={talk.notice}
          paused={talk.paused}
          seconds={talk.seconds}
          state={talk.state}
          strings={strings}
          onDone={talk.finish}
          onMic={talk.toggleMic}
          onRetry={talk.retry}
          onSkip={talk.skip}
          onType={talk.stop}
        />
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target around the answer box; the box and the paperclip are the controls
    <div
      className="border-t border-border"
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        if (!attach) return;
        event.preventDefault();
        setOver(true);
      }}
      onDrop={onDrop}
    >
      {attach && (files.files.length > 0 || files.notice) && (
        <ul
          className="flex flex-col gap-1 px-3 pt-2 text-[13px] text-muted-foreground"
          data-testid="planner-review-files"
        >
          {files.files.length > 0 && (
            <li className="font-medium">{copy.withAnswer}</li>
          )}
          {files.files.map((entry) => (
            <li className="flex items-center gap-1.5" key={entry.key}>
              {entry.state === "reading" && (
                <Loader2Icon className="size-3 shrink-0 animate-spin" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {entry.filename} ·{" "}
                {entry.state === "reading"
                  ? copy.reading
                  : entry.state === "ready"
                    ? copy.ready
                    : copy.unreadable}
              </span>
              <Button
                aria-label={copy.remove}
                size="icon-xs"
                title={copy.remove}
                type="button"
                variant="ghost"
                onClick={() => files.remove(entry.key)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
          {files.notice && <li className="text-destructive">{files.notice}</li>}
        </ul>
      )}
      <form
        className={cn("flex items-end gap-2 p-2.5", over && "bg-muted/60")}
        onSubmit={submit}
      >
        <textarea
          aria-label={strings.review.answer}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-[10px] border border-border bg-background px-3 py-2 leading-snug outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-60"
          data-testid="planner-review-composer"
          disabled={disabled}
          maxLength={4000}
          placeholder={over ? copy.drop : strings.review.answerPlaceholder}
          ref={area}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {upload && (
          <>
            <input
              className="sr-only"
              data-testid="planner-review-file-input"
              multiple
              ref={picker}
              tabIndex={-1}
              type="file"
              onChange={(event) => {
                const list = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                add(list);
              }}
            />
            <Button
              aria-label={attach ? copy.attach : copy.uploadNotHere}
              data-testid="planner-review-upload"
              disabled={disabled || !attach}
              size="sm"
              title={attach ? copy.attach : copy.uploadNotHere}
              type="button"
              variant="outline"
              onClick={() => picker.current?.click()}
            >
              <PaperclipIcon />
              <span>{copy.upload}</span>
            </Button>
          </>
        )}
        {voice.available && (
          <Button
            aria-label={strings.review.voice.talk}
            data-testid="planner-review-talk"
            size="sm"
            title={strings.review.voice.talk}
            type="button"
            variant="outline"
            onClick={() => void talk.start()}
          >
            <MicIcon />
            <span className="max-sm:sr-only">{strings.review.voice.talk}</span>
          </Button>
        )}
        <Button disabled={!canSend} size="sm" type="submit">
          {strings.review.send}
        </Button>
      </form>
    </div>
  );
}

function Panel(props: Props) {
  const { review, back, done, writing, strings, actions } = props;
  const scores = review.scores;
  const first = scores[0];
  const last = scores.at(-1);
  const code = (week: string | undefined) =>
    week ? strings.weekCode(plannerWeekNumber(week)) : "";
  const results = review.week_goals
    .map((goal) => back.goalResults[goal.id])
    .filter((result): result is PlannerGoalResult => Boolean(result));
  const items: Array<[string, string]> = [];
  if (review.last_question) {
    items.push([
      strings.review.lastQuestionItem,
      plannerJoinAnswers(back.lastAnswer),
    ]);
  }
  if (review.week_goals.length > 0) {
    items.push([
      strings.review.lastGoalsItem,
      plannerPastStage(back, "goals")
        ? plannerGoalResults
            .map((result) => {
              const count = results.filter((item) => item === result).length;
              return count ? `${count} ${strings.result[result]}` : "";
            })
            .filter(Boolean)
            .join(" · ")
        : "",
    ]);
  }
  plannerReviewPrompts.forEach((prompt, index) => {
    items.push([prompt.label, plannerJoinAnswers(back.answers[index] ?? [])]);
  });
  items.push([
    strings.review.scoresItem,
    plannerPastStage(back, "scores") && back.scores
      ? strings.goals.scores(
          plannerScoreText(back.scores.auth),
          plannerScoreText(back.scores.ach),
        )
      : "",
  ]);
  items.push([strings.review.nextQuestionItem, back.question ?? ""]);
  items.push([strings.review.verdictItem, back.verdict?.text ?? ""]);
  const canWrite = back.stage === "done";
  const hasMemo = done || Boolean(back.memo);

  return (
    <aside className="flex flex-col gap-3 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start">
      <section className="rounded-xl border border-border bg-card px-4 py-3.5">
        <h3 className="mb-2.5 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {strings.review.chartsTitle(
            code(first?.week_start),
            code(last?.week_start),
          )}
        </h3>
        <div className="flex flex-col gap-4">
          <PlannerScoreChart kind="auth" strings={strings} weeks={scores} />
          <PlannerScoreChart kind="ach" strings={strings} weeks={scores} />
        </div>
      </section>
      <section className="rounded-xl border border-border bg-card px-4 py-3.5">
        <h3 className="mb-2.5 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {strings.review.panelChecklist}
        </h3>
        <ul
          className="flex flex-col gap-2"
          data-testid="planner-review-checklist"
        >
          {items.map(([name, answer]) => (
            <li
              className="grid grid-cols-[18px_1fr] gap-2 text-[13px] leading-snug"
              key={name}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "font-mono",
                  answer ? "text-success" : "text-muted-foreground/60",
                )}
              >
                {answer ? "✓" : "○"}
              </span>
              <div className="min-w-0">
                <div className="text-muted-foreground">{name}</div>
                {answer && (
                  <div className="line-clamp-2 text-foreground">{answer}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
        <Button
          className="mt-3.5 w-full"
          disabled={!canWrite && !hasMemo}
          variant={canWrite && !hasMemo ? "default" : "outline"}
          onClick={hasMemo ? actions.openMemo : actions.writeMemo}
        >
          {hasMemo
            ? strings.review.openSummary
            : writing
              ? strings.review.memo.writing
              : strings.review.writeSummary}
        </Button>
      </section>
      {props.side}
    </aside>
  );
}

export function PlannerLookBack(props: Props) {
  const { review, back, busy, coach, live, done, strings, actions } = props;
  const messages = useRef<HTMLDivElement | null>(null);
  const stage = back.stage;
  // Talk shows only where the Worker has a voice (FLAREMO_REVIEW_VOICE).
  const voiceMode = usePlannerVoiceMode();
  const voiceLines = back.log.map((entry) => voiceLine(entry, props));

  // The newest message stays in view as the chat grows or a reply streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on new content
  useEffect(() => {
    const node = messages.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [back.log.length, live, busy, stage]);

  const composerOff =
    busy ||
    stage === "start" ||
    stage === "drafting" ||
    stage === "scoring" ||
    stage === "goals" ||
    ((stage === "scores" || stage === "done") && !coach);
  const current =
    stage === "lastq"
      ? back.lastAnswer
      : stage === "p"
        ? (back.answers[back.pi] ?? [])
        : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section
        aria-label={strings.review.lookBack}
        className="flex h-[calc(100dvh-200px)] min-h-[440px] flex-col rounded-xl border border-border bg-card lg:h-[calc(100dvh-210px)] lg:min-h-[520px]"
      >
        <div
          aria-live="polite"
          className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 pt-4 pb-2 text-sm sm:px-4.5"
          data-testid="planner-review-chat"
          ref={messages}
        >
          {stage === "start" ? (
            <div className="m-auto flex flex-col items-center gap-3 text-center">
              <span className="font-mono text-[13px] text-muted-foreground tabular-nums">
                {props.period?.label ??
                  `${strings.week(plannerWeekNumber(review.review_week))} · ${plannerWeekRange(review.review_week, strings)}`}
              </span>
              {props.period?.start}
              {done ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={actions.openMemo}>
                    {strings.review.openSummary}
                  </Button>
                  <Button onClick={actions.lookForward}>
                    {strings.review.toLookForward}
                  </Button>
                </div>
              ) : (
                <Button
                  data-testid="planner-start-look-back"
                  onClick={actions.start}
                >
                  {strings.review.start}
                </Button>
              )}
            </div>
          ) : (
            <>
              {back.log.map((entry, index) => (
                // The chat only grows; an entry's place is its identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
                <Entry entry={entry} key={index} props={props} />
              ))}
              {stage === "drafting" && (
                <Thinking>
                  {back.agent
                    ? strings.review.draftingAgent
                    : strings.review.drafting}
                </Thinking>
              )}
              {stage === "scoring" && (
                <Thinking>{strings.review.scoring}</Thinking>
              )}
              {busy &&
                (live ? (
                  <AiMessage>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {live}
                    </p>
                  </AiMessage>
                ) : (
                  <Thinking>{strings.review.thinking}</Thinking>
                ))}
              {!busy && (current !== null || stage === "goals") && (
                <button
                  className="cursor-pointer self-start text-[13px] text-muted-foreground underline underline-offset-[3px] hover:text-foreground"
                  data-testid="planner-review-next"
                  type="button"
                  onClick={actions.next}
                >
                  {current && current.length === 0
                    ? strings.review.skip
                    : strings.review.next}
                </button>
              )}
            </>
          )}
        </div>
        <Composer
          attach={
            coach &&
            (stage === "lastq" ||
              stage === "p" ||
              stage === "scores" ||
              stage === "done")
          }
          disabled={composerOff}
          strings={strings}
          upload={stage !== "start"}
          voice={{
            available: stage !== "start" && voiceMode !== "off",
            busy,
            lines: voiceLines,
          }}
          onSend={actions.answer}
        />
      </section>
      <Panel {...props} />
    </div>
  );
}
