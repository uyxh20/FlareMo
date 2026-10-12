import {
  type PlannerGoalResult,
  type PlannerReviewResponse,
  plannerGoalResults,
  plannerJoinAnswers,
  plannerReviewPrompts,
  plannerScoreRubric,
  plannerVerdictKinds,
} from "@flaremo/contracts";
import {
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

// Look back, the first part of the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): a chat that walks through last week's
// question, last week's goals, the seven prompts, the scores, the question for
// next Sunday and the verdict, with a side panel of the score history and what
// has been answered so far. The page owns the state and the model calls; this
// file only draws them.

export type PlannerBackActions = {
  start: () => void;
  answer: (text: string) => void;
  next: () => void;
  goalResult: (goalId: string, result: PlannerGoalResult) => void;
  stepScore: (kind: "auth" | "ach", delta: number) => void;
  keepScores: () => void;
  writeMemo: () => void;
  openMemo: () => void;
  lookForward: () => void;
};

type Props = {
  review: PlannerReviewResponse;
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

function Entry({ entry, props }: { entry: PlannerReviewEntry; props: Props }) {
  const { review, back, drafts, busy, done, writing, strings, actions } = props;
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
            {strings.week(plannerWeekNumber(reviewWeek))} ·{" "}
            {plannerWeekRange(reviewWeek, strings)}
          </Label>
          <p>{drafts.recap}</p>
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
          <Question>{prompt.question}</Question>
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

function Composer({
  disabled,
  strings,
  onSend,
}: {
  disabled: boolean;
  strings: PlannerGoalsStrings;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement | null>(null);

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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || !text.trim()) return;
    onSend(text);
    setText("");
  };

  return (
    <form
      className="flex items-end gap-2 border-t border-border p-2.5"
      onSubmit={submit}
    >
      <textarea
        aria-label={strings.review.answer}
        className="max-h-40 min-h-10 flex-1 resize-none rounded-[10px] border border-border bg-background px-3 py-2 leading-snug outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-60"
        data-testid="planner-review-composer"
        disabled={disabled}
        maxLength={4000}
        placeholder={strings.review.answerPlaceholder}
        ref={area}
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
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
      <Button disabled={disabled || !text.trim()} size="sm" type="submit">
        {strings.review.send}
      </Button>
    </form>
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
    </aside>
  );
}

export function PlannerLookBack(props: Props) {
  const { review, back, busy, coach, live, done, strings, actions } = props;
  const messages = useRef<HTMLDivElement | null>(null);
  const stage = back.stage;

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
                {strings.week(plannerWeekNumber(review.review_week))} ·{" "}
                {plannerWeekRange(review.review_week, strings)}
              </span>
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
                <Thinking>{strings.review.drafting}</Thinking>
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
          disabled={composerOff}
          strings={strings}
          onSend={actions.answer}
        />
      </section>
      <Panel {...props} />
    </div>
  );
}
