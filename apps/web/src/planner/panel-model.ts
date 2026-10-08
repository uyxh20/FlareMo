import type {
  PlannerBoardCard,
  PlannerCommentDto,
  PlannerPlanDto,
  PlannerTaskDetailResponse,
  PlannerTaskProject,
  PlannerTreeNodeDto,
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
    (before?.start_date ?? null) !== card.start_date;
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
          created_at: before?.created_at ?? card.updated_at,
          updated_at: planChanged
            ? card.updated_at
            : (before?.updated_at ?? card.updated_at),
        };

  // The project keeps its path while it is the same project; a different one
  // starts without a path until the server's answer (or the caller) gives it.
  const project =
    card.project_id === null
      ? null
      : detail.project?.id === card.project_id
        ? detail.project
        : { id: card.project_id, name: card.project_name ?? "", ancestors: [] };

  return { ...detail, task, plan, project };
}

/** The detail with a new effort estimate (or none) on its plan row, made if it had none. */
export function plannerDetailWithEffort(
  detail: Detail,
  effort: number | null,
  now: Date,
): Detail {
  const at = now.toISOString();
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
        created_at: at,
        updated_at: at,
      };
  return { ...detail, plan };
}

/** The detail with the task and plan the server answered a change with. */
export function plannerDetailWithAnswer(
  detail: Detail,
  answer: { task: TaskDto; plan: PlannerPlanDto | null },
): Detail {
  return { ...detail, task: answer.task, plan: answer.plan };
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

// --- Goals -------------------------------------------------------------------

type PathNode = Pick<PlannerTreeNodeDto, "id" | "name" | "parent_project_id">;

// A walk up the tree stops here even on a damaged tree that has a cycle.
const WALK_CAP = 50;

/**
 * Every project's goal path from the tree: its own name and the names above it,
 * root first, as the task detail's `project` carries it. A parent that is not in
 * the list (binned, or outside it) ends the walk, and so does a cycle.
 */
export function plannerProjectPaths(
  nodes: readonly PathNode[],
): Map<string, PlannerTaskProject> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const paths = new Map<string, PlannerTaskProject>();
  for (const node of nodes) {
    const ancestors: PlannerTaskProject["ancestors"] = [];
    const seen = new Set([node.id]);
    let parentId = node.parent_project_id;
    while (parentId !== null && !seen.has(parentId) && seen.size <= WALK_CAP) {
      const parent = byId.get(parentId);
      if (!parent) break;
      ancestors.unshift({ id: parent.id, name: parent.name });
      seen.add(parent.id);
      parentId = parent.parent_project_id;
    }
    paths.set(node.id, { id: node.id, name: node.name, ancestors });
  }
  return paths;
}

/** "Health › Run a marathon": the goals above, then the project itself. */
export function plannerProjectPathLabel(
  project: Pick<PlannerTaskProject, "name" | "ancestors">,
  separator = " › ",
): string {
  return [...project.ancestors.map((entry) => entry.name), project.name].join(
    separator,
  );
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
