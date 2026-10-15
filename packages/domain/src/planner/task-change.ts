import type {
  TaskDto,
  TaskPriority,
  UpdateTaskInput,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { ValidationError } from "../errors";
import { updateTask } from "../tasks";
import { plannerRankNewTaskOnTop, plannerSetBoardRank } from "./board-rank";
import { type PlannerColumn, plannerIsColumn } from "./columns";
import { plannerRequireWeeklyGoal, plannerSetTaskGoal } from "./goals";
import {
  type PlannerPlanDto,
  type PlannerPlanInput,
  type PlannerTaskPlanResult,
  plannerApplyColumnMove,
  plannerCreateTask,
  plannerDropTask,
  plannerNormalizeEffort,
  plannerNormalizeStartDate,
  plannerReadTaskPlan,
  plannerSetEffort,
  plannerSetPlan,
  plannerSetStartDate,
  plannerUndropTask,
} from "./plans";
import {
  type PlannerActor,
  plannerLoadLiveTask,
  plannerNormalizeTaskId,
  plannerRequireDay,
} from "./shared";

// Changing a task, as one domain call (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4 and 13). The cockpit's
// PATCH /tasks/:id and POST /tasks hand their whole request here, so the order of
// the steps and the rules they check live in one place instead of in the route.
//
// Everything that can be refused is checked BEFORE the first write: the task, the
// day, the effort, the start date, the goal (one of the caller's weekly goals) and
// which fields may go together. A bad request therefore changes nothing. The steps
// themselves are separate writes, each with its own history event in its own
// batch, so a step that fails on the database leaves the earlier steps applied.
// No step is given a shared `now`: each reads the clock when it runs, so the events
// of one change come out in the order they happened.

/** Every change one request can make to a task. Left out, a field is untouched. */
export type PlannerTaskChange = {
  /** `false` undrops first, so a dropped task can be planned or moved at once; `true` drops last. */
  dropped?: boolean;
  /** Upstream's own fields, through upstream's `updateTask` so it logs them. */
  title?: string;
  notes?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  projectId?: string | null;
  /** A column move; the move table sets the plan, so it cannot come with `plan`. */
  column?: PlannerColumn;
  /** Where in `column` the card goes: directly above `beforeId`, or below `afterId`. */
  beforeId?: string;
  afterId?: string;
  /** A plan, or null for the backlog. */
  plan?: PlannerPlanInput | null;
  effort?: number | null;
  startDate?: string | null;
  /** One of the caller's weekly goals, or null to unlink. */
  goalId?: string | null;
};

/**
 * Applies a change to a task, step by step in this order:
 *
 *   1. undrop (`dropped: false`)
 *   2. upstream's fields (title, notes, priority, due date, project)
 *   3. the column move and its place in the column, or else the plan
 *   4. the effort, the start date and the goal
 *   5. drop (`dropped: true`), last, so it also clears a due date set in step 2
 *
 * Returns the task and its plan as they are afterwards.
 */
export async function plannerChangeTask(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    today: string;
    change: PlannerTaskChange;
  },
): Promise<PlannerTaskPlanResult> {
  const { user, actor, change } = input;
  const today = plannerRequireDay(input.today, "today");
  const taskId = plannerNormalizeTaskId(input.taskId);
  const effort =
    change.effort === undefined
      ? undefined
      : plannerNormalizeEffort(change.effort);
  const startDate =
    change.startDate === undefined
      ? undefined
      : plannerNormalizeStartDate(change.startDate);
  checkPlacement(change);
  await plannerLoadLiveTask(db, user.id, taskId);
  if (change.goalId !== undefined && change.goalId !== null) {
    await plannerRequireWeeklyGoal(db, user.id, change.goalId);
  }

  if (change.dropped === false) {
    await plannerUndropTask(db, { user, actor, taskId });
  }
  const fields = upstreamFields(change);
  if (Object.keys(fields).length > 0) {
    await updateTask(db, user, actor, taskId, fields);
  }
  if (change.column !== undefined) {
    await plannerApplyColumnMove(db, {
      user,
      actor,
      taskId,
      to: change.column,
      today,
    });
    // Dropped between two cards: the column's order, one row, no event.
    if (change.beforeId !== undefined || change.afterId !== undefined) {
      await plannerSetBoardRank(db, {
        user,
        taskId,
        column: change.column,
        beforeId: change.beforeId,
        afterId: change.afterId,
        today,
      });
    }
  } else if (change.plan !== undefined) {
    await plannerSetPlan(db, { user, actor, taskId, plan: change.plan, today });
  }
  if (effort !== undefined) {
    await plannerSetEffort(db, { user, actor, taskId, effort });
  }
  if (startDate !== undefined) {
    await plannerSetStartDate(db, { user, actor, taskId, startDate });
  }
  if (change.goalId !== undefined) {
    await plannerSetTaskGoal(db, {
      user,
      actor,
      taskId,
      goalId: change.goalId,
    });
  }
  if (change.dropped === true) {
    await plannerDropTask(db, { user, actor, taskId });
  }
  return plannerReadTaskPlan(db, { user, taskId });
}

