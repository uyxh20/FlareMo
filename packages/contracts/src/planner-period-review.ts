import { z } from "zod";
import {
  type PlannerGoalResult,
  type PlannerPillar,
  plannerAddDays,
  plannerGoalResultSchema,
  plannerIsDay,
  plannerPillarSchema,
  plannerQuarterStartOf,
  plannerReviewDueDay,
  plannerReviewWeekFor,
  plannerVerdictKindSchema,
  plannerWeekMonthOf,
  plannerWeekStartOf,
} from "./planner-goals";

// The month, quarter and year reviews (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the "superset" that runs after a
// weekly review's Look back on the Sunday a month, a quarter or a year closes,
// and before its Look forward. Period maths, the steps of each level, the
// request and response shapes. The weekly review's own contracts are in
// planner-goals.ts; this file adds to them and borrows their day maths.
//
// A week belongs to the month of its Thursday (plannerWeekMonthOf, the Year
// map's rule), so a period's weeks are whole ISO weeks and a period closes on
// the Sunday of its last week. A quarter's weeks are its three months' weeks;
// a year's are the ISO year's.
//
// Routes (planner-period-review-api.ts, mounted under /api/app/planner):
//   GET    /period-review?today&level?&period?     the review as the page reads it
//   GET    /period-review/status?today             what is due this Sunday
//   PATCH  /period-review/:level/:period/state     the page's progress
//   POST   /period-review/:level/:period/start-over
//   POST   /period-review/:level/:period/save      memo, verdict, forecast, goal results, evidence
//   POST   /period-review/:level/:period/ai/checks the summaries against the diary (JSON)
//   POST   /period-review/:level/:period/ai/themes two readers over the diary (JSON)
//   POST   /period-review/:level/:period/ai/coach  one step's reply (NDJSON)
//   POST   /period-review/:level/:period/ai/memo   the memo (NDJSON)

export const plannerPeriodLevels = ["month", "quarter", "year"] as const;
export type PlannerPeriodLevel = (typeof plannerPeriodLevels)[number];

/** The tag the memo of a period review carries, next to the weekly summaries. */
export const plannerPeriodMemoTag = "vault-summary";
/** The memo `source` of a period review's memo. */
export const plannerPeriodMemoSource = "period-review";

/** One memo per reviewed period, found again by this client id. */
export function plannerPeriodMemoClientId(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  return `period-review-summary:${level}:${periodStart}`;
}

// ---------------------------------------------------------------------------
// Period maths
// ---------------------------------------------------------------------------

function requireDay(day: string): string {
  if (!plannerIsDay(day)) throw new RangeError(`Not a day: ${day}`);
  return day;
}

/** The first day of the period of `level` that holds `day`. */
export function plannerPeriodStartOf(
  level: PlannerPeriodLevel,
  day: string,
): string {
  requireDay(day);
  if (level === "month") return `${day.slice(0, 7)}-01`;
  if (level === "quarter") return plannerQuarterStartOf(day);
  return `${day.slice(0, 4)}-01-01`;
}

/** The last day of the period that starts on `periodStart`. */
export function plannerPeriodEndOf(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  return plannerAddDays(plannerNextPeriodStartOf(level, periodStart), -1);
}

