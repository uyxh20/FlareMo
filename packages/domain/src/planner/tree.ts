import { plannerIsValidDayKey, plannerIsValidLevel } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { projects } from "@flaremo/db";
import { plannerProjectNode } from "@flaremo/db/src/schema/planner";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  plannerChanges,
  plannerNormalizeProjectId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
  plannerShiftDay,
} from "./shared";

// The goal tree (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// sections 3 and 4, decision D3): upstream projects arranged in a tree by
// `planner_project_node`. A project with no node row is a root with no level.
// Tasks belong to a goal through upstream's own `tasks.project_id`.
//
// The node table has no foreign key to `projects` (G10), so a node can outlive
// its project; the history sync removes the nodes of purged projects.

/** The deepest a tree may go: a root is depth 1. */
export const plannerMaxTreeDepth = 6;

// A recursive walk stops here even on damaged data that contains a cycle.
const WALK_CAP = 50;

/** A project merged with its node row, as the routes return it. */
export type PlannerTreeNodeDto = {
  /** Upstream's project id. */
  id: string;
  name: string;
  status: "active" | "archived";
  /**
   * The parent as the tree shows it: NULL for a root, and also for a child
   * whose parent project sits in the recycle bin.
   */
  parent_project_id: string | null;
  /** A slug such as `area`, `year`, `quarter`, `goal` or `milestone`. */
  level: string | null;
  period_start: string | null;
  period_end: string | null;
  sort_order: number;
};

const nodeColumns = {
  id: projects.id,
  name: projects.name,
  status: projects.status,
  parentProjectId: plannerProjectNode.parentProjectId,
  level: plannerProjectNode.level,
  periodStart: plannerProjectNode.periodStart,
  periodEnd: plannerProjectNode.periodEnd,
  sortOrder: plannerProjectNode.sortOrder,
};

type NodeRow = {
  id: string;
  name: string;
  status: "active" | "archived";
  parentProjectId: string | null;
  level: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  sortOrder: number | null;
};

function toNodeDto(
  row: NodeRow,
  parentProjectId: string | null,
): PlannerTreeNodeDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    parent_project_id: parentProjectId,
    level: row.level,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    sort_order: row.sortOrder ?? 0,
  };
}

/** One of the user's live projects, or a 404 like upstream's `requireProject`. */
async function requireOwnedProject(
  db: FlareMoDb,
  userId: string,
  projectId: string,
) {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.userId, userId),
        isNull(projects.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError(`Project not found: ${projectId}`);
}

// ---------------------------------------------------------------------------
// Read the tree
// ---------------------------------------------------------------------------

/**
 * The user's live projects merged with their node rows, as a flat list ordered
 * by `sort_order`, then creation. A project in the recycle bin is left out, and
 * a child of one shows as a root; its node row still names the parent, so
 * restoring the parent puts the child back under it.
 */
export async function plannerReadTree(
  db: FlareMoDb,
  input: { userId: string },
): Promise<PlannerTreeNodeDto[]> {
  const rows = await db
    .select(nodeColumns)
    .from(projects)
    .leftJoin(plannerProjectNode, eq(plannerProjectNode.projectId, projects.id))
    .where(and(eq(projects.userId, input.userId), isNull(projects.deletedAt)))
    .orderBy(
      asc(sql`coalesce(${plannerProjectNode.sortOrder}, 0)`),
      asc(projects.createdAt),
      asc(projects.id),
    );
  const live = new Set(rows.map((row) => row.id));
  return rows.map((row) =>
    toNodeDto(
      row,
      row.parentProjectId !== null && live.has(row.parentProjectId)
        ? row.parentProjectId
        : null,
    ),
  );
}

async function readNode(
  db: FlareMoDb,
  userId: string,
  projectId: string,
): Promise<PlannerTreeNodeDto> {
  const row = await db
    .select(nodeColumns)
    .from(projects)
    .leftJoin(plannerProjectNode, eq(plannerProjectNode.projectId, projects.id))
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .get();
  if (!row) throw new NotFoundError(`Project not found: ${projectId}`);
  return toNodeDto(row, row.parentProjectId);
}

// ---------------------------------------------------------------------------
// Write a node
// ---------------------------------------------------------------------------

/**
 * What putting `projectId` (with everything below it) under `parentId` would do
 * to the tree: the depth it would reach, which is the parent's depth, one for
 * the project and the height of the subtree being moved (a parent with no node
 * row is a root, depth 1), and whether the project is already among the
 * parent's ancestors, which would make a cycle.
 *
 * The cycle flag is only here so that a cycle on a deep tree is reported as one
 * rather than as too deep. The authoritative cycle check is the guard inside the
 * write, which no race can get past.
 */
