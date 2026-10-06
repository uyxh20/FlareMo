import type { TaskDto } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { projects, tasks } from "@flaremo/db";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError } from "../errors";
import { taskToDto } from "../tasks";
import { type PlannerCommentDto, plannerReadComments } from "./comments";
import { type PlannerPlanDto, plannerPlanToDto } from "./plans";
import { plannerLoadPlan, plannerNormalizeTaskId } from "./shared";
import { plannerReadTree } from "./tree";

// The task panel's read (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): everything one task
// shows when its card is opened, in one response.

/** The goal a task belongs to, with the path of goals above it. */
export type PlannerTaskProject = {
  /** Upstream's project id. */
  id: string;
  name: string;
  /**
   * The projects above it in the goal tree, the root first and ending with its
   * own parent; empty for a root or a project with no node row. The walk stops
   * at the first ancestor that is not a live project, the way the tree reads a
   * child of a binned parent as a root.
   */
  ancestors: Array<{ id: string; name: string }>;
};

/** One task as the panel shows it. */
export type PlannerTaskDetail = {
  /** The whole upstream task, `notes` included (a board card leaves them out). */
  task: TaskDto;
  /** NULL for a task that never had a plan row; a row may hold only an effort. */
  plan: PlannerPlanDto | null;
  project: PlannerTaskProject | null;
  /** Oldest first, without the deleted ones. */
  comments: PlannerCommentDto[];
};

// A walk up the goal tree stops here even on damaged data with a cycle.
const WALK_CAP = 50;

/**
 * The project's name and the path above it. The project itself is read from
 * `projects` (the board does the same, so a name never disappears from a card);
 * the path comes from the goal tree.
 */
async function readProject(
  db: FlareMoDb,
  userId: string,
  projectId: string,
): Promise<PlannerTaskProject | null> {
  const project = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .get();
  if (!project) return null;

  const byId = new Map(
    (await plannerReadTree(db, { userId })).map((node) => [node.id, node]),
  );
  const ancestors: PlannerTaskProject["ancestors"] = [];
  const seen = new Set([project.id]);
  let parentId = byId.get(project.id)?.parent_project_id ?? null;
  while (parentId !== null && !seen.has(parentId) && seen.size <= WALK_CAP) {
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.unshift({ id: parent.id, name: parent.name });
    seen.add(parent.id);
    parentId = parent.parent_project_id;
  }
  return { id: project.id, name: project.name, ancestors };
}

/**
 * One of the caller's live tasks with its plan (effort included), its goal and
 * the goal's path, and its comments. A task that is missing, in the recycle bin
 * or someone else's is a 404, exactly like upstream's own task read.
 */
export async function plannerReadTaskDetail(
  db: FlareMoDb,
  input: { userId: string; taskId: string },
): Promise<PlannerTaskDetail> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const row = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.userId, input.userId),
        isNull(tasks.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`Task not found: ${taskId}`);

  const [plan, project, comments] = await Promise.all([
    plannerLoadPlan(db, input.userId, taskId),
    row.projectId === null
      ? Promise.resolve(null)
      : readProject(db, input.userId, row.projectId),
    plannerReadComments(db, { userId: input.userId, taskId }),
  ]);
  return {
    task: taskToDto(row),
    plan: plan ? plannerPlanToDto(plan) : null,
    project,
    comments,
  };
}