/**
 * Creates a task the way a column's "+" or a goal's "Add task" does: through
 * upstream's `createTask`, with its column's status, a plan when given, on top of
 * its column when that column has a manual order, and linked to a weekly goal
 * when `goalId` is given. The goal is checked before the task exists, so a bad
 * goal creates nothing.
 *
 * Once the task exists it is never taken back. If its plan could not be saved the
 * result carries `planError` (a To Do task without its plan reads as Backlog);
 * if its goal link could not be saved, `goalError`. Either way the client can
 * offer a retry of just that part, instead of creating a second task.
 */
export async function plannerAddTask(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    title: string;
    notes?: string;
    priority?: TaskPriority;
    dueAt?: string;
    projectId?: string;
    column?: PlannerColumn;
    plan?: PlannerPlanInput | null;
    goalId?: string | null;
    today: string;
  },
): Promise<{
  task: TaskDto;
  plan: PlannerPlanDto | null;
  planError?: string;
  goalError?: string;
}> {
  const { user, actor, column } = input;
  if (input.goalId) {
    await plannerRequireWeeklyGoal(db, user.id, input.goalId);
  }
  const created = await plannerCreateTask(db, {
    user,
    actor,
    title: input.title,
    notes: input.notes,
    priority: input.priority,
    dueAt: input.dueAt,
    projectId: input.projectId,
    column,
    plan: input.plan,
    today: input.today,
  });
  const taskId = created.task.id;
  let changed = false;
  // A column with a manual order puts the new card on top of it (migration
  // 9004); an unranked column keeps its natural order and nothing is written.
  if (column !== undefined) {
    changed = await plannerRankNewTaskOnTop(db, {
      userId: user.id,
      taskId,
      column,
    });
  }
  let goalError: string | undefined;
  if (input.goalId) {
    try {
      changed =
        (await plannerSetTaskGoal(db, {
          user,
          actor,
          taskId,
          goalId: input.goalId,
        })) || changed;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Planner goal link failed after the task was created",
          task: taskId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      goalError = "The goal could not be linked.";
    }
  }
  const plan = changed
    ? (await plannerReadTaskPlan(db, { user, taskId })).plan
    : created.plan;
  return {
    task: created.task,
    plan,
    ...(created.planError ? { planError: created.planError } : {}),
    ...(goalError ? { goalError } : {}),
  };
}

/** A column move sets the plan itself, and a place in a column needs the column. */
function checkPlacement(change: PlannerTaskChange): void {
  if (change.column !== undefined) {
    if (!plannerIsColumn(change.column)) {
      throw new ValidationError("column must be backlog, todo, doing or done.");
    }
    if (change.plan !== undefined) {
      throw new ValidationError(
        "Send either column or plan, not both: a column move sets the plan itself.",
      );
    }
  } else if (change.beforeId !== undefined || change.afterId !== undefined) {
    throw new ValidationError(
      "before_id and after_id need column: they place a card in it.",
    );
  }
}

/** The fields upstream's `updateTask` owns, only the ones the change gives. */
function upstreamFields(change: PlannerTaskChange): UpdateTaskInput {
  const fields: UpdateTaskInput = {};
  if (change.title !== undefined) fields.title = change.title;
  if (change.notes !== undefined) fields.notes = change.notes;
  if (change.priority !== undefined) fields.priority = change.priority;
  if (change.dueAt !== undefined) fields.due_at = change.dueAt;
  if (change.projectId !== undefined) fields.project_id = change.projectId;
  return fields;
}