async function inspectMove(
  db: FlareMoDb,
  projectId: string,
  parentId: string,
): Promise<{ depth: number; cycle: boolean }> {
  const above = await db.get<{
    depth: number | null;
    cycle: number | null;
  }>(sql`
    WITH RECURSIVE up(id, depth) AS (
      SELECT ${parentId}, 1
      UNION ALL
      SELECT n.parent_project_id, up.depth + 1
      FROM planner_project_node n
      JOIN up ON n.project_id = up.id
      WHERE n.parent_project_id IS NOT NULL AND up.depth < ${WALK_CAP}
    )
    SELECT MAX(depth) AS depth,
           MAX(CASE WHEN id = ${projectId} THEN 1 ELSE 0 END) AS cycle
    FROM up`);
  const below = await db.get<{ height: number | null }>(sql`
    WITH RECURSIVE down(id, depth) AS (
      SELECT ${projectId}, 0
      UNION ALL
      SELECT n.project_id, down.depth + 1
      FROM planner_project_node n
      JOIN down ON n.parent_project_id = down.id
      WHERE down.depth < ${WALK_CAP}
    )
    SELECT MAX(depth) AS height FROM down`);
  return {
    depth: (above?.depth ?? 1) + 1 + (below?.height ?? 0),
    cycle: (above?.cycle ?? 0) === 1,
  };
}

/**
 * Creates or updates a project's node. Only the fields that are given change;
 * `null` clears one (a NULL `parentProjectId` makes the project a root), and a
 * field left out stays as it was (or takes its default on a new node).
 *
 * - Both the project and the parent must be the user's live projects (404).
 * - The parent gets a node row if it has none, in the same batch.
 * - The write is `ON CONFLICT(project_id) DO UPDATE`, never INSERT OR REPLACE,
 *   which would delete the row and null the parent of every child.
 * - A cycle is refused inside the write itself, by a recursive ancestor check
 *   in the statement's WHERE, and then confirmed through `meta.changes`: a
 *   project cannot become its own ancestor even when two requests race
 *   (ConflictError).
 * - Depth is capped at 6, counting the new parent's depth plus the height of
 *   the subtree being moved (ValidationError). It is checked only when the
 *   parent changes, so a level or order edit never fails on a tree that is
 *   already deep.
 * - `level` must be a slug (`^[a-z][a-z0-9-]{0,23}$`), dates real `YYYY-MM-DD`
 *   days with the start not after the end, and `sortOrder` a whole number.
 */
