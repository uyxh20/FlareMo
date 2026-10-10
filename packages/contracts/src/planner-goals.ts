// Goals and the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the shared constants, the week maths and
// the HTTP API under /api/app/planner that the Worker validates and the web app
// calls. planner.ts re-exports this file, so it must never import planner.ts back:
// a re-exported module runs first and would read planner.ts's constants before they
// exist. The few day helpers it needs are its own, with the same rules: a day is a
// `YYYY-MM-DD` key read as UTC midnight with UTC getters only, and weeks start on
// Monday.
//
// Every export is prefixed planner/Planner.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The four objectives every goal and weekly goal is tagged with, in display order. */
export const plannerPillars = ["of", "work", "ai", "health"] as const;
export type PlannerPillar = (typeof plannerPillars)[number];

/** The cascade, from the north star down to a week. */
export const plannerGoalLevels = [
  "north_star",
  "year",
  "quarter",
  "month",
  "week",
] as const;
export type PlannerGoalLevel = (typeof plannerGoalLevels)[number];

export const plannerGoalStatuses = [
  "active",
  "draft",
  "contested",
  "closed",
] as const;
export type PlannerGoalStatus = (typeof plannerGoalStatuses)[number];

export const plannerGoalResults = ["met", "partial", "missed"] as const;
export type PlannerGoalResult = (typeof plannerGoalResults)[number];

/** The owner's yearly floors: a scored week is on target when both are met. */
export const plannerScoreFloors = { auth: 4, ach: 3.5 } as const;

/** The most cards To Do should hold after a week is planned. */
export const plannerTodoCap = 7;

/** The three verdicts a review can end on. */
export const plannerVerdictKinds = ["continue", "pivot", "pause"] as const;
export type PlannerVerdictKind = (typeof plannerVerdictKinds)[number];

/**
 * The seven reflection prompts of the owner's weekly review, in order. `label` is
 * the bullet label the summary memo uses for the answer.
 */
export const plannerReviewPrompts = [
  {
    label: "Impact",
    question: "What did you accomplish that directly impacts your main goals?",
  },
  {
    label: "Lesson",
    question: "What's the most important lesson you learned?",
  },
  {
    label: "Not delegating",
    question: "What are you not delegating, automating or pruning?",
  },
  { label: "Bottleneck", question: "What is the single biggest bottleneck?" },
  {
    label: "Big thing",
    question: "What is the one big thing you delivered this week?",
  },
  { label: "Blindspot", question: "What is one blindspot?" },
  { label: "Tempted to hide", question: "What are you tempted to hide?" },
] as const;

/** The owner's scoring rubric, per score and whole step. */
export const plannerScoreRubric = {
  auth: {
    5: "Surfaced uncomfortable truths before being asked",
    4: "Honest when prompted; named what I was tempted to hide",
    3: "Some avoidance or rationalization",
    2: "Blind spots left alone; edited the story to look better",
    1: "Hid misses; optimized for looking clean",
  },
  ach: {
    5: "Exceeded all goals, stretch included",
    4: "Main goals met, some stretch",
    3: "Most goals met, some misses",
    2: "Significant misses on main goals",
    1: "Priorities not delivered",
  },
} as const;

/** The tag every weekly summary memo carries, the imported ones included. */
export const plannerSummaryMemoTag = "vault-summary";

/** The memo `source` of a summary written by the weekly review. */
export const plannerSummaryMemoSource = "weekly-review";

/** The summary memo's idempotency key for a week: one memo per reviewed week. */
export function plannerSummaryMemoClientId(weekStart: string): string {
  return `weekly-review-summary:${weekStart}`;
}

