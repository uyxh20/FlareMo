import {
  type PlannerGoalDto,
  type PlannerPeriodHappened,
  type PlannerPeriodLevel,
  type PlannerPeriodReviewResponse,
  type PlannerReviewResponse,
  type PlannerSavePeriodInput,
  type PlannerWeekDto,
  plannerFormatScore,
  plannerGoalLevels,
  plannerGoalStatuses,
  plannerPillarNames,
  plannerPillars,
  plannerReviewPrompts,
  plannerSnapScore,
} from "@flaremo/contracts";
import { plannerGoalText } from "./goals-model";
import {
  type PlannerBackState,
  type PlannerReviewDrafts,
  type PlannerReviewState,
  plannerDraftsOf,
  plannerGoalResultsInput,
  plannerRestoreReviewState,
} from "./review-model";

// The month and quarter reviews as the weekly review's Look back chat
// (fork-owned add-on, docs/planning-cockpit-period-review.md). Pure parts:
// the period's review read as a week's (so review-back.tsx and review-model.ts
// run it unchanged), what the review reads, the saved state with what
// happened, the page's own memo when no model writes one, and the save.

/** The period chat's routes, which answer the weekly review's AI requests. */
export function plannerPeriodChatBase(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  return `/api/app/planner/period-review/${encodeURIComponent(level)}/${encodeURIComponent(periodStart)}/chat`;
}

const GOAL_LEVELS: readonly string[] = plannerGoalLevels;
const GOAL_STATUSES: readonly string[] = plannerGoalStatuses;

function goalDto(
  goal: PlannerPeriodReviewResponse["goals"][number],
): PlannerGoalDto {
  return {
    id: goal.id,
    level: (GOAL_LEVELS.includes(goal.level)
      ? goal.level
      : "month") as PlannerGoalDto["level"],
    period_start: goal.period_start,
    pillar: goal.pillar,
    title: goal.title,
    lines: goal.lines,
    status: (GOAL_STATUSES.includes(goal.status)
      ? goal.status
      : "active") as PlannerGoalDto["status"],
    note: goal.note,
    result: goal.result,
    sort_order: 0,
    created_at: "",
    updated_at: "",
  };
}

/** The mean of the period's weekly scores, on the half-step scale, or null. */
function meanScores(
  weeks: PlannerPeriodReviewResponse["weeks"],
): { auth: number; ach: number } | null {
  const scored = weeks.filter(
    (week): week is typeof week & { auth: number; ach: number } =>
      week.auth !== null && week.ach !== null,
  );
  if (scored.length === 0) return null;
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const auth = plannerSnapScore(
    Math.round(mean(scored.map((week) => week.auth)) * 2) / 2,
  );
  const ach = plannerSnapScore(
    Math.round(mean(scored.map((week) => week.ach)) * 2) / 2,
  );
  return auth === null || ach === null ? null : { auth, ach };
}

/**
 * The period's review as the weekly chat reads a week's: its goals are the
 * week's goals, its key question is the one the last period's chat left, its
 * weeks' scores are the score history, and the scores start from their mean.
 */
export function plannerPeriodChatReview(
  period: PlannerPeriodReviewResponse,
  today: string,
): PlannerReviewResponse {
  const first = period.weeks[0]?.week_start ?? period.period_start;
  const last = period.weeks.at(-1)?.week_start ?? period.period_start;
  const mean = meanScores(period.weeks);
  const week: PlannerWeekDto | null = mean
    ? {
        week_start: last,
        auth: mean.auth,
        ach: mean.ach,
        note: null,
        question: null,
        verdict: null,
        memo_id: null,
        source: "review",
        reviewed_at: null,
      }
    : null;
  return {
    today,
    review_week: first,
    plan_week: last,
    state: period.state,
    look_back_done_at: period.done_at,
    look_forward_done_at: null,
    // The period chat shows its own counts (plannerPeriodStats).
    reads: { entries: 0, health_rows: 0, tasks_done: 0, goals: 0 },
    last_question: period.previous?.question ?? null,
    week_goals: period.goals.map(goalDto),
    plan_goals: [],
    flags: [],
    flag_goals: [],
    scores: period.weeks.map((entry) => ({
      week_start: entry.week_start,
      auth: entry.auth,
      ach: entry.ach,
    })),
    week,
    summary: period.memo,
    suggested_goals: {},
    ai: period.ai,
  };
}

/** What the review reads, counted from the period's weeks. */
export function plannerPeriodStats(period: PlannerPeriodReviewResponse): {
  entries: number;
  memos: number;
  tasksDone: number;
  goals: number;
} {
  return {
    entries: period.weeks.reduce((sum, week) => sum + week.entries, 0),
    memos: period.weeks.filter((week) => week.memo_id).length,
    tasksDone: period.weeks.reduce((sum, week) => sum + week.tasks_done, 0),
    goals: period.goals.length,
  };
}

// ---------------------------------------------------------------------------
// Saved state
// ---------------------------------------------------------------------------

/** The weekly chat's state, plus what happened and the model's memo draft. */
export type PlannerPeriodChatState = PlannerReviewState & {
  /** What happened, each claim backed by the owner's words; null before the opening. */
  happened: PlannerPeriodHappened[] | null;
  /** Claims the model made that its words could not back. */
  dropped: number;
  /** The model's memo as it wrote it, for the rewrite rate. */
  draftMemo: string | null;
};

const SOURCES = ["memo", "health", "task_event", "week"];