/** The first day of the next period. */
export function plannerNextPeriodStartOf(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  requireDay(periodStart);
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const months = level === "month" ? 1 : level === "quarter" ? 3 : 12;
  const next = month + months;
  const nextYear = year + Math.floor((next - 1) / 12);
  const nextMonth = ((next - 1) % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

/** The first day of the period before. */
export function plannerPreviousPeriodStartOf(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  requireDay(periodStart);
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const months = level === "month" ? 1 : level === "quarter" ? 3 : 12;
  const previous = month - months;
  const previousYear = year + Math.floor((previous - 1) / 12);
  const previousMonth = ((((previous - 1) % 12) + 12) % 12) + 1;
  return `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
}

/** The period of `level` a week belongs to: the period of its Thursday. */
export function plannerPeriodOfWeek(
  level: PlannerPeriodLevel,
  weekStart: string,
): string {
  const thursday = plannerAddDays(plannerWeekStartOf(weekStart), 3);
  return plannerPeriodStartOf(level, thursday);
}

/** `periodStart` is the first day of a period of `level`. */
export function plannerIsPeriodStart(
  level: PlannerPeriodLevel,
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    plannerIsDay(value) &&
    plannerPeriodStartOf(level, value) === value
  );
}

/**
 * The Mondays of the period's weeks: every ISO week whose Thursday falls in
 * the period, first week first. A month has four or five, a quarter thirteen
 * (sometimes fourteen), a year fifty-two or fifty-three.
 */
export function plannerPeriodWeeks(
  level: PlannerPeriodLevel,
  periodStart: string,
): string[] {
  const end = plannerPeriodEndOf(level, periodStart);
  const weeks: string[] = [];
  let monday = plannerWeekStartOf(periodStart);
  while (monday <= end) {
    const thursday = plannerAddDays(monday, 3);
    if (thursday >= periodStart && thursday <= end) weeks.push(monday);
    monday = plannerAddDays(monday, 7);
  }
  return weeks;
}

/** Which periods close with the week that starts on `weekStart`, biggest last. */
export function plannerPeriodsClosingWith(
  weekStart: string,
): Array<{ level: PlannerPeriodLevel; period_start: string }> {
  const monday = plannerWeekStartOf(weekStart);
  const next = plannerAddDays(monday, 7);
  return plannerPeriodLevels.flatMap((level) => {
    const period = plannerPeriodOfWeek(level, monday);
    return period === plannerPeriodOfWeek(level, next)
      ? []
      : [{ level, period_start: period }];
  });
}

/**
 * The period reviews due for the client's `today`: the ones closing with the
 * week the weekly review looks back on (plannerReviewWeekFor), on the days a
 * weekly review is due (Saturday to Monday), biggest last. The page itself
 * lets any closed period be reviewed on any day.
 */
export function plannerPeriodReviewsDue(
  today: string,
): Array<{ level: PlannerPeriodLevel; period_start: string }> {
  if (!plannerReviewDueDay(today)) return [];
  return plannerPeriodsClosingWith(plannerReviewWeekFor(today));
}

/** The latest period of `level` that has closed by `today`, by the Thursday rule. */
export function plannerLatestClosedPeriod(
  level: PlannerPeriodLevel,
  today: string,
): string {
  const reviewWeek = plannerReviewWeekFor(today);
  const closing = plannerPeriodsClosingWith(reviewWeek).find(
    (entry) => entry.level === level,
  );
  if (closing) return closing.period_start;
  return plannerPreviousPeriodStartOf(
    level,
    plannerPeriodOfWeek(level, reviewWeek),
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "October 2026", "Q4 2026" or "2026". */
export function plannerPeriodLabel(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  const year = periodStart.slice(0, 4);
  const month = Number(periodStart.slice(5, 7));
  if (level === "month") return `${MONTH_NAMES[month - 1]} ${year}`;
  if (level === "quarter") return `Q${Math.ceil(month / 3)} ${year}`;
  return year;
}

/** The month index (0 to 11) and year of the week, for the page's labels. */
export function plannerWeekMonthLabel(weekStart: string): string {
  const { year, month } = plannerWeekMonthOf(weekStart);
  return `${MONTH_NAMES[month]} ${year}`;
}

// ---------------------------------------------------------------------------
// The steps of each level
// ---------------------------------------------------------------------------

/**
 * One step of a period review: the question the owner answers and what it
 * is answered from. The owner's own method, word for word, so it stays in
 * English like the weekly prompts.
 */
export type PlannerPeriodStep = {
  id: string;
  title: string;
  question: string;
  /** The rung of the ladder it is answered from. */
  from: string;
};

export const plannerPeriodSteps: Record<
  PlannerPeriodLevel,
  readonly PlannerPeriodStep[]
> = {
  month: [
    {
      id: "check",
      title: "Check the summaries",
      question: "What did the summaries leave out?",
      from: "Diary entries against the weekly memos",
    },
    {
      id: "questions",
      title: "Grade the key questions",
      question: "Were the key questions answered or dodged?",
      from: "Each week's question, graded from entries and tasks",
    },
    {
      id: "goals",
      title: "Strike the month goals",
      question: "Which month goal points are struck?",
      from: "Each strike needs a receipt",
    },
    {
      id: "fold",
      title: "Write the fold",
      question: "One sentence per objective: the fold.",
      from: "You write it. The model flags unsupported claims.",
    },
    {
      id: "verdict",
      title: "Verdict and forecast",
      question: "Verdict and forecast for next month.",
      from: "Graded at the next month review",
    },
  ],
  quarter: [
    {
      id: "goals",
      title: "Goal walk",
      question: "Which goals get kept, rephrased, killed?",
      from: "Your five-step grade, receipts per point",
    },
    {
      id: "themes",
      title: "Themes",
      question: "What themes run through the quarter's weeks?",
      from: "Two readers code the diary, agreement shown",
    },
    {
      id: "scores",
      title: "Scores",
      question: "Trend or noise in the scores?",
      from: "Thirteen weeks, floors, spread",
    },
    {
      id: "premortem",
      title: "Pre-mortem",
      question: "It is the end of next quarter and it failed. Why?",
      from: "You answer. The model lists this quarter's misses.",
    },
    {
      id: "close",
      title: "Close-out",
      question: "Close-out sentence, then next quarter's goals.",
      from: "Goes to Behind me. Goals are yours.",
    },
  ],
  year: [
    {
      id: "calendar",
      title: "Calendar walk",
      question: "Which weeks would you repeat, which never?",
      from: "One line per week from the entries, your marks",
    },
    {
      id: "goals",
      title: "Grade the year goals",
      question: "Did the year goals happen?",
      from: "Your grade, twelve months of receipts",
    },
    {
      id: "northstar",
      title: "North star test",
      question: "Does the north star still hold?",
      from: "What the year proved and disproved",
    },
    {
      id: "beliefs",
      title: "Belief ledger",
      question: "What did you believe in January that you don't now?",
      from: "Memories created against memories revised",
    },
    {
      id: "sentence",
      title: "Year sentence",
      question: "The year in one page, then next year's four goals.",
      from: "Goals are yours. No suggestions.",
    },
  ],
};

/** The verdicts of the weekly review, reused: continue, pivot, pause. */
export const plannerPeriodVerdictKinds = [
  "continue",
  "pivot",
  "pause",
] as const;

/** How the last period's forecast turned out, graded by this review. */
export const plannerForecastGrades = ["held", "partly", "missed"] as const;
export type PlannerForecastGrade = (typeof plannerForecastGrades)[number];

/** The quarter goal walk's decisions. */
export const plannerGoalDecisions = ["keep", "rephrase", "kill"] as const;
export type PlannerGoalDecision = (typeof plannerGoalDecisions)[number];

/** The year calendar walk's marks on a week. */
export const plannerWeekMarks = ["repeat", "never"] as const;
export type PlannerWeekMark = (typeof plannerWeekMarks)[number];

/** Where a receipt comes from: a diary entry, a health row, a task event, a week record. */
export const plannerEvidenceSources = [
  "memo",
  "health",
  "task_event",
  "week",
] as const;
export type PlannerEvidenceSource = (typeof plannerEvidenceSources)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const daySchema = z.string().refine(plannerIsDay, "Not a day (YYYY-MM-DD).");

export const plannerPeriodLevelSchema = z.enum(plannerPeriodLevels);
export const plannerForecastGradeSchema = z.enum(plannerForecastGrades);
export const plannerGoalDecisionSchema = z.enum(plannerGoalDecisions);
export const plannerWeekMarkSchema = z.enum(plannerWeekMarks);
export const plannerEvidenceSourceSchema = z.enum(plannerEvidenceSources);

export const plannerPeriodReviewQuerySchema = z.object({
  today: daySchema,
  level: plannerPeriodLevelSchema.optional(),
  period: daySchema.optional(),
});

export const plannerPeriodStatusQuerySchema = z.object({ today: daySchema });

export const plannerPeriodStateMax = 512_000;

export const plannerSavePeriodStateSchema = z.strictObject({
  state: z.record(z.string(), z.unknown()),
});

/** A receipt: a claim and the words it rests on. Verified by the server. */
export const plannerEvidenceInputSchema = z.strictObject({
  pillar: plannerPillarSchema.nullable(),
  claim: z.string().trim().min(1).max(600),
  quote: z.string().trim().min(1).max(600),
});

export const plannerEvidenceDtoSchema = z.object({
  id: z.string(),
  pillar: plannerPillarSchema.nullable(),
  claim: z.string(),
  quote: z.string(),
  source: plannerEvidenceSourceSchema.nullable(),
  // The memo, row or event the quote was found in, `memos/<id>` for an entry.
  source_id: z.string().nullable(),
  source_day: z.string().nullable(),
  // True when the quote exists, word for word, in a raw row of the period.
  verified: z.boolean(),
});

export const plannerPeriodGoalResultSchema = z.strictObject({
  goal_id: z.string().min(1).max(200),
  result: plannerGoalResultSchema.nullable(),
  // The quarter goal walk's decision, or the owner's note on the result.
  decision: plannerGoalDecisionSchema.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export const plannerPeriodMemoMax = 60_000;

export const plannerSavePeriodSchema = z.strictObject({
  today: daySchema,
  memo: z.string().min(1).max(plannerPeriodMemoMax),
  // The model's draft, kept so the rewrite rate can be read later.
  draft_memo: z.string().max(plannerPeriodMemoMax).nullable(),
  verdict: z
    .strictObject({
      kind: plannerVerdictKindSchema,
      text: z.string().trim().max(2000),
    })
    .nullable(),
  // One sentence about the next period, graded at its review.
  forecast: z.string().trim().max(2000).nullable(),
  // How the last period's forecast turned out.
  previous_grade: plannerForecastGradeSchema.nullable(),
  goal_results: z.array(plannerPeriodGoalResultSchema).max(200),
  evidence: z.array(plannerEvidenceInputSchema).max(200),
  // The year calendar walk's marks, by Monday.
  week_marks: z.record(z.string(), plannerWeekMarkSchema).optional(),
});

export const plannerPeriodChatMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(12_000),
});

/** Answers so far, one list of lines per step id. */
export const plannerPeriodAnswersSchema = z.record(
  z.string().max(40),
  z.array(z.string().max(12_000)).max(40),
);

export const plannerPeriodAiChecksSchema = z.strictObject({ today: daySchema });

export const plannerPeriodAiThemesSchema = z.strictObject({ today: daySchema });

export const plannerPeriodAiCoachSchema = z.strictObject({
  today: daySchema,
  step: z.string().min(1).max(40),
  messages: z.array(plannerPeriodChatMessageSchema).max(60),
  answers: plannerPeriodAnswersSchema,
});

export const plannerPeriodAiMemoSchema = z.strictObject({
  today: daySchema,
  answers: plannerPeriodAnswersSchema,
  goal_results: z.array(plannerPeriodGoalResultSchema).max(200),
  verdict: z
    .strictObject({
      kind: plannerVerdictKindSchema,
      text: z.string().trim().max(2000),
    })
    .nullable(),
  forecast: z.string().trim().max(2000).nullable(),
});

// --- Responses ----------------------------------------------------------------

export const plannerPeriodWeekSchema = z.object({
  week_start: z.string(),
  // The ISO week number.
  number: z.number().int(),
  auth: z.number().nullable(),
  ach: z.number().nullable(),
  question: z.string().nullable(),
  verdict: z.string().nullable(),
  // The week's summary memo, `memos/<id>`, when it has one.
  memo_id: z.string().nullable(),
  // Counts of raw rows: rungs 1 and 2.
  entries: z.number().int(),
  entry_chars: z.number().int(),
  health_rows: z.number().int(),
  training: z.number().int(),
  breath_days: z.number().int(),
  nights_out: z.number().int(),
  tasks_done: z.number().int(),
  // The week's goals with their results: met / partial / missed per goal.
  goal_results: z.object({
    met: z.number().int(),
    partial: z.number().int(),
    missed: z.number().int(),
    open: z.number().int(),
  }),
  // The first line of each diary entry, for the year's calendar walk.
  first_lines: z.array(z.string()),
});

export const plannerPeriodGoalSchema = z.object({
  id: z.string(),
  level: z.string(),
  period_start: z.string().nullable(),
  pillar: plannerPillarSchema.nullable(),
  title: z.string(),
  lines: z.array(
    z.object({
      text: z.string(),
      note: z.string().optional(),
      struck: z.boolean().optional(),
    }),
  ),
  status: z.string(),
  note: z.string().nullable(),
  result: plannerGoalResultSchema.nullable(),
  // How many tasks were linked to it and how many of those were done.
  tasks_linked: z.number().int(),
  tasks_done: z.number().int(),
});

export const plannerPeriodPreviousSchema = z.object({
  period_start: z.string(),
  verdict: z.string().nullable(),
  forecast: z.string().nullable(),
  forecast_grade: plannerForecastGradeSchema.nullable(),
  memo_id: z.string().nullable(),
});

export const plannerPeriodDueSchema = z.object({
  level: plannerPeriodLevelSchema,
  period_start: z.string(),
  done: z.boolean(),
});

export const plannerPeriodReviewResponseSchema = z.object({
  level: plannerPeriodLevelSchema,
  period_start: z.string(),
  period_end: z.string(),
  label: z.string(),
  // The week the weekly review looks back on today, and whether its Look back is done.
  review_week: z.string(),
  look_back_done: z.boolean(),
  // Every period review closing with that week, biggest last.
  due: z.array(plannerPeriodDueSchema),
  weeks: z.array(plannerPeriodWeekSchema),
  goals: z.array(plannerPeriodGoalSchema),
  // The level below's goals inside the period (months of a quarter, quarters of a year).
  child_goals: z.array(plannerPeriodGoalSchema),
  north_star: plannerPeriodGoalSchema.nullable(),
  previous: plannerPeriodPreviousSchema.nullable(),
  // Memories: created in the period, and older ones revised in it (the belief ledger).
  memories: z.object({
    created: z.number().int(),
    revised: z.number().int(),
    created_lines: z.array(z.string()),
    revised_lines: z.array(z.string()),
  }),
  state: z.record(z.string(), z.unknown()),
  done_at: z.string().nullable(),
  memo: z.object({ id: z.string(), content: z.string() }).nullable(),
  verdict: z.string().nullable(),
  forecast: z.string().nullable(),
  rewrite_rate: z.number().nullable(),
  evidence: z.array(plannerEvidenceDtoSchema),
  ai: z.boolean(),
});

export const plannerPeriodStatusResponseSchema = z.object({
  review_week: z.string(),
  look_back_done: z.boolean(),
  due: z.array(plannerPeriodDueSchema),
  // True when a period review closes with this week and is not done yet.
  any_due: z.boolean(),
});

export const plannerPeriodStateResponseSchema = z.object({
  updated_at: z.string(),
});

export const plannerSavePeriodResponseSchema = z.object({
  memo_id: z.string(),
  done_at: z.string(),
  rewrite_rate: z.number().nullable(),
  evidence: z.array(plannerEvidenceDtoSchema),
});

/** One summary claim checked against the diary. */
export const plannerPeriodCheckSchema = z.object({
  week_start: z.string(),
  claim: z.string(),
  quote: z.string(),
  // What the model said; `verified` is the server's own word-for-word check.
  holds: z.boolean(),
  verified: z.boolean(),
  source_id: z.string().nullable(),
});

export const plannerPeriodAiChecksResponseSchema = z.object({
  checks: z.array(plannerPeriodCheckSchema),
  // What the model says the summaries left out, with a quote each.
  left_out: z.array(
    z.object({
      quote: z.string(),
      why: z.string(),
      verified: z.boolean(),
      source_id: z.string().nullable(),
    }),
  ),
});

export const plannerPeriodThemeSchema = z.object({
  label: z.string(),
  pillar: plannerPillarSchema.nullable(),
  quote: z.string(),
  verified: z.boolean(),
  source_id: z.string().nullable(),
  // Which of the two readers named it: both, or one.
  readers: z.number().int(),
});

export const plannerPeriodAiThemesResponseSchema = z.object({
  themes: z.array(plannerPeriodThemeSchema),
  // Share of themes both readers named, 0 to 1.
  agreement: z.number(),
});

export type PlannerEvidenceInput = z.input<typeof plannerEvidenceInputSchema>;
export type PlannerEvidenceDto = z.infer<typeof plannerEvidenceDtoSchema>;
export type PlannerPeriodGoalResultInput = z.input<
  typeof plannerPeriodGoalResultSchema
>;
export type PlannerSavePeriodInput = z.input<typeof plannerSavePeriodSchema>;
export type PlannerSavePeriodStateInput = z.input<
  typeof plannerSavePeriodStateSchema
>;
export type PlannerPeriodAnswers = z.infer<typeof plannerPeriodAnswersSchema>;
export type PlannerPeriodAiCoachInput = z.input<
  typeof plannerPeriodAiCoachSchema
>;
export type PlannerPeriodAiMemoInput = z.input<
  typeof plannerPeriodAiMemoSchema
>;
export type PlannerPeriodAiChecksInput = z.input<
  typeof plannerPeriodAiChecksSchema
>;
export type PlannerPeriodAiThemesInput = z.input<
  typeof plannerPeriodAiThemesSchema
>;
export type PlannerPeriodWeek = z.infer<typeof plannerPeriodWeekSchema>;
export type PlannerPeriodGoal = z.infer<typeof plannerPeriodGoalSchema>;
export type PlannerPeriodPrevious = z.infer<typeof plannerPeriodPreviousSchema>;
export type PlannerPeriodDue = z.infer<typeof plannerPeriodDueSchema>;
export type PlannerPeriodReviewResponse = z.infer<
  typeof plannerPeriodReviewResponseSchema
>;
export type PlannerPeriodStatusResponse = z.infer<
  typeof plannerPeriodStatusResponseSchema
>;
export type PlannerPeriodStateResponse = z.infer<
  typeof plannerPeriodStateResponseSchema
>;
export type PlannerSavePeriodResponse = z.infer<
  typeof plannerSavePeriodResponseSchema
>;
export type PlannerPeriodCheck = z.infer<typeof plannerPeriodCheckSchema>;
export type PlannerPeriodAiChecksResponse = z.infer<
  typeof plannerPeriodAiChecksResponseSchema
>;
export type PlannerPeriodTheme = z.infer<typeof plannerPeriodThemeSchema>;
export type PlannerPeriodAiThemesResponse = z.infer<
  typeof plannerPeriodAiThemesResponseSchema
>;

/** The goal results a period review can record, by pillar, for the memo. */
export type PlannerPeriodGoalOutcome = {
  pillar: PlannerPillar | null;
  title: string;
  result: PlannerGoalResult | null;
  decision: PlannerGoalDecision | null;
};
