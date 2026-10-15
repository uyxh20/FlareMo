import type {
  PlannerBoardCard,
  PlannerCommentDto,
  PlannerPlanDto,
  PlannerTaskDetailResponse,
  TaskDto,
} from "@flaremo/contracts";
import { plannerCardFromTask } from "./board-model";

// The task panel as plain data (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13). The panel reads one
// `PlannerTaskDetailResponse` and shows a task through it; this is how a change is
// shown the instant it is made (optimistic edits, M4) and how the goal paths and
// the `?task=` address are worked out. The server decides everything, and the page
// refetches the detail after a change, so nothing here is authoritative.

type Detail = PlannerTaskDetailResponse;

// --- The card a detail is ----------------------------------------------------

/**
 * The detail as a board card. A card is the flat view of the same task and plan,
 * so the board's own predictions and the cockpit's actions (move, plan, due date,
 * drop) work on an open task exactly as they do on its card.
 */
export function plannerCardFromDetail(detail: Detail): PlannerBoardCard {
  return plannerCardFromTask(
    detail.task,
    detail.plan,
    detail.project?.name ?? null,
  );
}

/**
 * The detail after an edit that the card shows: title, status, priority, due
 * date, project and plan. The notes, the effort and the comments are left as they
 * are, because a card does not carry them. The plan row is created when the edit
 * gives the task a plan it did not have, and is kept (empty) when it is cleared,
 * since it may hold an effort.
 */
export function plannerDetailWithCard(
  detail: Detail,
  card: PlannerBoardCard,
): Detail {
  const task: TaskDto = {
    ...detail.task,
    title: card.title,
    status: card.status as TaskDto["status"],
    priority: card.priority as TaskDto["priority"],
    due_at: card.due_at,
    project_id: card.project_id,
    completed_at: card.completed_at,
    updated_at: card.updated_at,
  };

  const before = detail.plan;
  const planChanged =
    (before?.horizon ?? null) !== card.horizon ||
    (before?.period_start ?? null) !== card.period_start ||
    (before?.dropped_at ?? null) !== card.dropped_at ||
    (before?.carry_count ?? 0) !== card.carry_count ||
    (before?.start_date ?? null) !== card.start_date ||
    (before?.goal_id ?? null) !== card.goal_id;
  const plan: PlannerPlanDto | null =
    before === null && !planChanged
      ? null
      : {
          task_id: detail.task.id,
          horizon: card.horizon,
          period_start: card.period_start,
          carry_count: card.carry_count,
          dropped_at: card.dropped_at,
          effort: before?.effort ?? null,
          start_date: card.start_date,
          board_rank: before?.board_rank ?? null,
          goal_id: card.goal_id,
          created_at: before?.created_at ?? card.updated_at,
          updated_at: planChanged
            ? card.updated_at
            : (before?.updated_at ?? card.updated_at),
        };

  const project =
    card.project_id === null
      ? null
      : detail.project?.id === card.project_id
        ? detail.project
        : { id: card.project_id, name: card.project_name ?? "" };

  return { ...detail, task, plan, project };
}

/**
 * The detail with a new effort estimate (or none) on its plan row, made if it had
 * none. `at` is when the row changed: now for a prediction, the server's time for
 * an answer.
 */
export function plannerDetailWithEffort(
  detail: Detail,
  effort: number | null,
  when: Date | string = new Date(),
): Detail {
  const at = typeof when === "string" ? when : when.toISOString();
  const plan: PlannerPlanDto = detail.plan
    ? { ...detail.plan, effort, updated_at: at }
    : {
        task_id: detail.task.id,
        horizon: null,
        period_start: null,
        carry_count: 0,
        dropped_at: null,
        effort,
        start_date: null,
        board_rank: null,
        goal_id: null,
        created_at: at,
        updated_at: at,
      };
  return { ...detail, plan };
}

// --- Comments ----------------------------------------------------------------

const PENDING_COMMENT_PREFIX = "pending-comment-";

/** The id of the `serial`th comment that is still waiting for the server. */
export function plannerPendingCommentId(serial: number): string {
  return `${PENDING_COMMENT_PREFIX}${serial}`;
}

export function plannerIsPendingComment(comment: { id: string }): boolean {
  return comment.id.startsWith(PENDING_COMMENT_PREFIX);
}

/** The detail with a comment added at the end (the list is oldest first). */
export function plannerDetailWithComment(
  detail: Detail,
  comment: PlannerCommentDto,
): Detail {
  return { ...detail, comments: [...detail.comments, comment] };
}

/** The detail with a comment swapped for another, which may have another id. */
export function plannerDetailReplacingComment(
  detail: Detail,
  commentId: string,
  comment: PlannerCommentDto,
): Detail {
  return {
    ...detail,
    comments: detail.comments.map((entry) =>
      entry.id === commentId ? comment : entry,
    ),
  };
}

export function plannerDetailWithoutComment(
  detail: Detail,
  commentId: string,
): Detail {
  return {
    ...detail,
    comments: detail.comments.filter((entry) => entry.id !== commentId),
  };
}

// --- When it was last touched ------------------------------------------------

/**
 * When a task was last touched, for the panel's footer: the later of the task's
 * own `updated_at` and its plan row's. An effort, a plan or a drop changes the
 * plan row and not the upstream task row, so the task's time alone would still say
 * "Updated an hour ago" right after one of them was edited. A time that cannot be
 * read is ignored.
 */
export function plannerLastTouched(
  taskUpdatedAt: string,
  planUpdatedAt: string | null | undefined,
): string {
  if (!planUpdatedAt) return taskUpdatedAt;
  const task = Date.parse(taskUpdatedAt);
  const plan = Date.parse(planUpdatedAt);
  if (Number.isNaN(plan)) return taskUpdatedAt;
  if (Number.isNaN(task)) return planUpdatedAt;
  return plan > task ? planUpdatedAt : taskUpdatedAt;
}

// --- The address -------------------------------------------------------------

/**
 * The task id (`tasks/<id>`, as the rest of the cockpit spells it) for the
 * `?task=` address, or null when the address names none. The address carries the
 * bare id, so it stays one clean path segment.
 */
export function plannerTaskIdFromParam(param: unknown): string | null {
  if (typeof param !== "string" && typeof param !== "number") return null;
  const bare = String(param).trim();
  if (bare === "") return null;
  return bare.startsWith("tasks/") ? bare : `tasks/${bare}`;
}

/** The `?task=` value for a task id: the bare id without `tasks/`. */
export function plannerTaskParamFromId(taskId: string): string {
  return taskId.startsWith("tasks/") ? taskId.slice("tasks/".length) : taskId;
}
