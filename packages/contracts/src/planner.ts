// Planning cockpit contracts: a fork-owned add-on
// (docs/planning-cockpit-implementation-plan.md, sections 3 and 4). The worker
// and the web app share this file in two parts.
//
// Part 1, the period maths, so a plan's period means the same thing on both
// sides:
// - A day is a `YYYY-MM-DD` key, the calendar day as the person sees it. It is
//   parsed as UTC midnight and read back with UTC getters only, so nothing here
//   depends on the machine's time zone or on daylight saving changes.
// - Weeks start on Monday, everywhere.
// - Years run from 0001 to 9999. Every period start of a valid day is valid
//   (0001-01-01 is a Monday); the one result that cannot be written, the period
//   after 9999, throws a RangeError.
//
// Part 2, the HTTP API under `/api/app/planner` (see "HTTP API" below): the
// request schemas the Worker validates and the response schemas and types it
// sends. It lives in this file, not a sibling, because a sibling re-exported
// from here would import this file back and read its constants too early.
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import {
  createTaskSchema,
  projectStatusSchema,
  taskActorTypeSchema,
  taskDtoSchema,
  taskPrioritySchema,
  updateTaskSchema,
} from "./projects";

// The board's manual order helpers live in their own file and are exported from
// here, so the package index (an upstream file) stays untouched.
export * from "./planner-rank";

export const plannerHorizons = ["day", "week", "month"] as const;

export type PlannerHorizon = (typeof plannerHorizons)[number];

/**
 * A level is a short lowercase slug (area, year, quarter, goal, milestone, ...)
 * rather than an enum, so adding one needs no schema change.
 */
export const plannerLevelPattern = /^[a-z][a-z0-9-]{0,23}$/;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** UTC midnight of a real calendar day, or undefined for anything else. */
function parseDayKey(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY_KEY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return undefined;
  // Not Date.UTC, which maps the years 0 to 99 onto 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // An impossible day (30 February, month 13) rolls over instead of failing, so
  // accept it only when it reads back unchanged.
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
  const date = parseDayKey(value);
  if (!date) {
    throw new RangeError(`Expected a YYYY-MM-DD day, got ${String(value)}`);
  }
  return date;
}