// ---------------------------------------------------------------------------
// Week maths
// ---------------------------------------------------------------------------

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function parseDay(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY_KEY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function requireDay(value: unknown): Date {
  const date = parseDay(value);
  if (!date) {
    throw new RangeError(`Expected a YYYY-MM-DD day, got ${String(value)}`);
  }
  return date;
}

function formatDay(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError("The day is outside 0001-01-01 to 9999-12-31");
  }
  return [
    String(year).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** True for a real calendar day written as `YYYY-MM-DD`. */
export function plannerIsDay(value: unknown): value is string {
  return parseDay(value) !== undefined;
}

/** True for a real day that is a Monday. */
export function plannerIsMonday(value: unknown): value is string {
  const date = parseDay(value);
  return date !== undefined && date.getUTCDay() === 1;
}

/** `day` moved by whole days. Throws a RangeError for a bad day. */
export function plannerAddDays(day: string, days: number): string {
  const date = requireDay(day);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDay(date);
}

/** The weekday of a day: 0 is Sunday, 6 is Saturday (like `getUTCDay`). */
export function plannerWeekday(day: string): number {
  return requireDay(day).getUTCDay();
}

/** The Monday on or before `day`. */
export function plannerWeekStartOf(day: string): string {
  const date = requireDay(day);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return formatDay(date);
}

/** The first day of the calendar month of `day`. */
export function plannerMonthStartOf(day: string): string {
  requireDay(day);
  return `${day.slice(0, 7)}-01`;
}

/** The first day of the calendar quarter of `day`. */
export function plannerQuarterStartOf(day: string): string {
  const date = requireDay(day);
  const month = Math.floor(date.getUTCMonth() / 3) * 3 + 1;
  return `${day.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
}

/**
 * The ISO week of a day: the week-numbering year (the year of the week's
 * Thursday) and the week number, 1 to 53.
 */
export function plannerIsoWeekOf(day: string): { year: number; week: number } {
  const thursday = requireDay(plannerAddDays(plannerWeekStartOf(day), 3));
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(0);
  jan1.setUTCFullYear(year, 0, 1);
  const week =
    Math.floor((thursday.getTime() - jan1.getTime()) / MS_PER_DAY / 7) + 1;
  return { year, week };
}

/** The Monday of ISO week `week` of `year` (week 1 holds the year's first Thursday). */
export function plannerIsoWeekMonday(year: number, week: number): string {
  const jan4 = new Date(0);
  jan4.setUTCFullYear(year, 0, 4);
  const monday = plannerWeekStartOf(formatDay(jan4));
  return plannerAddDays(monday, (week - 1) * 7);
}

/** How many ISO weeks `year` has: 53 when it starts or (in a leap year) ends on a Thursday. */
export function plannerIsoWeekCount(year: number): number {
  const dec28 = new Date(0);
  dec28.setUTCFullYear(year, 11, 28);
  return plannerIsoWeekOf(formatDay(dec28)).week;
}

/** Every Monday of the ISO year, week 1 first. */
export function plannerIsoYearMondays(year: number): string[] {
  const first = plannerIsoWeekMonday(year, 1);
  return Array.from({ length: plannerIsoWeekCount(year) }, (_, index) =>
    plannerAddDays(first, index * 7),
  );
}

/**
 * The calendar month a week belongs to on the Goals page: the month of its
 * Thursday, so a week is never split between two months. `month` is 0 to 11.
 */
export function plannerWeekMonthOf(day: string): {
  year: number;
  month: number;
} {
  const thursday = requireDay(plannerAddDays(plannerWeekStartOf(day), 3));
  return { year: thursday.getUTCFullYear(), month: thursday.getUTCMonth() };
}

/**
 * The week a review looks back on, for the client's `today`: on Saturday and
 * Sunday it is the current week; from Monday to Friday it is the week before.
 */
export function plannerReviewWeekFor(today: string): string {
  const monday = plannerWeekStartOf(today);
  const weekday = plannerWeekday(today);
  return weekday === 0 || weekday === 6 ? monday : plannerAddDays(monday, -7);
}

/** Whether a weekly review is due on `today`: from Saturday to Monday. */
export function plannerReviewDueDay(today: string): boolean {
  const weekday = plannerWeekday(today);
  return weekday === 6 || weekday === 0 || weekday === 1;
}

/** A score snapped to the scale: 1 to 5 in half steps, or null for anything else. */
export function plannerSnapScore(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 5) return null;
  return Math.round(number * 2) / 2;
}

/** Whether a scored week met both floors; false for a week with a missing score. */
export function plannerOnTarget(week: {
  auth: number | null;
  ach: number | null;
}): boolean {
  return (
    week.auth !== null &&
    week.ach !== null &&
    week.auth >= plannerScoreFloors.auth &&
    week.ach >= plannerScoreFloors.ach
  );
}

// ---------------------------------------------------------------------------
// HTTP API: goals, weeks and the weekly review under /api/app/planner
// ---------------------------------------------------------------------------
//
//   GET    /goals?year&today                 PlannerGoalsYearResponse
//   POST   /goals                            201 PlannerGoalResponse
//   PATCH  /goals/:id                        PlannerGoalResponse
//   DELETE /goals/:id                        PlannerOkResponse
//   PATCH  /weeks/:weekStart                 PlannerWeekResponse
//   GET    /review?today[&week]              PlannerReviewResponse
//   GET    /review/status?today              PlannerReviewStatusResponse
//   PATCH  /review/:week/state               PlannerReviewStateResponse
//   POST   /review/:week/look-back           PlannerLookBackResponse
//   POST   /review/:week/look-forward        PlannerCommitResponse
//   POST   /review/:week/ai/opening          PlannerAiOpeningResponse
//   POST   /review/:week/ai/close            PlannerAiCloseResponse
//   POST   /review/:week/ai/check            PlannerAiCheckResponse
//   POST   /review/:week/ai/coach            NDJSON stream (see below)
//   POST   /review/:week/ai/memo             NDJSON stream (see below)
//
// `:week` is the Monday of the week looked back on. The two streaming routes
// answer `application/x-ndjson`, one JSON object per line: `{"d": "<text>"}` for
// each piece of text, then exactly one `{"done": true}` (the coach adds
// `"advance"`) or `{"error": "failed"}`; a throttled request is a 429 whose body
// is the line `{"error": "limited"}`. A JSON AI route that cannot reach a model
// answers 503 with `{ error: { message, code: "ai_unavailable" } }`, and the page
// falls back to its own drafts. Like every planner route, request bodies reject
// unknown keys.

const daySchema = z
  .string()
  .refine(plannerIsDay, "Expected a real YYYY-MM-DD date.");

const mondaySchema = z
  .string()
  .refine(plannerIsMonday, "Expected the Monday of a week, YYYY-MM-DD.");

const idSchema = z.string().trim().min(1).max(256);

export const plannerPillarSchema = z.enum(plannerPillars);
export const plannerGoalLevelSchema = z.enum(plannerGoalLevels);
export const plannerGoalStatusSchema = z.enum(plannerGoalStatuses);
export const plannerGoalResultSchema = z.enum(plannerGoalResults);
export const plannerVerdictKindSchema = z.enum(plannerVerdictKinds);

/** A weekly score: 1 to 5 in half steps. */
export const plannerScoreSchema = z
  .number()
  .min(1)
  .max(5)
  .refine(
    (value) => Math.abs(value * 2 - Math.round(value * 2)) <= 1e-9,
    "Expected a score in half steps (1, 1.5, ... 5).",
  );

/** One line under a goal's title: a point, with an optional short note, maybe struck. */
export const plannerGoalLineSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  note: z.string().trim().min(1).max(200).optional(),
  struck: z.boolean().optional(),
});

export const plannerGoalTitleMax = 1000;
const goalTitleSchema = z.string().trim().max(plannerGoalTitleMax);
const goalLinesSchema = z.array(plannerGoalLineSchema).max(24);
const goalNoteSchema = z.string().trim().max(2000);

/**
 * A new goal. `period_start` may be any day inside the period: the server keeps
 * the period's first day (1 January, the quarter's or month's first day, the
 * Monday). The north star has no period; every other level needs one. A goal
 * needs a title or at least one line. `id` lets a client name the goal itself
 * (a UUID), which makes a retried create harmless.
 */
export const plannerCreateGoalSchema = z
  .strictObject({
    id: z.uuid().optional(),
    level: plannerGoalLevelSchema,
    period_start: daySchema.nullable().optional(),
    pillar: plannerPillarSchema.nullable().optional(),
    title: goalTitleSchema.default(""),
    lines: goalLinesSchema.default([]),
    status: plannerGoalStatusSchema.default("active"),
    note: goalNoteSchema.nullable().optional(),
    result: plannerGoalResultSchema.nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  .refine(
    (value) =>
      value.level === "north_star"
        ? value.period_start === undefined || value.period_start === null
        : typeof value.period_start === "string",
    {
      message: "The north star has no period; every other goal needs one.",
      path: ["period_start"],
    },
  )
  .refine((value) => value.title.length > 0 || value.lines.length > 0, {
    message: "A goal needs a title or a line.",
    path: ["title"],
  });

/** An omitted field is unchanged; `null` clears a nullable one. */
export const plannerUpdateGoalSchema = z
  .strictObject({
    pillar: plannerPillarSchema.nullable().optional(),
    title: goalTitleSchema.optional(),
    lines: goalLinesSchema.optional(),
    status: plannerGoalStatusSchema.optional(),
    note: goalNoteSchema.nullable().optional(),
    result: plannerGoalResultSchema.nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one field must be updated.",
  );

export const plannerGoalsQuerySchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/, "Expected a four-digit year.")
    .transform(Number),
  today: daySchema,
});

/** A week's record. A null score clears it; the week reads as not scored. */
export const plannerUpdateWeekSchema = z
  .strictObject({
    auth: plannerScoreSchema.nullable().optional(),
    ach: plannerScoreSchema.nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    question: z.string().trim().max(500).nullable().optional(),
    verdict: z.string().trim().max(1000).nullable().optional(),
    memo_id: idSchema.nullable().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one field must be updated.",
  );

export const plannerReviewQuerySchema = z.object({
  today: daySchema,
  // Another week than the one `today` reviews; a future week is a 400.
  week: mondaySchema.optional(),
});

export const plannerReviewStatusQuerySchema = z.object({ today: daySchema });

/** The longest review state the page may save, in characters of JSON. */
export const plannerReviewStateMax = 256_000;

/** The page's own record of a review in progress, saved as it goes. */
export const plannerSaveReviewStateSchema = z.strictObject({
  state: z.record(z.string(), z.unknown()),
});

/** One goal's result, as the review records it; null clears it. */
export const plannerGoalResultInputSchema = z.strictObject({
  goal_id: idSchema,
  result: plannerGoalResultSchema.nullable(),
});

const verdictInputSchema = z.strictObject({
  kind: plannerVerdictKindSchema,
  text: z.string().trim().min(1).max(1000),
});

/**
 * Look back is finished: the week's scores, the question for the next review,
 * the verdict, last week's goal results and the summary memo. Saving again
 * replaces all of it, the memo's text included (the memo keeps its id).
 */
export const plannerLookBackSchema = z.strictObject({
  today: daySchema,
  scores: z.strictObject({ auth: plannerScoreSchema, ach: plannerScoreSchema }),
  question: z.string().trim().max(500).nullable(),
  verdict: verdictInputSchema.nullable(),
  goal_results: z.array(plannerGoalResultInputSchema).max(24),
  memo: z.string().trim().min(1).max(100_000),
});

/** A weekly goal of the plan. Its id is the client's UUID, so saving twice is harmless. */
export const plannerPlanGoalSchema = z.strictObject({
  id: z.uuid(),
  pillar: plannerPillarSchema.nullable(),
  title: z.string().trim().min(1).max(plannerGoalTitleMax),
});

/**
 * A task of the plan: an existing card (`task_id`) or a new one (`title`), never
 * both. `ref` is the client's name for it, unique in the plan; a new task is
 * created once per ref, however often the plan is saved.
 */
export const plannerPlanTaskSchema = z
  .strictObject({
    ref: z.string().trim().min(1).max(64),
    goal_id: z.uuid(),
    task_id: idSchema.optional(),
    title: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    (value) => (value.task_id === undefined) !== (value.title === undefined),
    { message: "A plan task needs either task_id or title.", path: ["title"] },
  );

/** How a flag from the last conflict check was settled in Check goals. */
export const plannerSettleFlagSchema = z
  .strictObject({
    flag_id: idSchema,
    state: z.enum(["kept", "rewritten"]),
    // The new title of the goal the flag names; required for `rewritten`.
    title: z.string().trim().min(1).max(plannerGoalTitleMax).optional(),
  })
  .refine((value) => value.state === "kept" || value.title !== undefined, {
    message: "A rewrite needs the new title.",
    path: ["title"],
  });

/** One clash the conflict check found. It only reports; it never changes a goal. */
export const plannerFlagInputSchema = z.strictObject({
  goal_id: z.uuid().nullable(),
  pillar: plannerPillarSchema.nullable(),
  with_goal_id: idSchema.nullable(),
  with_label: z.string().trim().min(1).max(120),
  why: z.string().trim().min(1).max(300),
});

/**
 * Look forward is saved: the next week's goals and tasks, the cards that go back
 * to Backlog, the question for the next review, the settled flags and what the
 * conflict check found. The plan replaces the week's goals: a weekly goal of that
 * week that is not in `goals` is removed.
 */
export const plannerCommitSchema = z
  .strictObject({
    today: daySchema,
    goals: z.array(plannerPlanGoalSchema).max(12),
    tasks: z.array(plannerPlanTaskSchema).max(40),
    to_backlog: z.array(idSchema).max(100),
    question: z.string().trim().max(500).nullable(),
    settled: z.array(plannerSettleFlagSchema).max(24),
    flags: z.array(plannerFlagInputSchema).max(5),
  })
  .refine(
    (value) =>
      value.tasks.every((task) =>
        value.goals.some((goal) => goal.id === task.goal_id),
      ),
    {
      message: "Every task must belong to a goal of the plan.",
      path: ["tasks"],
    },
  )
  .refine(
    (value) =>
      new Set(value.tasks.map((task) => task.ref)).size === value.tasks.length,
    { message: "Task refs must be unique.", path: ["tasks"] },
  );

// --- AI requests ------------------------------------------------------------

const answerSchema = z.string().trim().min(1).max(4000);

/** What the owner has answered so far, which the close, the memo and the coach read. */
const reviewAnswersShape = {
  last_answer: z.array(answerSchema).max(12),
  // One list per prompt, in order; an empty list is a skipped prompt.
  answers: z.array(z.array(answerSchema).max(12)).length(7),
  goal_results: z.array(plannerGoalResultInputSchema).max(24),
  // The coach's replies during the chat, newest last.
  coach_notes: z.array(z.string().trim().min(1).max(2000)).max(20),
};

export const plannerAiOpeningSchema = z.strictObject({ today: daySchema });

export const plannerAiCloseSchema = z.strictObject({
  today: daySchema,
  ...reviewAnswersShape,
});

export const plannerReviewChatMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
});

/**
 * One coach reply. `free` may ask one probing question, `force` must not (it
 * acknowledges and moves on), `chat` answers after the prompts are done.
 */
export const plannerAiCoachSchema = z.strictObject({
  today: daySchema,
  mode: z.enum(["free", "force", "chat"]),
  messages: z.array(plannerReviewChatMessageSchema).min(1).max(60),
});

export const plannerAiMemoSchema = z.strictObject({
  today: daySchema,
  ...reviewAnswersShape,
  scores: z.strictObject({ auth: plannerScoreSchema, ach: plannerScoreSchema }),
  question: z.string().trim().max(500).nullable(),
  verdict: verdictInputSchema.nullable(),
  recommended: plannerVerdictKindSchema,
  drafts: z.strictObject({
    auth_evidence: z.string().trim().max(1000),
    ach_evidence: z.string().trim().max(1000),
    pattern: z.string().trim().max(1000),
    risk: z.string().trim().max(1000),
    opportunity: z.string().trim().max(1000),
  }),
});

export const plannerAiCheckSchema = z.strictObject({
  today: daySchema,
  goals: z
    .array(
      z.strictObject({
        id: z.uuid(),
        pillar: plannerPillarSchema.nullable(),
        title: z.string().trim().min(1).max(plannerGoalTitleMax),
        tasks: z.array(z.string().trim().min(1).max(2000)).max(20),
      }),
    )
    .max(12),
  settled: z.array(plannerSettleFlagSchema).max(24),
});

// --- Responses --------------------------------------------------------------

export const plannerGoalDtoSchema = z.object({
  // A random UUID, not namespaced.
  id: z.string(),
  level: plannerGoalLevelSchema,
  // The period's first day; null for the north star.
  period_start: z.string().nullable(),
  // Null for the north star, a period's theme line, or a goal with no objective.
  pillar: plannerPillarSchema.nullable(),
  title: z.string(),
  lines: z.array(
    z.object({
      text: z.string(),
      note: z.string().optional(),
      struck: z.boolean().optional(),
    }),
  ),
  status: plannerGoalStatusSchema,
  // Why it is contested, or the evidence for its result.
  note: z.string().nullable(),
  result: plannerGoalResultSchema.nullable(),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const plannerWeekDtoSchema = z.object({
  week_start: z.string(),
  auth: z.number().nullable(),
  ach: z.number().nullable(),
  note: z.string().nullable(),
  // The key question for the next week's review.
  question: z.string().nullable(),
  verdict: z.string().nullable(),
  // The summary memo, `memos/<id>`.
  memo_id: z.string().nullable(),
  source: z.enum(["review", "import"]),
  reviewed_at: z.string().nullable(),
});

export const plannerGoalFlagDtoSchema = z.object({
  id: z.string(),
  // The Monday of the week that was planned when the check ran.
  week_start: z.string(),
  goal_id: z.string().nullable(),
  pillar: plannerPillarSchema.nullable(),
  with_goal_id: z.string().nullable(),
  with_label: z.string(),
  why: z.string(),
  state: z.enum(["open", "kept", "rewritten"]),
  created_at: z.string(),
  settled_at: z.string().nullable(),
});

export const plannerGoalResponseSchema = z.object({
  goal: plannerGoalDtoSchema,
});

export const plannerOkResponseSchema = z.object({ ok: z.literal(true) });

export const plannerWeekResponseSchema = z.object({
  week: plannerWeekDtoSchema,
});

/**
 * Everything the Goals page draws for one ISO year: the north star, the year,
 * quarter and month goals of the calendar year, the weekly goals of the ISO
 * year's weeks and every recorded week.
 */
export const plannerGoalsYearResponseSchema = z.object({
  year: z.number().int(),
  today: z.string(),
  // The Monday of the week `today` is in.
  current_week: z.string(),
  north_star: plannerGoalDtoSchema.nullable(),
  // Ordered by level, period, objective and sort order.
  goals: z.array(plannerGoalDtoSchema),
  weeks: z.array(plannerWeekDtoSchema),
});

/** The cockpit's week and its goals, sent with the board. */
export const plannerCockpitWeekSchema = z.object({
  // The Monday of the week the goal cards show: this week, or on a weekend the
  // next one once it has been planned.
  start: z.string(),
  goals: z.array(plannerGoalDtoSchema),
});

export const plannerReviewResponseSchema = z.object({
  today: z.string(),
  // The Monday of the week looked back on, and of the week it plans.
  review_week: z.string(),
  plan_week: z.string(),
  // The page's saved state, or null before it first saved.
  state: z.record(z.string(), z.unknown()).nullable(),
  look_back_done_at: z.string().nullable(),
  look_forward_done_at: z.string().nullable(),
  // The key question the previous review left for this one.
  last_question: z.string().nullable(),
  // The weekly goals of the week looked back on.
  week_goals: z.array(plannerGoalDtoSchema),
  // The weekly goals already saved for the week being planned.
  plan_goals: z.array(plannerGoalDtoSchema),
  // Open flags from earlier conflict checks, oldest first, and the goals they name.
  flags: z.array(plannerGoalFlagDtoSchema),
  flag_goals: z.array(plannerGoalDtoSchema),
  // The scores of the 19 weeks ending with the week looked back on, oldest first.
  scores: z.array(
    z.object({
      week_start: z.string(),
      auth: z.number().nullable(),
      ach: z.number().nullable(),
    }),
  ),
  // The record of the week looked back on, once Look back saved it.
  week: plannerWeekDtoSchema.nullable(),
  // The week's summary memo, once written.
  summary: z.object({ id: z.string(), content: z.string() }).nullable(),
  // Next Steps per objective from the latest summary memo, to start the plan from.
  suggested_goals: z.partialRecord(plannerPillarSchema, z.string()),
  // Whether a language model is configured (Workers AI or Anthropic).
  ai: z.boolean(),
});

export const plannerReviewStatusResponseSchema = z.object({
  review_week: z.string(),
  // True from Saturday to Monday until both parts of the review are done.
  due: z.boolean(),
  look_back_done: z.boolean(),
  look_forward_done: z.boolean(),
});

export const plannerReviewStateResponseSchema = z.object({
  updated_at: z.string(),
});

export const plannerLookBackResponseSchema = z.object({
  week: plannerWeekDtoSchema,
  memo_id: z.string(),
});

export const plannerCommitResponseSchema = z.object({
  plan_week: z.string(),
  goals: z.array(plannerGoalDtoSchema),
  // Each new task's ref and the task id it made.
  created: z.record(z.string(), z.string()),
});

export const plannerAiOpeningResponseSchema = z.object({
  // The week in a few plain words.
  recap: z.string(),
  // Answer options for last week's key question.
  lastq: z.array(z.string()),
  // Answer options for each of the seven prompts.
  prompts: z.array(z.array(z.string())),
});

export const plannerAiCloseResponseSchema = z.object({
  scores: z.object({
    auth: z.number().nullable(),
    ach: z.number().nullable(),
    auth_evidence: z.string(),
    ach_evidence: z.string(),
  }),
  trajectory: z.object({
    pattern: z.string(),
    risk: z.string(),
    opportunity: z.string(),
    questions: z.array(z.string()),
    verdicts: z.object({
      continue: z.string(),
      pivot: z.string(),
      pause: z.string(),
    }),
    recommended: plannerVerdictKindSchema.nullable(),
  }),
});

export const plannerAiCheckResponseSchema = z.object({
  flags: z.array(
    z.object({
      goal_id: z.string().nullable(),
      pillar: plannerPillarSchema.nullable(),
      with_goal_id: z.string().nullable(),
      with_label: z.string(),
      why: z.string(),
    }),
  ),
});

/**
 * One line of a streaming AI answer. The coach's last line says whether the
 * review moves on to the next prompt (`advance`); the memo's has no `advance`.
 */
export type PlannerAiStreamLine =
  | { d: string }
  | { done: true; advance?: boolean }
  | { error: "limited" | "failed" };

// --- Types ------------------------------------------------------------------

export type PlannerGoalLine = z.infer<typeof plannerGoalLineSchema>;
export type PlannerCreateGoalInput = z.input<typeof plannerCreateGoalSchema>;
export type PlannerUpdateGoalInput = z.input<typeof plannerUpdateGoalSchema>;
export type PlannerUpdateWeekInput = z.input<typeof plannerUpdateWeekSchema>;
export type PlannerSaveReviewStateInput = z.input<
  typeof plannerSaveReviewStateSchema
>;
export type PlannerGoalResultInput = z.input<
  typeof plannerGoalResultInputSchema
>;
export type PlannerLookBackInput = z.input<typeof plannerLookBackSchema>;
export type PlannerPlanGoalInput = z.input<typeof plannerPlanGoalSchema>;
export type PlannerPlanTaskInput = z.input<typeof plannerPlanTaskSchema>;
export type PlannerSettleFlagInput = z.input<typeof plannerSettleFlagSchema>;
export type PlannerFlagInput = z.input<typeof plannerFlagInputSchema>;
export type PlannerCommitInput = z.input<typeof plannerCommitSchema>;
export type PlannerAiOpeningInput = z.input<typeof plannerAiOpeningSchema>;
export type PlannerAiCloseInput = z.input<typeof plannerAiCloseSchema>;
export type PlannerReviewChatMessage = z.infer<
  typeof plannerReviewChatMessageSchema
>;
export type PlannerAiCoachInput = z.input<typeof plannerAiCoachSchema>;
export type PlannerAiMemoInput = z.input<typeof plannerAiMemoSchema>;
export type PlannerAiCheckInput = z.input<typeof plannerAiCheckSchema>;

export type PlannerGoalDto = z.infer<typeof plannerGoalDtoSchema>;
export type PlannerWeekDto = z.infer<typeof plannerWeekDtoSchema>;
export type PlannerGoalFlagDto = z.infer<typeof plannerGoalFlagDtoSchema>;
export type PlannerGoalResponse = z.infer<typeof plannerGoalResponseSchema>;
export type PlannerOkResponse = z.infer<typeof plannerOkResponseSchema>;
export type PlannerWeekResponse = z.infer<typeof plannerWeekResponseSchema>;
export type PlannerGoalsYearResponse = z.infer<
  typeof plannerGoalsYearResponseSchema
>;
export type PlannerCockpitWeek = z.infer<typeof plannerCockpitWeekSchema>;
export type PlannerReviewResponse = z.infer<typeof plannerReviewResponseSchema>;
export type PlannerReviewStatusResponse = z.infer<
  typeof plannerReviewStatusResponseSchema
>;
export type PlannerReviewStateResponse = z.infer<
  typeof plannerReviewStateResponseSchema
>;
export type PlannerLookBackResponse = z.infer<
  typeof plannerLookBackResponseSchema
>;
export type PlannerCommitResponse = z.infer<typeof plannerCommitResponseSchema>;
export type PlannerAiOpeningResponse = z.infer<
  typeof plannerAiOpeningResponseSchema
>;
export type PlannerAiCloseResponse = z.infer<
  typeof plannerAiCloseResponseSchema
>;
export type PlannerAiCheckResponse = z.infer<
  typeof plannerAiCheckResponseSchema
>;
