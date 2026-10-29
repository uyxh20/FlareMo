// Planning cockpit contracts: a fork-owned add-on
// (docs/planning-cockpit-implementation-plan.md, sections 3 and 4). The worker
// and the web app share this file and its siblings:
//
// - planner-periods.ts, the period maths, so a plan's period means the same thing
//   on both sides.
// - planner-board.ts, the board's rules: which column a card is in, how each
//   column is ordered and what a move to another column does.
// - This file, the HTTP API under `/api/app/planner` (see "HTTP API" below): the
//   request schemas the Worker validates and the response schemas and types it
//   sends. A sibling re-exported from here must never import this file back, or
//   it would read this file's constants too early.
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import { plannerColumns } from "./planner-board";
import { plannerCockpitWeekSchema } from "./planner-goals";
import { plannerHorizons, plannerIsValidDayKey } from "./planner-periods";
import {
  createTaskSchema,
  taskActorTypeSchema,
  taskDtoSchema,
  taskPrioritySchema,
  updateTaskSchema,
} from "./projects";

// The period maths, the board's rules and its manual order helpers live in their
// own files and are exported from here, so the package index (an upstream file)
// stays untouched. So do goals and the weekly review (migration 9005) and the
// weekly summary memo's format. None of these files imports this one back.
// The health tracker add-on (docs/fork-health-tracker.md) rides the same way.
export * from "./fork-health";
export * from "./planner-agent";
export * from "./planner-board";
export * from "./planner-goals";
export * from "./planner-period-review";
export * from "./planner-periods";
export * from "./planner-rank";
export * from "./planner-review-memo";

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
export const plannerColumnSchema = z.enum(plannerColumns);

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
  // The weekly goal the new task serves (a goal's "Add task"), linked in the same
  // request instead of a second one that could fail on its own. Checked before
  // the task is created.
  goal_id: z.uuid().nullable().optional(),
  today: plannerDaySchema,
});

/**
 * One request can carry several changes. The server applies them in a fixed
 * order, each step only when its field is present:
 *
 *   1. `dropped: false`  undrop
 *   2. title, notes, priority, due_at, project_id  through upstream's updateTask
 *   3. `column` (a column move) or else `plan`
 *   4. `effort`, `start_date` and `goal_id`  on the plan row; `null` clears any
 *   5. `dropped: true`   drop
 *
 * It is not atomic: a step that fails leaves the earlier steps applied. A
 * `column` move sets the plan itself (the move table lives on the server), so
 * sending `column` and `plan` together is a 400. `status` and `sort_order` are
 * not accepted here: move columns with `column`, reorder through `/api/app/tasks`.
 * `effort`, `start_date` and `goal_id` are planner-side fields that are not a
 * plan: setting them never moves the task, and they are allowed on a dropped task.
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
    // The weekly goal the task serves (planner_goal.id, migration 9005), or null
    // to unlink it. Written with a `goal_changed` event, as the weekly review does.
    goal_id: z.uuid().nullable().optional(),
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
  // The weekly goal the task serves, or null (migration 9005).
  goal_id: z.string().nullable(),
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
  // The weekly goal the task serves (migration 9005), or null. The id may name a
  // goal of another week, or a removed one: only this week's goals colour a card.
  goal_id: z.string().nullable(),
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
  // The week the goal cards show, with its weekly goals (migration 9005). Always
  // sent; optional so a board cached before it reads as a week with no goals.
  week: plannerCockpitWeekSchema.optional(),
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
    // The task exists, but its plan (or its goal link) could not be saved.
    plan_error: z.string().optional(),
    goal_error: z.string().optional(),
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

/**
 * Whether an archived event can be reverted from the History timeline
 * (`POST /tasks/:id/history/:eventId/revert`). The revert applies the inverse
 * change as a new event; nothing in the archive is rewritten. An event is
 * revertible when the archive holds what to put back: planner events carry
 * `from`, a status change's previous status is read from the events before it,
 * and an upstream edit's previous value from the earlier event that set that
 * field (else the field is cleared). Creating, deleting, restoring and purging
 * a task, comment edits and deletes (the text is not archived), carry-overs
 * and reverts themselves are not.
 */
export function plannerEventRevertible(
  event: Pick<PlannerEventDto, "type" | "data">,
): boolean {
  switch (event.type) {
    case "updated":
      return plannerRevertibleEditKeys.some((key) => key in event.data);
    case "status_changed":
    case "planned":
    case "replanned":
    case "unplanned":
    case "dropped":
    case "undropped":
    case "effort_changed":
    case "start_date_changed":
    case "goal_changed":
    case "commented":
      return true;
    default:
      return false;
  }
}

/** The keys of an upstream `updated` event a revert knows how to put back. */
export const plannerRevertibleEditKeys = [
  "title",
  "notes",
  "priority",
  "due_at",
  "project_id",
] as const;

export const plannerRevertEventSchema = z.strictObject({
  today: plannerDaySchema,
});

export const plannerRevertEventResponseSchema = z.object({
  task: taskDtoSchema,
  plan: plannerPlanDtoSchema.nullable(),
  /** The event that was reverted. */
  reverted: plannerEventDtoSchema,
});
export type PlannerRevertEventResponse = z.infer<
  typeof plannerRevertEventResponseSchema
>;

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

/** The goal a task belongs to. */
export const plannerTaskProjectSchema = z.object({
  // Upstream's project id.
  id: z.string(),
  name: z.string(),
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
