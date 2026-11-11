import type { FlareMoDb } from "@flaremo/db";
import { tasks } from "@flaremo/db";
import { plannerTaskComment } from "@flaremo/db/src/schema/planner";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

// Keyword search over the cockpit's tasks (fork-owned add-on,
// docs/fork-data-sources.md): a task matches on its title, its notes or any of
// its live comments. The diary's search box shows the hits above its entries,
// and each opens the task's panel in the cockpit. Plain substring matching,
// case-insensitive, like the box's old client-side title/notes match; tasks are
// not in semantic search. Only live tasks are listed: a task in the recycle bin
// or purged has no panel to open.

/** Most tasks one search lists. */
export const PLANNER_TASK_SEARCH_MAX = 8;
/** Characters of context shown on each side of the match. */
const SNIPPET_SIDE = 60;

export type PlannerTaskSearchHit = {
  /** Namespaced task id, as the cockpit's `?task=` takes it. */
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  /** Where the words were found; `title` hits show the notes' start, if any. */
  match: "title" | "notes" | "comment";
  /** A short piece of the matching text around the words, or empty. */
  snippet: string;
  /** When the matching comment was written. */
  comment_at: string | null;
};

/** A piece of `text` around the first `needle`, with … where it was cut. */
export function plannerSearchSnippet(text: string, needle: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const at = clean.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return clean.slice(0, SNIPPET_SIDE * 2);
  const from = Math.max(0, at - SNIPPET_SIDE);
  const to = Math.min(clean.length, at + needle.length + SNIPPET_SIDE);
  return `${from > 0 ? "…" : ""}${clean.slice(from, to)}${to < clean.length ? "…" : ""}`;
}

/** The caller's live tasks whose title, notes or comments contain `query`. */
export async function plannerSearchTasks(
  db: FlareMoDb,
  input: { userId: string; query: string; limit?: number },
): Promise<PlannerTaskSearchHit[]> {
  const needle = input.query.replace(/\s+/g, " ").trim();
  if (!needle) return [];
  const limit = Math.min(input.limit ?? PLANNER_TASK_SEARCH_MAX, 50);
  const lowered = needle.toLocaleLowerCase();
  const contains = (column: unknown) =>
    sql`instr(lower(coalesce(${column}, '')), ${lowered}) > 0`;

  const [direct, commentRows] = await Promise.all([
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        notes: tasks.notes,
        status: tasks.status,
        dueAt: tasks.dueAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, input.userId),
          isNull(tasks.deletedAt),
          sql`(${contains(tasks.title)} OR ${contains(tasks.notes)})`,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(limit)
      .all(),
    db
      .select({
        taskId: plannerTaskComment.taskId,
        body: plannerTaskComment.body,
        at: plannerTaskComment.createdAt,
      })
      .from(plannerTaskComment)
      .where(
        and(
          eq(plannerTaskComment.userId, input.userId),
          isNull(plannerTaskComment.deletedAt),
          contains(plannerTaskComment.body),
        ),
      )
      .orderBy(desc(plannerTaskComment.createdAt))
      .limit(200)
      .all(),
  ]);

  const hits = new Map<string, PlannerTaskSearchHit>();
  for (const row of direct) {
    const inTitle = row.title.toLocaleLowerCase().includes(lowered);
    hits.set(row.id, {
      id: row.id,
      title: row.title,
      status: row.status,
      due_at: row.dueAt ?? null,
      match: inTitle ? "title" : "notes",
      snippet: row.notes ? plannerSearchSnippet(row.notes, needle) : "",
      comment_at: null,
    });
  }

  // The newest matching comment of each task the title and notes missed.
  const newest = new Map<string, (typeof commentRows)[number]>();
  for (const row of commentRows) {
    if (!hits.has(row.taskId) && !newest.has(row.taskId)) {
      newest.set(row.taskId, row);
    }
  }
  const room = limit - hits.size;
  const wanted = [...newest.keys()].slice(0, Math.max(room, 0));
  if (wanted.length) {
    const live = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, input.userId),
          isNull(tasks.deletedAt),
          inArray(tasks.id, wanted),
        ),
      )
      .all();
    const byId = new Map(live.map((row) => [row.id, row]));
    for (const id of wanted) {
      const task = byId.get(id);
      const comment = newest.get(id);
      if (!task || !comment) continue;
      hits.set(id, {
        id,
        title: task.title,
        status: task.status,
        due_at: task.dueAt ?? null,
        match: "comment",
        snippet: plannerSearchSnippet(comment.body, needle),
        comment_at: comment.at,
      });
    }
  }
  return [...hits.values()].slice(0, limit);
}
