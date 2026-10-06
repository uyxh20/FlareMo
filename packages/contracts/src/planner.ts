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

// ---------------------------------------------------------------------------
// HTTP API: /api/app/planner
// ---------------------------------------------------------------------------
//
// Every route is JSON and authenticated like `/api/app/tasks`: a cookie session
// (state-changing requests must carry FlareMo's Origin) or a `memos_pat_` PAT.
//
//   GET   /board?today&done_days&include_dropped  PlannerBoardResponse
//   POST  /rollover                               PlannerRolloverResponse
//   POST  /tasks                                  201 PlannerCreateTaskResponse
//   PATCH /tasks/:id                              PlannerTaskPlanResponse
//   GET   /tasks/:id/history                      PlannerTaskHistoryResponse
//   GET   /history?from&to                        PlannerHistoryRangeResponse
//   GET   /tree                                   PlannerTreeResponse
//   PATCH /tree/:projectId                        PlannerTreeNodeResponse
//   GET   /tree/:projectId/rollup?from&to         PlannerRollupResponse
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

export const plannerCreateTaskSchema = z.strictObject({
  title: createTaskSchema.shape.title,
  notes: createTaskSchema.shape.notes,
  priority: taskPrioritySchema.optional(),
  due_at: createTaskSchema.shape.due_at,
  project_id: createTaskSchema.shape.project_id,
  // Omitted or null: the task lands in the backlog.
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
 *   4. `dropped: true`   drop
 *
 * It is not atomic: a step that fails leaves the earlier steps applied. A
 * `column` move sets the plan itself (the move table lives on the server), so
 * sending `column` and `plan` together is a 400. `status` and `sort_order` are
 * not accepted here: move columns with `column`, reorder through `/api/app/tasks`.
 */
export const plannerUpdateTaskSchema = z
  .strictObject({
    today: plannerDaySchema,
    column: plannerColumnSchema.optional(),
    plan: plannerPlanInputSchema.nullable().optional(),
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
      Object.entries(value).some(
        ([key, field]) => key !== "today" && field !== undefined,
      ),
    "At least one field besides today must be updated.",
  );

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
