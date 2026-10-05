import {
  type PlannerHorizon,
  plannerHorizons,
  plannerPeriodStart,
  type TaskDto,
  type TaskPriority,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import {
  type PlannerTaskPlanRow,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import { createTask, getTask, updateTask } from "../tasks";
import {
  type PlannerColumn,
  plannerColumnFor,
  plannerHasPlan,
  plannerIsColumn,
} from "./columns";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// Plans, drops and column moves (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4).
//
// Every planner-table change is written in the SAME D1 batch as its planner
// event (M3). Task rows change only through upstream's services (M1): status
// and due date go through `updateTask`, so upstream logs its own activity and
// the next history sync archives it.
//
// These functions take a `UserRow`, not just an id, because upstream's
// `createTask` / `updateTask` / `getTask` do. A route passes the `user` and
// `actor` it already has, exactly as tasks-api.ts does.

/** Where a task is planned: any day inside the period, plus the period's size. */
export type PlannerPlanInput = { horizon: PlannerHorizon; day: string };

/** A plan row as the routes return it. */
export type PlannerPlanDto = {
  task_id: string;
  /** NULL means the backlog. `period_start` is NULL exactly when this is. */
  horizon: PlannerHorizon | null;
  period_start: string | null;
  /** How often rollover moved the plan forward because the task was unfinished. */
  carry_count: number;
  /** Set while the task is dropped, whatever its status. */
  dropped_at: string | null;
  created_at: string;
  updated_at: string;
};

export function plannerPlanToDto(row: PlannerTaskPlanRow): PlannerPlanDto {
  return {
    task_id: row.taskId,
    horizon: row.horizon,
    period_start: row.periodStart,
    carry_count: row.carryCount,
    dropped_at: row.droppedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** What a plan-changing function hands back for the route to serialise. */
export type PlannerTaskPlanResult = {
  task: TaskDto;
  plan: PlannerPlanDto | null;
};

type ResolvedPlan = { horizon: PlannerHorizon; periodStart: string };

/** `{horizon, period_start}`, the shape the plan events store in `data`. */
type PlanPoint = {
  horizon: PlannerHorizon | null;
  period_start: string | null;
};

const DROPPED_MESSAGE = "The task is dropped. Undrop it first.";

/** Shown to the client when the plan could not be saved; details go to the log. */
const PLAN_ERROR_MESSAGE = "The plan could not be saved.";

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

/** One of the caller's live tasks, or a 404 like upstream's `requireTask`. */
async function loadLiveTask(db: FlareMoDb, userId: string, taskId: string) {
  const row = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.userId, userId),
        isNull(tasks.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`Task not found: ${taskId}`);
  return row;
}

async function loadPlan(
  db: FlareMoDb,
  userId: string,
  taskId: string,
): Promise<PlannerTaskPlanRow | undefined> {
  return db
    .select()
    .from(plannerTaskPlan)
    .where(
      and(
        eq(plannerTaskPlan.taskId, taskId),
        eq(plannerTaskPlan.userId, userId),
      ),
    )
    .get();
}

/**
 * Checks a requested plan and turns it into a period. The horizon and day are
 * validated before any period maths, which throws RangeError on bad input, and
 * a plan cannot start before the period that contains `today`.
 */
function resolvePlan(plan: PlannerPlanInput, today: string): ResolvedPlan {
  if (!(plannerHorizons as readonly unknown[]).includes(plan?.horizon)) {
    throw new ValidationError("horizon must be day, week or month.");
  }
  const day = plannerRequireDay(plan.day, "day");
  const periodStart = plannerPeriodStart(plan.horizon, day);
  if (periodStart < plannerPeriodStart(plan.horizon, today)) {
    throw new ValidationError("A plan cannot start before the current period.");
  }
  return { horizon: plan.horizon, periodStart };
}

function pointOf(plan: PlannerTaskPlanRow | undefined): PlanPoint {
  return plannerHasPlan(plan) && plan
    ? { horizon: plan.horizon, period_start: plan.periodStart }
    : { horizon: null, period_start: null };
}

function assertNotDropped(plan: PlannerTaskPlanRow | undefined): void {
  if (plan?.droppedAt) throw new ValidationError(DROPPED_MESSAGE);
}

type PlanEventType = "planned" | "replanned" | "unplanned";

/** The event a plan change produces, or null when nothing would change. */
function transitionOf(
  existing: PlannerTaskPlanRow | undefined,
  next: ResolvedPlan | null,
): PlanEventType | null {
  const had = plannerHasPlan(existing);
  if (next === null) return had ? "unplanned" : null;
  if (!had) return "planned";
  return existing?.horizon === next.horizon &&
    existing.periodStart === next.periodStart
    ? null
    : "replanned";
}

/**
 * Sets, moves or clears a task's plan and writes the matching event in the same
 * batch. Returns the event type, or null when the plan already was that way.
 * `carry_count` is never touched here: only rollover moves it.
 */
async function writePlanChange(
  db: FlareMoDb,
  input: {
    userId: string;
    actor: PlannerActor;
    task: { id: string; title: string };
    existing: PlannerTaskPlanRow | undefined;
    next: ResolvedPlan | null;
    now: Date;
  },
): Promise<PlanEventType | null> {
  const type = transitionOf(input.existing, input.next);
  if (type === null) return null;
  const nowIso = input.now.toISOString();
  const horizon = input.next?.horizon ?? null;
  const periodStart = input.next?.periodStart ?? null;
  await plannerRunBatch(db, [
    db
      .insert(plannerTaskPlan)
      .values({
        taskId: input.task.id,
        userId: input.userId,
        horizon,
        periodStart,
        carryCount: 0,
        droppedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: plannerTaskPlan.taskId,
        set: { horizon, periodStart, updatedAt: nowIso },
      }),
    plannerEventStatement(db, {
      userId: input.userId,
      taskId: input.task.id,
      taskTitle: input.task.title,
      type,
      data: {
        from: pointOf(input.existing),
        to: { horizon, period_start: periodStart } satisfies PlanPoint,
      },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return type;
}

async function resultFor(
  db: FlareMoDb,
  user: UserRow,
  taskId: string,
): Promise<PlannerTaskPlanResult> {
  const [task, plan] = await Promise.all([
    getTask(db, user, taskId),
    loadPlan(db, user.id, taskId),
  ]);
  return { task, plan: plan ? plannerPlanToDto(plan) : null };
}

/**
 * A live task and its plan, read back without changing anything. Upstream's
 * `updateTask` returns only the task, so a route that has just edited task
 * fields (and no plan) calls this to answer with the plan as well. A task that
 * is missing, deleted or someone else's is a 404, like upstream's `getTask`.
 */
export async function plannerReadTaskPlan(
  db: FlareMoDb,
  input: { user: UserRow; taskId: string },
): Promise<PlannerTaskPlanResult> {
  return resultFor(db, input.user, plannerNormalizeTaskId(input.taskId));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Creates a task through upstream's `createTask` (status `todo`) and, when a
 * plan is given, writes the plan and its `planned` event in one batch.
 *
 * A bad plan is rejected BEFORE the task exists. If the plan batch itself then
 * fails, the task is still created and the result carries `plan: null` and a
 * `planError`, so the card lands in the backlog and can offer "Retry plan".
 * `today` is required whenever `plan` is given.
 *
 * The `planned` event is stamped AFTER `createTask` returns, unless the caller
 * passes `now`. Upstream stamps its own `created` activity while it runs, so a
 * clock read before the call put `planned` a few milliseconds earlier than
 * `created` and the history listed the plan before the task existed.
 */
export async function plannerCreateTask(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    title: string;
    notes?: string;
    priority?: TaskPriority;
    dueAt?: string;
    projectId?: string;
    plan?: PlannerPlanInput | null;
    today?: string;
    now?: Date;
  },
): Promise<{ task: TaskDto; plan: PlannerPlanDto | null; planError?: string }> {
  let resolved: ResolvedPlan | null = null;
  if (input.plan) {
    if (input.today === undefined) {
      throw new ValidationError("today is required with a plan.");
    }
    resolved = resolvePlan(input.plan, plannerRequireDay(input.today, "today"));
  }

  const task = await createTask(db, input.user, input.actor, {
    title: input.title,
    notes: input.notes,
    priority: input.priority,
    due_at: input.dueAt,
    project_id: input.projectId,
    status: "todo",
  });
  if (!resolved) return { task, plan: null };

  // Read the clock only now: `createTask` has finished, so its `created`
  // activity is already stamped and this event can never sort before it.
  const now = plannerNow(input.now);
  try {
    await writePlanChange(db, {
      userId: input.user.id,
      actor: input.actor,
      task: { id: task.id, title: task.title },
      existing: undefined,
      next: resolved,
      now,
    });
    const plan = await loadPlan(db, input.user.id, task.id);
    return { task, plan: plan ? plannerPlanToDto(plan) : null };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Planner plan write failed after the task was created",
        task: task.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { task, plan: null, planError: PLAN_ERROR_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// Plan, replan, unplan
// ---------------------------------------------------------------------------

/**
 * Plans a task (`plan` given) or sends it back to the backlog (`plan: null`),
 * writing a `planned`, `replanned` or `unplanned` event with `{from, to}`. A
 * request that changes nothing writes nothing. A dropped task must be undropped
 * first.
 */
export async function plannerSetPlan(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    plan: PlannerPlanInput | null;
    today: string;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult> {
  const today = plannerRequireDay(input.today, "today");
  const next = input.plan === null ? null : resolvePlan(input.plan, today);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  assertNotDropped(existing);

  await writePlanChange(db, {
    userId: input.user.id,
    actor: input.actor,
    task,
    existing,
    next,
    now: plannerNow(input.now),
  });
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Drop and undrop
// ---------------------------------------------------------------------------

/**
 * Drops a task: `dropped_at` is set, the plan is kept, and the `dropped` event
 * stores `previous_due_at`, the only reliable record of the due date this
 * clears. The due date is then cleared through upstream's `updateTask` so a
 * dropped task stops sending overdue alerts (decision D1).
 *
 * The planner write comes first. If clearing the due date fails, the task is
 * dropped but still dated; dropping it again clears the date without writing a
 * second event. A task that is already dropped is not dropped twice.
 */
export async function plannerDropTask(
  db: FlareMoDb,
  input: { user: UserRow; actor: PlannerActor; taskId: string; now?: Date },
): Promise<PlannerTaskPlanResult> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);

  if (!existing?.droppedAt) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .insert(plannerTaskPlan)
        .values({
          taskId,
          userId: input.user.id,
          horizon: null,
          periodStart: null,
          carryCount: 0,
          droppedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: plannerTaskPlan.taskId,
          set: { droppedAt: nowIso, updatedAt: nowIso },
        }),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "dropped",
        data: { previous_due_at: task.dueAt },
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }

  if (task.dueAt !== null) {
    await updateTask(db, input.user, input.actor, taskId, { due_at: null });
  }
  return resultFor(db, input.user, taskId);
}

/**
 * Undrops a task: `dropped_at` is cleared and an `undropped` event written. The
 * kept plan decides where the task lands again, and the old due date is NOT
 * restored. A task that is not dropped is left alone.
 */
export async function plannerUndropTask(
  db: FlareMoDb,
  input: { user: UserRow; actor: PlannerActor; taskId: string; now?: Date },
): Promise<PlannerTaskPlanResult> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);

  if (existing?.droppedAt) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .update(plannerTaskPlan)
        .set({ droppedAt: null, updatedAt: nowIso })
        .where(
          and(
            eq(plannerTaskPlan.taskId, taskId),
            eq(plannerTaskPlan.userId, input.user.id),
          ),
        ),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "undropped",
        data: {},
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Column moves
// ---------------------------------------------------------------------------

type StatusTarget = "todo" | "in_progress" | "done";

/** Plan before today's period: the one case where "Done to To Do" re-plans. */
function isPast(plan: PlannerTaskPlanRow, today: string): boolean {
  return (
    plan.horizon !== null &&
    plan.periodStart !== null &&
    plan.periodStart < plannerPeriodStart(plan.horizon, today)
  );
}

/**
 * Moves a card to a column, applying the plan's column-move table:
 *
 *   Backlog to To Do        plan = this week (default)
 *   To Do to Backlog        plan cleared
 *   Backlog or To Do to Doing   status in_progress, plan kept
 *   any to Done             status done, plan kept for history
 *   Doing to To Do          status todo; no plan (or NULL horizon): plan = this week
 *   Doing or Done to Backlog    status todo, plan cleared
 *   Done to To Do           status todo; plan missing, NULL horizon or past: this week
 *   Done to Doing           status in_progress
 *
 * A move to the column the task is already in does nothing. A task with an
 * unknown status moves like any other. A dropped task cannot be moved.
 *
 * Order: the plan batch runs first, then the status write through upstream's
 * `updateTask`. For a card leaving Doing or Done the plan does not decide its
 * column, so a failure between the two never shows a wrong column.
 */
export async function plannerApplyColumnMove(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    to: PlannerColumn;
    today: string;
    now?: Date;
  },
): Promise<
  PlannerTaskPlanResult & { from: PlannerColumn | "other"; to: PlannerColumn }
> {
  if (!plannerIsColumn(input.to)) {
    throw new ValidationError("to must be backlog, todo, doing or done.");
  }
  const to = input.to;
  const today = plannerRequireDay(input.today, "today");
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  assertNotDropped(existing);

  const from = plannerColumnFor({
    status: task.status,
    horizon: existing?.horizon ?? null,
    periodStart: existing?.periodStart ?? null,
    droppedAt: null,
  }) as PlannerColumn | "other";
  if (from === to) {
    return { ...(await resultFor(db, input.user, taskId)), from, to };
  }

  const hasPlan = plannerHasPlan(existing);
  const thisWeek: ResolvedPlan = {
    horizon: "week",
    periodStart: plannerPeriodStart("week", today),
  };
  let status: StatusTarget | null = null;
  let plan: ResolvedPlan | null | undefined; // undefined: leave the plan alone

  switch (to) {
    case "todo":
      status = "todo";
      if (from === "backlog" || !hasPlan) plan = thisWeek;
      else if (from === "done" && existing && isPast(existing, today)) {
        plan = thisWeek;
      }
      break;
    case "backlog":
      status = "todo";
      if (hasPlan) plan = null;
      break;
    case "doing":
      status = "in_progress";
      break;
    case "done":
      status = "done";
      break;
  }

  if (plan !== undefined) {
    await writePlanChange(db, {
      userId: input.user.id,
      actor: input.actor,
      task,
      existing,
      next: plan,
      now: plannerNow(input.now),
    });
  }
  if (status !== null && status !== task.status) {
    await updateTask(db, input.user, input.actor, taskId, { status });
  }
  return { ...(await resultFor(db, input.user, taskId)), from, to };
}