/** The saved "what happened" list, or null where it is not one. */
export function plannerRestoreHappened(
  value: unknown,
): PlannerPeriodHappened[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.claim !== "string" ||
      typeof entry.quote !== "string" ||
      typeof entry.source_id !== "string" ||
      typeof entry.source_day !== "string" ||
      !SOURCES.includes(entry.source as string)
    ) {
      return [];
    }
    const pillar = plannerPillars.find((value) => value === entry.pillar);
    return [
      {
        pillar: pillar ?? null,
        claim: entry.claim,
        quote: entry.quote,
        source: entry.source as PlannerPeriodHappened["source"],
        source_id: entry.source_id,
        source_day: entry.source_day,
      },
    ];
  });
}

/**
 * The state the page saved last time. A review saved before the chat (the
 * step-by-step page) starts the chat fresh; its saved memo and receipts stay.
 */
export function plannerRestorePeriodChat(
  saved: unknown,
  review: PlannerReviewResponse,
): PlannerPeriodChatState {
  const base = plannerRestoreReviewState(saved, review);
  const record =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  return {
    ...base,
    happened:
      base.back.stage === "start"
        ? null
        : plannerRestoreHappened(record.happened),
    dropped:
      typeof record.dropped === "number" && record.dropped >= 0
        ? Math.floor(record.dropped)
        : 0,
    draftMemo: typeof record.draftMemo === "string" ? record.draftMemo : null,
  };
}

// ---------------------------------------------------------------------------
// The memo and the save
// ---------------------------------------------------------------------------

const RESULT_WORDS = { met: "met", partial: "partly met", missed: "missed" };

/** The page's own memo, when no model writes one: the answers as given. */
export function plannerPeriodChatTemplate(input: {
  period: PlannerPeriodReviewResponse;
  back: PlannerBackState;
  review: PlannerReviewResponse;
  happened: readonly PlannerPeriodHappened[];
  today: string;
}): string {
  const { period, back, review, happened } = input;
  const word = period.level;
  const kind = word[0]?.toUpperCase() + word.slice(1);
  const drafts: PlannerReviewDrafts = plannerDraftsOf(back, review);
  const scores = back.scores ?? {
    auth: drafts.scores.auth,
    ach: drafts.scores.ach,
  };
  const said = (list: readonly string[]) =>
    list.length ? list.join(" ") : "Skipped.";
  const lines = [
    `# ${kind} review: ${period.label}`,
    "",
    "## Review status and sources",
    "",
    `Created in the ${word} review on ${input.today}, over ${period.weeks.length} weeks (${period.period_start} to ${period.period_end}). Written from the answers, with no model.`,
    "",
    "## 1. What happened",
    "",
    ...(happened.length
      ? happened.map(
          (entry) => `- ${entry.claim} "${entry.quote}" (${entry.source_day})`,
        )
      : ["None stated."]),
    ...(review.last_question
      ? [
          "",
          `**Last ${word}'s question:** ${review.last_question}`,
          "",
          said(back.lastAnswer),
        ]
      : []),
    "",
    "## 2. Guided Reflection Prompts",
    "",
    ...plannerReviewPrompts.map(
      (prompt, index) =>
        `- **${prompt.label}:** ${said(back.answers[index] ?? [])}`,
    ),
    "",
    "## 3. Goal Progress Update",
    "",
    ...(review.week_goals.length
      ? review.week_goals.map((goal) => {
          const result = back.goalResults[goal.id];
          const pillar = goal.pillar
            ? `${plannerPillarNames[goal.pillar]}: `
            : "";
          return `- ${pillar}${plannerGoalText(goal)} — ${result ? RESULT_WORDS[result] : "not judged"}`;
        })
      : ["None stated."]),
    "",
    "| | Score | Basis |",
    "| --- | --- | --- |",
    `| Authenticity | ${plannerFormatScore(scores.auth)} | ${drafts.scores.auth_evidence || "—"} |`,
    `| Achievement | ${plannerFormatScore(scores.ach)} | ${drafts.scores.ach_evidence || "—"} |`,
    `| Gap | ${plannerFormatScore(Math.abs(scores.auth - scores.ach))} | |`,
    "",
    `## Trajectory into next ${word}`,
    "",
    `**Key question for next ${word}:** ${back.question?.trim() || "—"}`,
    "",
    `**Verdict:** ${back.verdict?.text.trim() || "—"}`,
    "",
    `_${period.level} review · ${period.period_start}_`,
  ];
  return lines.join("\n");
}

/** The save: the memo, the verdict, the goals' results and what happened. */
export function plannerPeriodChatSaveInput(input: {
  state: PlannerPeriodChatState;
  review: PlannerReviewResponse;
  today: string;
  memo: string;
}): PlannerSavePeriodInput {
  const { state, review } = input;
  const back = state.back;
  return {
    today: input.today,
    memo: input.memo.trim().slice(0, 60_000),
    draft_memo:
      back.memoBy === "model" && state.draftMemo
        ? state.draftMemo.slice(0, 60_000)
        : null,
    verdict: back.verdict?.text.trim()
      ? {
          kind: back.verdict.kind,
          text: back.verdict.text.trim().slice(0, 2000),
        }
      : null,
    forecast: null,
    previous_grade: null,
    goal_results: plannerGoalResultsInput(back, review).map((entry) => ({
      ...entry,
      decision: null,
      note: null,
    })),
    evidence: (state.happened ?? []).slice(0, 200).map((entry) => ({
      pillar: entry.pillar,
      claim: entry.claim.slice(0, 600),
      quote: entry.quote.slice(0, 600),
    })),
  };
}