function formatDayKey(date: Date): string {
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

/** Moves a UTC-midnight date back to the first day of its period, in place. */
function toPeriodStart(horizon: PlannerHorizon, date: Date): Date {
  switch (horizon) {
    case "day":
      return date;
    case "week":
      // getUTCDay is 0 for Sunday, so this counts days since Monday.
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      return date;
    case "month":
      date.setUTCDate(1);
      return date;
    default:
      throw new RangeError(`Unknown planner horizon: ${String(horizon)}`);
  }
}

/** True for a real calendar day written as `YYYY-MM-DD` (years 0001 to 9999). */
export function plannerIsValidDayKey(value: unknown): value is string {
  return parseDayKey(value) !== undefined;
}

/**
 * The first day of the period that contains `dayKey`: the day itself, the
 * Monday on or before it, or the 1st of its month. Throws a RangeError when
 * `dayKey` is not a valid day or `horizon` is unknown, so a bad value can never
 * be written as a period start.
 */
export function plannerPeriodStart(
  horizon: PlannerHorizon,
  dayKey: string,
): string {
  return formatDayKey(toPeriodStart(horizon, requireDay(dayKey)));
}

/**
 * The first day of the period after the one that contains `periodStart`. The
 * input is normally a period start already; any other day is first moved to its
 * own period start. Throws like `plannerPeriodStart`, and for the period after
 * 9999.
 */
export function plannerNextPeriodStart(
  horizon: PlannerHorizon,
  periodStart: string,
): string {
  const next = toPeriodStart(horizon, requireDay(periodStart));
  switch (horizon) {
    case "day":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "week":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "month":
      // Already the 1st, so the month step cannot overflow.
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return formatDayKey(next);
}

/**
 * Whether the client's idea of "today" is plausible: within one day of the
 * server's UTC date. Local dates around the world span UTC-12 to UTC+14, so
 * they are always within a day of the UTC date. Anything else is a wrong clock
 * or a bad request. `serverNow` is a Date or epoch milliseconds.
 */
export function plannerTodayWithinBounds(
  clientToday: unknown,
  serverNow: Date | number,
): boolean {
  const client = parseDayKey(clientToday);
  if (!client) return false;
  const now = serverNow instanceof Date ? serverNow.getTime() : serverNow;
  if (!Number.isFinite(now)) return false;
  const serverDay = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  return Math.abs(client.getTime() - serverDay) <= MS_PER_DAY;
}

/** True for a valid goal-tree level slug: `^[a-z][a-z0-9-]{0,23}$`. */
export function plannerIsValidLevel(value: unknown): value is string {
  return typeof value === "string" && plannerLevelPattern.test(value);
}

/**
 * The horizon a To Do task carries (v1.2, docs/planning-cockpit-implementation-plan.md,
 * section 13.x). The cockpit has no periods any more, but a To Do task still needs
 * a plan row to tell it from the backlog, so every move into To Do plans it for
 * today with this horizon. Nothing shows it and rollover never moves it.
 */
export const plannerTodoHorizon = "day" as const satisfies PlannerHorizon;

/** The plan a To Do task gets on the way in: today, with `plannerTodoHorizon`. */
export function plannerTodoMarker(today: string): PlannerPlanInput {
  return { horizon: plannerTodoHorizon, day: today };
}

// A due date is a bare `YYYY-MM-DD`, but a legacy row can carry a time after it
// (upstream's own `nextDayKey` says as much), so the day is read off the front.
const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;

/**
 * The calendar quarter a task falls in, written like "Q4 2026": the quarter of
 * its start date when it has one, otherwise of its due date, otherwise null. The
 * task panel shows it as a read-only property, so a task that starts or is due
 * in a quarter is grouped that way without anyone filling it in.
 *
 * Quarters are calendar quarters (January to March is Q1) and the maths is
 * UTC-only, like every other day maths here. A value that is not a real day (an
 * empty string, 30 February, a bare month) counts as absent, so a damaged start
 * date falls back to the due date instead of producing a wrong label.
 */
export function plannerQuarterLabel(input: {
  startDate?: string | null;
  dueAt?: string | null;
}): string | null {
  for (const value of [input.startDate, input.dueAt]) {
    const key = typeof value === "string" ? DAY_PREFIX.exec(value)?.[1] : null;
    const date = key ? parseDayKey(key) : undefined;
    if (date) {
      const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
      return `Q${quarter} ${String(date.getUTCFullYear()).padStart(4, "0")}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP API: /api/app/planner
// ---------------------------------------------------------------------------
//
// Every route is JSON and authenticated like `/api/app/tasks`: a cookie session
// (state-changing requests must carry FlareMo's Origin) or a `memos_pat_` PAT.
//
//   GET    /board?today&done_days&include_dropped  PlannerBoardResponse
//   POST   /rollover                               PlannerRolloverResponse
//   POST   /tasks                                  201 PlannerCreateTaskResponse
//   GET    /tasks/:id                              PlannerTaskDetailResponse
//   PATCH  /tasks/:id                              PlannerTaskPlanResponse
//   GET    /tasks/:id/history                      PlannerTaskHistoryResponse
//   GET    /tasks/:id/comments                     PlannerCommentListResponse
//   POST   /tasks/:id/comments                     201 PlannerCommentResponse
//   PATCH  /comments/:id                           PlannerCommentResponse
//   DELETE /comments/:id                           PlannerDeleteCommentResponse
//   GET    /history?from&to                        PlannerHistoryRangeResponse
//   GET    /tree                                   PlannerTreeResponse
//   PATCH  /tree/:projectId                        PlannerTreeNodeResponse
//   GET    /tree/:projectId/rollup?from&to         PlannerRollupResponse
//
// `today` is the client's local date. The server accepts it only within one day
// of its own UTC date (`plannerTodayWithinBounds`) and answers 400 otherwise;
// that check needs the server's clock, so it is the route's job, not a schema's.
//
// Request bodies reject keys they do not know (a typo or an upstream-only field
// such as `status` is a 400, never a silent no-op). Query strings ignore extras.
// A shape error is a 400 in the validator's own envelope; a domain error is
// `{ error: { message } }` with 400, 404 or 409.

// --- Shared fields ----------------------------------------------------------

export const plannerHorizonSchema = z.enum(plannerHorizons);

/** The four columns a card can be moved to. */
export const plannerColumnSchema = z.enum(["backlog", "todo", "doing", "done"]);

/** A real calendar day written as `YYYY-MM-DD` (never trimmed or coerced). */
export const plannerDaySchema = z
  .string()
  .refine(plannerIsValidDayKey, "Expected a real YYYY-MM-DD date.");

/** Whether the history archive is being kept up to date. */
export const plannerHistoryStatusSchema = z.enum(["ok", "paused"]);

/** Where a task is planned: any day inside the period, plus the period's size. */
export const plannerPlanInputSchema = z.strictObject({
  horizon: plannerHorizonSchema,
  day: plannerDaySchema,
});

// --- Request schemas --------------------------------------------------------

export const plannerBoardQuerySchema = z.object({
  today: plannerDaySchema,
  // Digits only: `z.coerce.number()` would read an empty value as 0, which
  // silently hides the Done column. The range is checked by the domain (400).
  done_days: z
    .string()
    .regex(/^\d+$/, "Expected a whole number of days.")
    .transform(Number)
    .optional(),
  // stringbool, not coerce: coerce.boolean() maps the string "false" to true.
  include_dropped: z.stringbool().default(false),
});

export const plannerRolloverSchema = z.strictObject({
  today: plannerDaySchema,
});

/** The largest effort estimate. */
export const plannerEffortMax = 999;

/**
 * An effort estimate: a number from 0 to 999 with at most one decimal place
 * (3, 0.5, 12.3). `0` is an estimate, not the same as none; a request clears
 * the estimate with `null`. The tolerance is for binary floats: 1.1 * 10 is
 * 11.000000000000002.
 */
export const plannerEffortSchema = z
  .number()
  .min(0)
  .max(plannerEffortMax)
  .refine(
    (value) => Math.abs(value * 10 - Math.round(value * 10)) <= 1e-9,
    "Expected at most one decimal place.",
  );

/** The longest comment, in characters (UTF-16 code units, which is what zod counts). */
export const plannerCommentBodyMax = 5000;

/** A comment's text: trimmed, then 1 to 5000 characters. */
export const plannerCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(plannerCommentBodyMax);

/**
 * `column` says where the new task lands, the way a column's "+" button does:
 *
 *   backlog   no plan (a plan is a 400)
 *   todo      status `todo`; a plan is required (a 400 without one)
 *   doing     status `in_progress`; the plan is optional
 *   done      status `done`; the plan is optional
 *
 * Without it the task is `todo`, planned when `plan` is given, as before. The
 * rule that To Do needs a plan and Backlog refuses one is the domain's, so it
 * answers in the domain's envelope.
 */
export const plannerCreateTaskSchema = z.strictObject({
  title: createTaskSchema.shape.title,
  notes: createTaskSchema.shape.notes,
  priority: taskPrioritySchema.optional(),
  due_at: createTaskSchema.shape.due_at,
  project_id: createTaskSchema.shape.project_id,
  column: plannerColumnSchema.optional(),
  // Omitted or null: the task lands in the backlog (unless `column` says To Do,
  // Doing or Done, which then carry their own rules).
  plan: plannerPlanInputSchema.nullable().optional(),
  today: plannerDaySchema,
});

/**
 * One request can carry several changes. The server applies them in a fixed
 * order, each step only when its field is present:
 *
 *   1. `dropped: false`  undrop
 *   2. title, notes, priority, due_at, project_id  through upstream's updateTask
 *   3. `column` (a column move) or else `plan`
 *   4. `effort` and `start_date`  on the plan row; `null` clears either
 *   5. `dropped: true`   drop
 *
 * It is not atomic: a step that fails leaves the earlier steps applied. A
 * `column` move sets the plan itself (the move table lives on the server), so
 * sending `column` and `plan` together is a 400. `status` and `sort_order` are
 * not accepted here: move columns with `column`, reorder through `/api/app/tasks`.
 * `effort` and `start_date` are planner-side fields that are not a plan: setting
 * them never moves the task, and they are allowed on a dropped task.
 */
const plannerTaskIdSchema = z.string().trim().min(1).max(256);

export const plannerUpdateTaskSchema = z
  .strictObject({
    today: plannerDaySchema,
    column: plannerColumnSchema.optional(),
    plan: plannerPlanInputSchema.nullable().optional(),
    effort: plannerEffortSchema.nullable().optional(),
    // The start day, YYYY-MM-DD, or null to clear it (v1.2, migration 9002).
    start_date: plannerDaySchema.nullable().optional(),
    // Where in `column` the card goes (migration 9004): between two cards of that
    // column. `before_id` is the card that will sit directly BELOW it, `after_id`
    // the one directly ABOVE it (ids of cards in the target column, as the board
    // lists them). With neither, a move keeps today's behaviour and writes no
    // order. Both need `column`. This is a column move's second half and never
    // writes a history event of its own.
    before_id: plannerTaskIdSchema.optional(),
    after_id: plannerTaskIdSchema.optional(),
    dropped: z.boolean().optional(),
    title: updateTaskSchema.shape.title,
    notes: updateTaskSchema.shape.notes,
    priority: updateTaskSchema.shape.priority,
    due_at: updateTaskSchema.shape.due_at,
    project_id: updateTaskSchema.shape.project_id,
  })
  .refine((value) => value.column === undefined || value.plan === undefined, {
    message:
      "Send either column or plan, not both: a column move sets the plan itself.",
    path: ["column"],
  })
  .refine(
    (value) =>
      (value.before_id === undefined && value.after_id === undefined) ||
      value.column !== undefined,
    {
      message: "before_id and after_id need column: they place a card in it.",
      path: ["column"],
    },
  )
  .refine(
    (value) =>
      value.before_id === undefined ||
      value.after_id === undefined ||
      value.before_id !== value.after_id,
    {
      message: "before_id and after_id must be different cards.",
      path: ["after_id"],
    },
  )
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, field]) => key !== "today" && field !== undefined,
      ),
    "At least one field besides today must be updated.",
  );

/** A new comment on a task. The server trims the text and stores 1 to 5000 characters. */
export const plannerCreateCommentSchema = z.strictObject({
  body: plannerCommentBodySchema,
});

/** The new text of a comment, under the same rules as a new one. */
export const plannerUpdateCommentSchema = z.strictObject({
  body: plannerCommentBodySchema,
});

export const plannerHistoryRangeQuerySchema = z
  .object({ from: plannerDaySchema, to: plannerDaySchema })
  .refine(({ from, to }) => from <= to, "`from` must not be after `to`.");

export const plannerRollupQuerySchema = plannerHistoryRangeQuerySchema;

/**
 * An omitted field is unchanged and `null` clears it (a null parent makes the
 * project a root). `sort_order` has no null: it is always a whole number.
 */
export const plannerUpdateTreeNodeSchema = z
  .strictObject({
    parent_project_id: z.string().trim().min(1).max(256).nullable().optional(),
    level: z
      .string()
      .regex(
        plannerLevelPattern,
        "Expected a lowercase slug of up to 24 characters, such as area, quarter or goal.",
      )
      .nullable()
      .optional(),
    period_start: plannerDaySchema.nullable().optional(),
    period_end: plannerDaySchema.nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one field must be updated.",
  );

// --- Response schemas -------------------------------------------------------
//
// These describe exactly what the Worker sends. Dates and timestamps are plain
// strings: a day is `YYYY-MM-DD`, a timestamp an ISO instant.

/** A task's plan row. A task that was never planned has no row (`plan: null`). */
export const plannerPlanDtoSchema = z.object({
  task_id: z.string(),
  // Null means the backlog; `period_start` is null exactly when this is.
  horizon: plannerHorizonSchema.nullable(),
  period_start: z.string().nullable(),
  // How often rollover moved the plan forward because the task was unfinished.
  carry_count: z.number().int().nonnegative(),
  // Set while the task is dropped, whatever its status.
  dropped_at: z.string().nullable(),
  // The effort estimate, 0 to 999 with at most one decimal; null when unset. A
  // plan row can exist only to hold it, with a null horizon (the backlog).
  effort: z.number().nullable(),
  // The start day, YYYY-MM-DD, or null. Held the same way as the effort.
  start_date: z.string().nullable(),
  // The stored board order, `<column>|<key>`, or null (migration 9004). Read it
  // with `plannerParseBoardRank`, which drops a rank left over from another column.
  board_rank: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * A task as the board shows it: upstream's own fields (never `notes`), its
 * project's name and its plan, flattened. A task with no plan row has a null
 * horizon, a 0 `carry_count` and no `dropped_at`.
 */
export const plannerBoardCardSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  title: z.string(),
  // Upstream's status. A value outside todo, in_progress and done lands in the
  // board's `other` column, which is why these are strings and not enums.
  status: z.string(),
  priority: z.string(),
  due_at: z.string().nullable(),
  sort_order: z.number().int(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  horizon: plannerHorizonSchema.nullable(),
  period_start: z.string().nullable(),
  carry_count: z.number().int().nonnegative(),
  dropped_at: z.string().nullable(),
  // The start day, YYYY-MM-DD, or null. The card shows it with the due date.
  start_date: z.string().nullable(),
  // The card's manual place in its column as a bare key (see plannerRankBetween),
  // or null when it was never ranked or the rank belongs to another column.
  // Ranked cards come first, in key order; the rest follow in the column's old order.
  board_rank: z.string().nullable(),
});

export const plannerBoardResponseSchema = z.object({
  columns: z.object({
    backlog: z.array(plannerBoardCardSchema),
    todo: z.array(plannerBoardCardSchema),
    doing: z.array(plannerBoardCardSchema),
    done: z.array(plannerBoardCardSchema),
    // Tasks with a status upstream does not list. Usually empty.
    other: z.array(plannerBoardCardSchema),
    // Present only when the request set `include_dropped`.
    dropped: z.array(plannerBoardCardSchema).optional(),
  }),
  today: z.string(),
  // The first day of the current period for each horizon.
  periods: z.object({ day: z.string(), week: z.string(), month: z.string() }),
  history: plannerHistoryStatusSchema,
  // True when the 500 card cap cut Backlog, Done or Dropped cards.
  truncated: z.boolean(),
});

export const plannerRolloverResponseSchema = z.object({
  history: plannerHistoryStatusSchema,
  // How many plans moved forward this run.
  carried: z.number().int().nonnegative(),
});

/** What a task change hands back: the task as upstream has it, and its plan. */
export const plannerTaskPlanResponseSchema = z.object({
  task: taskDtoSchema,
  plan: plannerPlanDtoSchema.nullable(),
});

/**
 * Create answers 201. When the task was created but its plan could not be
 * saved, `plan` is null and `plan_error` says so: the card is in the backlog
 * and the client can offer to retry the plan.
 */
export const plannerCreateTaskResponseSchema =
  plannerTaskPlanResponseSchema.extend({
    plan_error: z.string().optional(),
  });

/**
 * An archived event. `type` is upstream's activity `action` for source
 * `activity` (`created`, `updated`, `status_changed`, ...), `deleted`,
 * `restored`, `purged` or `created` for source `sync`, and `planned`,
 * `replanned`, `unplanned`, `carried_over`, `dropped` or `undropped` for source
 * `planner`.
 */
export const plannerEventDtoSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  // The title when the event was archived; the task may be gone since.
  task_title: z.string().nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  source: z.enum(["activity", "sync", "planner"]),
  actor_type: taskActorTypeSchema.nullable(),
  actor_name: z.string().nullable(),
  // When it happened (the source timestamp), not when it was archived.
  occurred_at: z.string(),
  created_at: z.string(),
});

export const plannerTaskHistoryResponseSchema = z.object({
  // Newest first.
  events: z.array(plannerEventDtoSchema),
});

/** A comment on a task. Its text never appears in the history archive. */
export const plannerCommentDtoSchema = z.object({
  // A random UUID, not namespaced.
  id: z.string(),
  // Upstream's task id, namespaced (`tasks/<id>`), like every other task id.
  task_id: z.string(),
  body: z.string(),
  created_at: z.string(),
  // Later than `created_at` once the comment has been edited.
  updated_at: z.string(),
});

/** The goal a task belongs to, and the path of goals above it. */
export const plannerTaskProjectSchema = z.object({
  // Upstream's project id.
  id: z.string(),
  name: z.string(),
  // The goals above it in the tree, root first, ending with its own parent;
  // empty for a root or a project with no node row.
  ancestors: z.array(z.object({ id: z.string(), name: z.string() })),
});

/**
 * Everything the task panel shows for one task. Unlike a board card it has the
 * whole upstream task, `notes` included.
 */
export const plannerTaskDetailResponseSchema = z.object({
  task: taskDtoSchema,
  // Null for a task that never had a plan row. A row can exist with a null
  // horizon only to hold the effort estimate.
  plan: plannerPlanDtoSchema.nullable(),
  // Null when the task has no project.
  project: plannerTaskProjectSchema.nullable(),
  // Oldest first, without the deleted ones.
  comments: z.array(plannerCommentDtoSchema),
});

export const plannerCommentListResponseSchema = z.object({
  // Oldest first.
  comments: z.array(plannerCommentDtoSchema),
});

export const plannerCommentResponseSchema = z.object({
  comment: plannerCommentDtoSchema,
});

export const plannerDeleteCommentResponseSchema = z.object({
  ok: z.literal(true),
});

export const plannerHistoryRangeResponseSchema = z.object({
  // Newest first, for the UTC days `from` to `to` inclusive.
  events: z.array(plannerEventDtoSchema),
  // True when more events matched than were returned; the oldest are cut.
  truncated: z.boolean(),
});

/** A project merged with its goal-tree node. */
export const plannerTreeNodeDtoSchema = z.object({
  // Upstream's project id.
  id: z.string(),
  name: z.string(),
  status: projectStatusSchema,
  // Null for a root, and also for a child whose parent is in the recycle bin.
  parent_project_id: z.string().nullable(),
  // A slug such as `area`, `year`, `quarter`, `goal` or `milestone`.
  level: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  sort_order: z.number().int(),
});

export const plannerTreeResponseSchema = z.object({
  // A flat list ordered by sort_order, then creation; build the tree from
  // `parent_project_id`.
  nodes: z.array(plannerTreeNodeDtoSchema),
});

export const plannerTreeNodeResponseSchema = z.object({
  node: plannerTreeNodeDtoSchema,
});

const plannerRollupCountsShape = {
  // Live tasks that are not done (todo, in progress or an unknown status).
  open_tasks: z.number().int().nonnegative(),
  done_tasks: z.number().int().nonnegative(),
  // Tasks whose plan period starts inside the range.
  planned_in_range: z.number().int().nonnegative(),
  // Tasks completed inside the range.
  done_in_range: z.number().int().nonnegative(),
  // `carried_over` events inside the range.
  carried_in_range: z.number().int().nonnegative(),
};

export const plannerRollupCountsSchema = z.object(plannerRollupCountsShape);

export const plannerRollupNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_project_id: z.string().nullable(),
  level: z.string().nullable(),
  // 0 for the project the roll-up was asked for.
  depth: z.number().int().nonnegative(),
  ...plannerRollupCountsShape,
});

/** Not wrapped in a key: the body is the roll-up itself. */
export const plannerRollupResponseSchema = z.object({
  project_id: z.string(),
  from: z.string(),
  to: z.string(),
  // The project and everything under it, parents before children.
  nodes: z.array(plannerRollupNodeSchema),
  // The counts summed over `nodes`.
  total: plannerRollupCountsSchema,
});

// --- Types ------------------------------------------------------------------

export type PlannerColumn = z.infer<typeof plannerColumnSchema>;
export type PlannerHistoryStatus = z.infer<typeof plannerHistoryStatusSchema>;
export type PlannerPlanInput = z.infer<typeof plannerPlanInputSchema>;

// Requests. Body types are the pre-parse shape a client builds. Query types are
// the parsed values (numbers and booleans); the URL carries them as strings.
export type PlannerBoardQuery = z.output<typeof plannerBoardQuerySchema>;
export type PlannerRolloverInput = z.input<typeof plannerRolloverSchema>;
export type PlannerCreateTaskInput = z.input<typeof plannerCreateTaskSchema>;
export type PlannerUpdateTaskInput = z.input<typeof plannerUpdateTaskSchema>;
export type PlannerCreateCommentInput = z.input<
  typeof plannerCreateCommentSchema
>;
export type PlannerUpdateCommentInput = z.input<
  typeof plannerUpdateCommentSchema
>;
export type PlannerHistoryRangeQuery = z.output<
  typeof plannerHistoryRangeQuerySchema
>;
export type PlannerRollupQuery = z.output<typeof plannerRollupQuerySchema>;
export type PlannerUpdateTreeNodeInput = z.input<
  typeof plannerUpdateTreeNodeSchema
>;

// Responses.
export type PlannerPlanDto = z.infer<typeof plannerPlanDtoSchema>;
export type PlannerBoardCard = z.infer<typeof plannerBoardCardSchema>;
export type PlannerBoardResponse = z.infer<typeof plannerBoardResponseSchema>;
export type PlannerRolloverResponse = z.infer<
  typeof plannerRolloverResponseSchema
>;
export type PlannerTaskPlanResponse = z.infer<
  typeof plannerTaskPlanResponseSchema
>;
export type PlannerCreateTaskResponse = z.infer<
  typeof plannerCreateTaskResponseSchema
>;
export type PlannerEventDto = z.infer<typeof plannerEventDtoSchema>;
export type PlannerTaskHistoryResponse = z.infer<
  typeof plannerTaskHistoryResponseSchema
>;
export type PlannerCommentDto = z.infer<typeof plannerCommentDtoSchema>;
export type PlannerTaskProject = z.infer<typeof plannerTaskProjectSchema>;
export type PlannerTaskDetailResponse = z.infer<
  typeof plannerTaskDetailResponseSchema
>;
export type PlannerCommentListResponse = z.infer<
  typeof plannerCommentListResponseSchema
>;
export type PlannerCommentResponse = z.infer<
  typeof plannerCommentResponseSchema
>;
export type PlannerDeleteCommentResponse = z.infer<
  typeof plannerDeleteCommentResponseSchema
>;
export type PlannerHistoryRangeResponse = z.infer<
  typeof plannerHistoryRangeResponseSchema
>;
export type PlannerTreeNodeDto = z.infer<typeof plannerTreeNodeDtoSchema>;
export type PlannerTreeResponse = z.infer<typeof plannerTreeResponseSchema>;
export type PlannerTreeNodeResponse = z.infer<
  typeof plannerTreeNodeResponseSchema
>;
export type PlannerRollupCounts = z.infer<typeof plannerRollupCountsSchema>;
export type PlannerRollupNode = z.infer<typeof plannerRollupNodeSchema>;
export type PlannerRollupResponse = z.infer<typeof plannerRollupResponseSchema>;