export async function plannerUpsertProjectNode(
  db: FlareMoDb,
  input: {
    userId: string;
    projectId: string;
    parentProjectId?: string | null;
    level?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    sortOrder?: number;
    now?: Date;
  },
): Promise<PlannerTreeNodeDto> {
  const { userId } = input;
  const projectId = plannerNormalizeProjectId(input.projectId);
  const parentId =
    typeof input.parentProjectId === "string"
      ? plannerNormalizeProjectId(input.parentProjectId)
      : input.parentProjectId;

  if (
    input.level !== undefined &&
    input.level !== null &&
    !plannerIsValidLevel(input.level)
  ) {
    throw new ValidationError(
      "level must be a lowercase slug of up to 24 characters, such as area, quarter or goal.",
    );
  }
  for (const [label, value] of [
    ["period_start", input.periodStart],
    ["period_end", input.periodEnd],
  ] as const) {
    if (value !== undefined && value !== null && !plannerIsValidDayKey(value)) {
      throw new ValidationError(`${label} must be a valid YYYY-MM-DD date.`);
    }
  }
  if (input.sortOrder !== undefined && !Number.isSafeInteger(input.sortOrder)) {
    throw new ValidationError("sort_order must be a whole number.");
  }

  await requireOwnedProject(db, userId, projectId);
  if (typeof parentId === "string") {
    if (parentId === projectId) {
      throw new ConflictError("A project cannot be its own parent.");
    }
    await requireOwnedProject(db, userId, parentId);
  }

  const existing = await db
    .select()
    .from(plannerProjectNode)
    .where(eq(plannerProjectNode.projectId, projectId))
    .get();

  const periodStart =
    input.periodStart !== undefined
      ? input.periodStart
      : (existing?.periodStart ?? null);
  const periodEnd =
    input.periodEnd !== undefined
      ? input.periodEnd
      : (existing?.periodEnd ?? null);
  if (periodStart !== null && periodEnd !== null && periodStart > periodEnd) {
    throw new ValidationError("period_start must not be after period_end.");
  }

  if (
    typeof parentId === "string" &&
    parentId !== (existing?.parentProjectId ?? null)
  ) {
    const { depth, cycle } = await inspectMove(db, projectId, parentId);
    if (cycle) {
      throw new ConflictError(
        "That move would make the project its own ancestor.",
      );
    }
    if (depth > plannerMaxTreeDepth) {
      throw new ValidationError(
        `A tree can be at most ${plannerMaxTreeDepth} levels deep; this move would make it ${depth}.`,
      );
    }
  }

  const nowIso = plannerNow(input.now).toISOString();
  const set: Partial<typeof plannerProjectNode.$inferInsert> = {
    updatedAt: nowIso,
  };
  if (parentId !== undefined) set.parentProjectId = parentId;
  if (input.level !== undefined) set.level = input.level;
  if (input.periodStart !== undefined) set.periodStart = input.periodStart;
  if (input.periodEnd !== undefined) set.periodEnd = input.periodEnd;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;

  const level = input.level ?? existing?.level ?? null;
  const sortOrder = input.sortOrder ?? existing?.sortOrder ?? 0;
  const target = plannerProjectNode.projectId;

  const statements: unknown[] = [];
  if (typeof parentId === "string") {
    // The parent's own row, so the self foreign key has something to point at.
    statements.push(
      db
        .insert(plannerProjectNode)
        .values({
          projectId: parentId,
          userId,
          parentProjectId: null,
          level: null,
          periodStart: null,
          periodEnd: null,
          sortOrder: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoNothing(),
    );
    // The cycle guard: the row is only produced when the project is not among
    // the new parent's ancestors (the parent included). UNION, not UNION ALL,
    // so a stray cycle already in the data cannot make the walk loop.
    statements.push(
      db
        .insert(plannerProjectNode)
        .select(sql`
          SELECT ${projectId}, ${userId}, ${parentId}, ${level}, ${periodStart},
                 ${periodEnd}, ${sortOrder}, ${nowIso}, ${nowIso}
          WHERE NOT EXISTS (
            WITH RECURSIVE ancestors(id) AS (
              SELECT ${parentId}
              UNION
              SELECT n.parent_project_id
              FROM planner_project_node n
              JOIN ancestors a ON n.project_id = a.id
              WHERE n.parent_project_id IS NOT NULL
            )
            SELECT 1 FROM ancestors WHERE id = ${projectId})`)
        .onConflictDoUpdate({ target, set }),
    );
  } else {
    statements.push(
      db
        .insert(plannerProjectNode)
        .values({
          projectId,
          userId,
          parentProjectId: null,
          level,
          periodStart,
          periodEnd,
          sortOrder,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({ target, set }),
    );
  }

  const results = await plannerRunBatch(db, statements);
  if (typeof parentId === "string" && plannerChanges(results.at(-1)) === 0) {
    throw new ConflictError(
      "That move would make the project its own ancestor.",
    );
  }
  return readNode(db, userId, projectId);
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

/** Task counts for one project, or summed over a subtree. */
export type PlannerRollupCounts = {
  /** Live tasks that are not done (todo, in progress or an unknown status). */
  open_tasks: number;
  done_tasks: number;
  /** Tasks whose plan period starts inside the range. */
  planned_in_range: number;
  /** Tasks completed inside the range. */
  done_in_range: number;
  /** `carried_over` events inside the range. */
  carried_in_range: number;
};

export type PlannerRollupNode = PlannerRollupCounts & {
  id: string;
  name: string;
  parent_project_id: string | null;
  level: string | null;
  /** 0 for the project the roll-up was asked for. */
  depth: number;
};

export type PlannerRollup = {
  project_id: string;
  from: string;
  to: string;
  /** The project and everything under it, parents before children. */
  nodes: PlannerRollupNode[];
  /** The counts summed over `nodes`. */
  total: PlannerRollupCounts;
};

type RollupRow = PlannerRollupCounts & {
  id: string;
  name: string;
  parent_project_id: string | null;
  level: string | null;
  sort_order: number;
};

/**
 * Counts a project's tasks and everything beneath it in the tree, per node and
 * in total, for the days `from` to `to` inclusive. Soft-deleted tasks and
 * dropped plans are never counted, and the walk does not go through a project in
 * the recycle bin. `UNION` (not `UNION ALL`) means a stray cycle cannot loop it.
 *
 * Counts are by upstream's `tasks.project_id`, so a task counts under the
 * project it is in now. Planned and carried use the plan period and the event
 * time; done uses the completion time.
 */
export async function plannerReadRollup(
  db: FlareMoDb,
  input: { userId: string; projectId: string; from: string; to: string },
): Promise<PlannerRollup> {
  const { userId } = input;
  const from = plannerRequireDay(input.from, "from");
  const to = plannerRequireDay(input.to, "to");
  if (from > to) throw new ValidationError("from must not be after to.");
  const rootId = plannerNormalizeProjectId(input.projectId);
  await requireOwnedProject(db, userId, rootId);
  const dayAfter = plannerShiftDay(to, 1);

  // Every count below is of live tasks (`deleted_at IS NULL`) that are not
  // dropped (`dropped_at IS NULL`), by the project each task is in now.
  const rows = await db.all<RollupRow>(sql`
    WITH RECURSIVE subtree(id) AS (
      SELECT ${rootId}
      UNION
      SELECT n.project_id
      FROM planner_project_node n
      JOIN subtree s ON n.parent_project_id = s.id
      JOIN projects p ON p.id = n.project_id
      WHERE n.user_id = ${userId} AND p.user_id = ${userId} AND p.deleted_at IS NULL
    )
    SELECT
      s.id AS id,
      p.name AS name,
      n.parent_project_id AS parent_project_id,
      n.level AS level,
      COALESCE(n.sort_order, 0) AS sort_order,
      (SELECT COUNT(*) FROM tasks t
         LEFT JOIN planner_task_plan pl ON pl.task_id = t.id
         WHERE t.project_id = s.id AND t.user_id = ${userId} AND t.deleted_at IS NULL
           AND pl.dropped_at IS NULL AND t.status <> 'done') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t
         LEFT JOIN planner_task_plan pl ON pl.task_id = t.id
         WHERE t.project_id = s.id AND t.user_id = ${userId} AND t.deleted_at IS NULL
           AND pl.dropped_at IS NULL AND t.status = 'done') AS done_tasks,
      (SELECT COUNT(*) FROM tasks t
         JOIN planner_task_plan pl ON pl.task_id = t.id
         WHERE t.project_id = s.id AND t.user_id = ${userId} AND t.deleted_at IS NULL
           AND pl.dropped_at IS NULL
           AND pl.period_start >= ${from} AND pl.period_start <= ${to}) AS planned_in_range,
      (SELECT COUNT(*) FROM tasks t
         LEFT JOIN planner_task_plan pl ON pl.task_id = t.id
         WHERE t.project_id = s.id AND t.user_id = ${userId} AND t.deleted_at IS NULL
           AND pl.dropped_at IS NULL AND t.status = 'done'
           AND substr(t.completed_at, 1, 10) >= ${from}
           AND substr(t.completed_at, 1, 10) <= ${to}) AS done_in_range,
      (SELECT COUNT(*) FROM planner_task_event e
         JOIN tasks t ON t.id = e.task_id
         LEFT JOIN planner_task_plan pl ON pl.task_id = t.id
         WHERE e.user_id = ${userId} AND e.type = 'carried_over'
           AND e.occurred_at >= ${from} AND e.occurred_at < ${dayAfter}
           AND t.project_id = s.id AND t.user_id = ${userId} AND t.deleted_at IS NULL
           AND pl.dropped_at IS NULL) AS carried_in_range
    FROM subtree s
    JOIN projects p ON p.id = s.id
    LEFT JOIN planner_project_node n ON n.project_id = s.id
    WHERE p.user_id = ${userId} AND p.deleted_at IS NULL`);

  // Parents before children, children by sort order. Only links inside the
  // subtree count, and each node is visited once, so damaged data cannot loop.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, RollupRow[]>();
  for (const row of rows) {
    if (row.id === rootId) continue;
    const parent = row.parent_project_id;
    if (parent !== null && byId.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), row]);
    }
  }
  for (const list of children.values()) {
    list.sort(
      (left, right) =>
        left.sort_order - right.sort_order ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  }

  const nodes: PlannerRollupNode[] = [];
  const seen = new Set<string>();
  const total: PlannerRollupCounts = {
    open_tasks: 0,
    done_tasks: 0,
    planned_in_range: 0,
    done_in_range: 0,
    carried_in_range: 0,
  };
  const stack: Array<{ row: RollupRow; depth: number }> = [];
  const root = byId.get(rootId);
  if (root) stack.push({ row: root, depth: 0 });
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || seen.has(entry.row.id)) continue;
    seen.add(entry.row.id);
    const { row, depth } = entry;
    nodes.push({
      id: row.id,
      name: row.name,
      parent_project_id: row.parent_project_id,
      level: row.level,
      depth,
      open_tasks: row.open_tasks,
      done_tasks: row.done_tasks,
      planned_in_range: row.planned_in_range,
      done_in_range: row.done_in_range,
      carried_in_range: row.carried_in_range,
    });
    total.open_tasks += row.open_tasks;
    total.done_tasks += row.done_tasks;
    total.planned_in_range += row.planned_in_range;
    total.done_in_range += row.done_in_range;
    total.carried_in_range += row.carried_in_range;
    const below = children.get(row.id) ?? [];
    // Pushed in reverse so the first child is popped first.
    for (let index = below.length - 1; index >= 0; index -= 1) {
      const child = below[index];
      if (child) stack.push({ row: child, depth: depth + 1 });
    }
  }

  return { project_id: rootId, from, to, nodes, total };
}
