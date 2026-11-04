import {
  PLANNER_FLYWHEEL_PAUSE_MIN,
  PLANNER_FLYWHEEL_TUNING_DAYS,
  type PlannerFlywheelMetric,
  type PlannerFlywheelOrigin,
  type PlannerFlywheelResponse,
  type PlannerMetricValueDto,
  type PlannerMetricWeekDto,
  type PlannerTuningDto,
  type PlannerTuningVerdictDto,
  plannerAddDays,
  plannerFlywheelMetricNames,
  plannerFlywheelMetrics,
  plannerSummaryMemoSource,
  plannerTuningInstructionsMax,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memoRevisions, memos, tasks } from "@flaremo/db";
import {
  type PlannerEventRow,
  type PlannerTuningRow,
  plannerAgentAction,
  plannerAgentProposal,
  plannerAgentRun,
  plannerEvent,
  plannerGoal,
  plannerMetricWeek,
  plannerTaskEvent,
  plannerTuning,
  plannerWeek,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import type { PlannerChatMessage } from "./review-prompts";
import { plannerNow, plannerRunBatch } from "./shared";

// The flywheel (fork-owned add-on, docs/fork-flywheel.md): what turns the
// record into a better agent. Three parts, all in this file:
//
// - The log (planner_event): goal and review writes call plannerRecordEvents
//   after they land. A row says what happened, to what, and whether one of the
//   agent's proposals started it, with sizes and codes in `data`, never words.
//   Writing it never blocks or fails the save it describes.
// - The scorecard (planner_metric_week): plannerFlywheelRollup rebuilds a
//   week's numbers from the log, the task history, the agent's proposals and
//   actions, and the diary's revisions. The nightly sweep runs it for the
//   current week and the three before (a proposal is judged on its first seven
//   days, so a week settles about a fortnight on). Weeks are Monday to Sunday
//   in UTC, like the rest of the review.
// - The tuning (planner_tuning): the owner's standing instructions to the
//   agent, one row per version. The agent never changes them; it may propose a
//   version, the owner accepts, edits or dismisses it, and four weeks on keeps
//   or rolls it back against the number it aimed to move.

const DAY_MS = 86_400_000;
const KEEP_DAYS = 7;
/** An edit this soon after the write is the write itself (a revision of the save). */
const SAME_WRITE_MS = 60_000;
/** D1 binds at most 100 parameters a statement. */
const CHUNK = 90;
/** Weeks the nightly sweep rebuilds: this one and the three before it. */
const NIGHTLY_WEEKS = 4;

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export type PlannerEventSubject = PlannerEventRow["subject"];
export type PlannerEventData = Record<string, number | string | boolean | null>;

export type PlannerEventInput = {
  userId: string;
  kind: string;
  subject: PlannerEventSubject;
  subjectId?: string | null;
  origin?: "manual" | "proposal";
  proposalId?: string | null;
  data?: PlannerEventData;
  at?: string;
};

/**
 * Appends rows to the log. Never throws: a log row that cannot be written is
 * reported and dropped, so the save it describes always stands.
 */
export async function plannerRecordEvents(
  db: FlareMoDb,
  events: readonly PlannerEventInput[],
  now?: Date,
): Promise<void> {
  if (events.length === 0) return;
  const nowIso = plannerNow(now).toISOString();
  try {
    await plannerRunBatch(
      db,
      events.map((event) =>
        db.insert(plannerEvent).values({
          id: crypto.randomUUID(),
          userId: event.userId,
          kind: event.kind,
          subject: event.subject,
          subjectId: event.subjectId ?? null,
          origin: event.origin ?? "manual",
          proposalId: event.proposalId ?? null,
          data: event.data ?? {},
          occurredAt: event.at ?? nowIso,
          createdAt: nowIso,
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Flywheel log write failed",
        kinds: events.map((event) => event.kind).join(","),
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}

/**
 * How many characters an edit touched: the longer text's length less what the
 * two share at the start and the end. Cheap, and close enough for a trend.
 */
export function plannerEditChars(before: string, after: string): number {
  if (before === after) return 0;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < max - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }
  return Math.max(before.length, after.length) - start - end;
}

/** A goal's words as one text: its title and its lines, for sizes only. */
export function plannerGoalText(goal: {
  title: string;
  lines: ReadonlyArray<{ text: string; note?: string | null }>;
}): string {
  return [
    goal.title,
    ...goal.lines.map((line) =>
      line.note ? `${line.text}\n${line.note}` : line.text,
    ),
  ].join("\n");
}

/** The goal proposals the owner accepted, of these goal ids. */
export async function plannerAcceptedGoalProposals(
  db: FlareMoDb,
  userId: string,
  goalIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let at = 0; at < goalIds.length; at += CHUNK) {
    const ids = goalIds.slice(at, at + CHUNK);
    const rows = await db
      .select({ id: plannerAgentProposal.id })
      .from(plannerAgentProposal)
      .where(
        and(
          eq(plannerAgentProposal.userId, userId),
          eq(plannerAgentProposal.kind, "goal"),
          eq(plannerAgentProposal.state, "accepted"),
          inArray(plannerAgentProposal.id, ids),
        ),
      )
      .all();
    for (const row of rows) found.add(row.id);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

type Count = { num: number; den: number; value?: number | null };
type Tally = Partial<
  Record<PlannerFlywheelMetric, Partial<Record<PlannerFlywheelOrigin, Count>>>
>;

function put(
  tally: Tally,
  metric: PlannerFlywheelMetric,
  origin: PlannerFlywheelOrigin,
  count: Count,
): void {
  const byOrigin = tally[metric] ?? {};
  byOrigin[origin] = count;
  tally[metric] = byOrigin;
}

const share = (num: number, den: number) => (den > 0 ? num / den : null);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString();

async function inChunks<T>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += CHUNK) {
    out.push(...(await read(ids.slice(at, at + CHUNK))));
  }
  return out;
}

type PlanMove = { horizon?: string | null; period_start?: string | null };

function moveOf(data: unknown, side: "from" | "to"): PlanMove | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[side];
  return value && typeof value === "object" ? (value as PlanMove) : null;
}

/**
 * Rebuilds one week's scorecard rows from the record and returns them. A share
 * whose cases are not old enough to judge (a proposal's first seven days) counts
 * only the cases that are.
 */
export async function plannerFlywheelRollup(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; now?: Date },
): Promise<PlannerMetricWeekDto> {
  const { userId, weekStart } = input;
  const now = plannerNow(input.now);
  const nowIso = now.toISOString();
  const from = `${weekStart}T00:00:00.000Z`;
  const to = `${plannerAddDays(weekStart, 7)}T00:00:00.000Z`;
  const matured = (iso: string) =>
    Date.parse(iso) + KEEP_DAYS * DAY_MS <= now.getTime();
  const tally: Tally = {};

  // --- The agent's proposed actions: seen, accepted, kept.
  const created = await db
    .select()
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, userId),
        gte(plannerAgentAction.createdAt, from),
        lt(plannerAgentAction.createdAt, to),
      ),
    )
    .all();
  put(tally, "proposals_seen", "ai", {
    num: created.filter((row) => row.shownAt).length,
    den: created.length,
  });
  const settled = created.filter((row) => row.state !== "open");
  put(tally, "proposals_accepted", "ai", {
    num: settled.filter(
      (row) => row.state === "accepted" || row.state === "reverted",
    ).length,
    den: settled.length,
  });

  const landed = await db
    .select()
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, userId),
        inArray(plannerAgentAction.state, ["accepted", "reverted"]),
        gte(plannerAgentAction.settledAt, from),
        lt(plannerAgentAction.settledAt, to),
      ),
    )
    .all();
  const judged = landed.filter(
    (row) => row.settledAt && matured(row.settledAt),
  );
  const taskIds = [
    ...new Set(
      judged
        .filter((row) => row.kind === "task_change" || row.kind === "task_new")
        .map((row) => row.taskId ?? row.landedId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const ownerEdits = await inChunks(taskIds, (ids) =>
    db
      .select({
        taskId: plannerTaskEvent.taskId,
        occurredAt: plannerTaskEvent.occurredAt,
        actorName: plannerTaskEvent.actorName,
      })
      .from(plannerTaskEvent)
      .where(
        and(
          eq(plannerTaskEvent.userId, userId),
          inArray(plannerTaskEvent.taskId, ids),
          eq(plannerTaskEvent.type, "updated"),
          gte(plannerTaskEvent.occurredAt, from),
        ),
      )
      .all(),
  );
  const entryIds = [
    ...new Set(
      judged
        .filter((row) => row.kind === "entry_new" || row.kind === "entry_edit")
        .map((row) => row.landedId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const entryRevisions = await inChunks(entryIds, (ids) =>
    db
      .select({
        memoId: memoRevisions.memoId,
        createdAt: memoRevisions.createdAt,
      })
      .from(memoRevisions)
      .where(
        and(
          eq(memoRevisions.userId, userId),
          inArray(memoRevisions.memoId, ids),
          gte(memoRevisions.createdAt, from),
        ),
      )
      .all(),
  );
  let kept = 0;
  for (const row of judged) {
    if (row.state !== "accepted" || !row.settledAt) continue;
    const start = Date.parse(row.settledAt) + SAME_WRITE_MS;
    const end = Date.parse(row.settledAt) + KEEP_DAYS * DAY_MS;
    const within = (iso: string) => {
      const at = Date.parse(iso);
      return at > start && at <= end;
    };
    let changed = false;
    if (row.kind === "task_change" || row.kind === "task_new") {
      const id = row.taskId ?? row.landedId;
      changed = ownerEdits.some(
        (edit) =>
          edit.taskId === id &&
          within(edit.occurredAt) &&
          !edit.actorName?.startsWith("proposal:"),
      );
    } else if (row.kind === "entry_new" || row.kind === "entry_edit") {
      changed = entryRevisions.some(
        (revision) =>
          revision.memoId === row.landedId && within(revision.createdAt),
      );
    }
    if (!changed) kept += 1;
  }
  put(tally, "kept_7d", "ai", { num: kept, den: judged.length });

  // --- Diary entries written in the week: edited within seven days?
  const aiEntries = new Set(
    (
      await db
        .select({ landedId: plannerAgentAction.landedId })
        .from(plannerAgentAction)
        .where(
          and(
            eq(plannerAgentAction.userId, userId),
            eq(plannerAgentAction.kind, "entry_new"),
            eq(plannerAgentAction.state, "accepted"),
            isNotNull(plannerAgentAction.landedId),
          ),
        )
        .all()
    ).map((row) => row.landedId),
  );
  const written = (
    await db
      .select({
        id: memos.id,
        content: memos.content,
        createdAt: memos.createdAt,
        source: memos.source,
      })
      .from(memos)
      .where(
        and(
          eq(memos.userId, userId),
          gte(memos.createdAt, from),
          lt(memos.createdAt, to),
          isNull(memos.deletedAt),
          ne(memos.source, plannerSummaryMemoSource),
        ),
      )
      .all()
  ).filter((memo) => matured(memo.createdAt));
  const revisions = await inChunks(
    written.map((memo) => memo.id),
    (ids) =>
      db
        .select({
          memoId: memoRevisions.memoId,
          content: memoRevisions.content,
          createdAt: memoRevisions.createdAt,
        })
        .from(memoRevisions)
        .where(
          and(
            eq(memoRevisions.userId, userId),
            inArray(memoRevisions.memoId, ids),
          ),
        )
        .orderBy(asc(memoRevisions.createdAt))
        .all(),
  );
  const entries = { ai: { num: 0, den: 0 }, manual: { num: 0, den: 0 } };
  const sizes: Record<"ai" | "manual", number[]> = { ai: [], manual: [] };
  for (const memo of written) {
    const origin = aiEntries.has(memo.id) ? "ai" : "manual";
    const start = Date.parse(memo.createdAt) + SAME_WRITE_MS;
    const end = Date.parse(memo.createdAt) + KEEP_DAYS * DAY_MS;
    const own = revisions.filter((revision) => revision.memoId === memo.id);
    // A revision holds the text as it was just before that save.
    const first = own.find((revision) => {
      const at = Date.parse(revision.createdAt);
      return at > start && at <= end;
    });
    const after = own.find((revision) => Date.parse(revision.createdAt) > end);
    const size = first
      ? plannerEditChars(first.content, after?.content ?? memo.content)
      : 0;
    entries[origin].den += 1;
    if (size > 0) {
      entries[origin].num += 1;
      sizes[origin].push(size);
    }
  }
  for (const origin of ["ai", "manual"] as const) {
    put(tally, "entries_edited_7d", origin, entries[origin]);
    put(tally, "entry_edit_chars", origin, {
      num: sizes[origin].length,
      den: entries[origin].den,
      value: median(sizes[origin]),
    });
  }

  // --- Tasks: done by their due day, carried over; the agent's are the ones
  // an accepted proposal added.
  const aiTasks = new Set(
    (
      await db
        .select({ landedId: plannerAgentAction.landedId })
        .from(plannerAgentAction)
        .where(
          and(
            eq(plannerAgentAction.userId, userId),
            eq(plannerAgentAction.kind, "task_new"),
            eq(plannerAgentAction.state, "accepted"),
            isNotNull(plannerAgentAction.landedId),
          ),
        )
        .all()
    ).map((row) => row.landedId),
  );
  const lastDay = plannerAddDays(weekStart, 6);
  const due = await db
    .select({
      id: tasks.id,
      dueAt: tasks.dueAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        isNull(tasks.deletedAt),
        gte(tasks.dueAt, weekStart),
        lt(tasks.dueAt, `${lastDay}~`),
      ),
    )
    .all();
  const doneByDue = {
    ai: { num: 0, den: 0 },
    manual: { num: 0, den: 0 },
    all: { num: 0, den: 0 },
  };
  for (const task of due) {
    const day = task.dueAt?.slice(0, 10);
    if (!day || day < weekStart || day > lastDay) continue;
    const origin = aiTasks.has(task.id) ? "ai" : "manual";
    const done = Boolean(
      task.completedAt && task.completedAt.slice(0, 10) <= day,
    );
    for (const key of [origin, "all"] as const) {
      doneByDue[key].den += 1;
      if (done) doneByDue[key].num += 1;
    }
  }
  for (const origin of ["ai", "manual", "all"] as const) {
    put(tally, "tasks_done_by_due", origin, doneByDue[origin]);
  }

  const moves = await db
    .select({
      taskId: plannerTaskEvent.taskId,
      type: plannerTaskEvent.type,
      data: plannerTaskEvent.data,
    })
    .from(plannerTaskEvent)
    .where(
      and(
        eq(plannerTaskEvent.userId, userId),
        inArray(plannerTaskEvent.type, [
          "planned",
          "replanned",
          "carried_over",
        ]),
        gte(plannerTaskEvent.occurredAt, plusDays(from, -14)),
        lt(plannerTaskEvent.occurredAt, plusDays(to, 7)),
      ),
    )
    .all();
  const plannedIn = new Set<string>();
  const carriedOut = new Set<string>();
  for (const move of moves) {
    const data =
      typeof move.data === "string" ? safeJson(move.data) : move.data;
    const into = moveOf(data, "to");
    const out = moveOf(data, "from");
    if (into?.horizon === "week" && into.period_start === weekStart) {
      plannedIn.add(move.taskId);
    }
    if (
      move.type === "carried_over" &&
      out?.horizon === "week" &&
      out.period_start === weekStart
    ) {
      plannedIn.add(move.taskId);
      carriedOut.add(move.taskId);
    }
  }
  const carried = {
    ai: { num: 0, den: 0 },
    manual: { num: 0, den: 0 },
    all: { num: 0, den: 0 },
  };
  for (const taskId of plannedIn) {
    const origin = aiTasks.has(taskId) ? "ai" : "manual";
    for (const key of [origin, "all"] as const) {
      carried[key].den += 1;
      if (carriedOut.has(taskId)) carried[key].num += 1;
    }
  }
  for (const origin of ["ai", "manual", "all"] as const) {
    put(tally, "tasks_carried", origin, carried[origin]);
  }

  // --- The week's goals: met, by who proposed them.
  const goals = await db
    .select({ id: plannerGoal.id, result: plannerGoal.result })
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.userId, userId),
        eq(plannerGoal.level, "week"),
        eq(plannerGoal.periodStart, weekStart),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .all();
  const aiGoals = await plannerAcceptedGoalProposals(
    db,
    userId,
    goals.map((goal) => goal.id),
  );
  const met = {
    ai: { num: 0, den: 0 },
    manual: { num: 0, den: 0 },
    all: { num: 0, den: 0 },
  };
  for (const goal of goals) {
    if (!goal.result) continue;
    const origin = aiGoals.has(goal.id) ? "ai" : "manual";
    for (const key of [origin, "all"] as const) {
      met[key].den += 1;
      if (goal.result === "met") met[key].num += 1;
    }
  }
  for (const origin of ["ai", "manual", "all"] as const) {
    put(tally, "goals_met", origin, met[origin]);
  }

  // --- From the log: goal rewrites in the week, and the reviewed week's memo.
  const logged = await db
    .select()
    .from(plannerEvent)
    .where(
      and(
        eq(plannerEvent.userId, userId),
        inArray(plannerEvent.kind, [
          "goal.rewritten",
          "review.look_back_saved",
        ]),
        gte(plannerEvent.occurredAt, from),
        lt(plannerEvent.occurredAt, plusDays(to, 14)),
      ),
    )
    .orderBy(asc(plannerEvent.occurredAt))
    .all();
  const rewrites = logged.filter(
    (event) =>
      event.kind === "goal.rewritten" &&
      event.occurredAt >= from &&
      event.occurredAt < to,
  ).length;
  put(tally, "goals_rewritten", "all", {
    num: rewrites,
    den: 0,
    value: rewrites,
  });
  const memoSave = logged
    .filter(
      (event) =>
        event.kind === "review.look_back_saved" &&
        event.subjectId === weekStart &&
        typeof event.data.rewrite_rate === "number",
    )
    .at(-1);
  const rewriteRate = memoSave ? Number(memoSave.data.rewrite_rate) : null;
  put(tally, "memo_rewrite_rate", "all", {
    num: memoSave ? 1 : 0,
    den: memoSave ? 1 : 0,
    value: rewriteRate,
  });

  // --- What the agent cost against what was kept.
  const spend = await db
    .select({
      cents: sql<number>`coalesce(sum(${plannerAgentRun.costCents}), 0)`,
    })
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.userId, userId),
        gte(plannerAgentRun.createdAt, from),
        lt(plannerAgentRun.createdAt, to),
      ),
    )
    .get();
  const cents = Number(spend?.cents ?? 0);
  put(tally, "cost_per_kept", "ai", {
    num: cents,
    den: kept,
    value: kept > 0 ? Math.round(cents / kept) : null,
  });

  // --- Write the week, replacing what the last rollup left.
  const values: PlannerMetricValueDto[] = [];
  for (const metric of plannerFlywheelMetricNames) {
    for (const origin of plannerFlywheelMetrics[metric].origins) {
      const count = tally[metric]?.[origin] ?? { num: 0, den: 0 };
      values.push({
        metric,
        origin,
        value:
          count.value !== undefined ? count.value : share(count.num, count.den),
        num: count.num,
        den: count.den,
      });
    }
  }
  await plannerRunBatch(db, [
    db
      .delete(plannerMetricWeek)
      .where(
        and(
          eq(plannerMetricWeek.userId, userId),
          eq(plannerMetricWeek.weekStart, weekStart),
        ),
      ),
    ...values.map((value) =>
      db.insert(plannerMetricWeek).values({
        userId,
        weekStart,
        metric: value.metric,
        origin: value.origin,
        value: value.value,
        num: value.num,
        den: value.den,
        computedAt: nowIso,
      }),
    ),
  ]);
  return { week_start: weekStart, values };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The Monday of the week `now` falls in, UTC. */
export function plannerFlywheelWeekOf(now: Date): string {
  return plannerWeekStartOf(now.toISOString().slice(0, 10));
}

/**
 * The nightly sweep's part: rebuilds the current week and the three before it
 * for everyone with goals, tasks or agent proposals. Never throws.
 */
export async function plannerFlywheelNightly(
  db: FlareMoDb,
  now: Date,
): Promise<{ users: number; weeks: number }> {
  let users: string[] = [];
  try {
    const rows = await db.all<{ user_id: string }>(
      sql`SELECT user_id FROM planner_goal UNION SELECT user_id FROM planner_agent_action UNION SELECT user_id FROM tasks`,
    );
    users = rows.map((row) => row.user_id);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Flywheel sweep could not list users",
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
    return { users: 0, weeks: 0 };
  }
  const thisWeek = plannerFlywheelWeekOf(now);
  let weeks = 0;
  for (const userId of users) {
    for (let back = 0; back < NIGHTLY_WEEKS; back += 1) {
      try {
        await plannerFlywheelRollup(db, {
          userId,
          weekStart: plannerAddDays(thisWeek, -7 * back),
          now,
        });
        weeks += 1;
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Flywheel rollup failed",
            error:
              error instanceof Error ? error.message.slice(0, 200) : "unknown",
          }),
        );
      }
    }
  }
  return { users: users.length, weeks };
}

/** The scorecard of `weeks` weeks ending with `weekStart`, newest first. */
export async function plannerReadScorecard(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; weeks: number },
): Promise<PlannerMetricWeekDto[]> {
  const first = plannerAddDays(input.weekStart, -7 * (input.weeks - 1));
  const rows = await db
    .select()
    .from(plannerMetricWeek)
    .where(
      and(
        eq(plannerMetricWeek.userId, input.userId),
        gte(plannerMetricWeek.weekStart, first),
        lt(plannerMetricWeek.weekStart, plannerAddDays(input.weekStart, 1)),
      ),
    )
    .all();
  const known = new Set<string>(plannerFlywheelMetricNames);
  const byWeek = new Map<string, PlannerMetricValueDto[]>();
  for (const row of rows) {
    if (!known.has(row.metric)) continue;
    const list = byWeek.get(row.weekStart) ?? [];
    list.push({
      metric: row.metric as PlannerFlywheelMetric,
      origin: row.origin,
      value: row.value,
      num: row.num,
      den: row.den,
    });
    byWeek.set(row.weekStart, list);
  }
  return [...byWeek.entries()]
    .sort(([left], [right]) => (left < right ? 1 : -1))
    .map(([week, values]) => ({ week_start: week, values }));
}

/** One metric over several weeks, pooled: shares by their cases, else the mean. */
export function plannerPooledMetric(
  weeks: readonly PlannerMetricWeekDto[],
  metric: PlannerFlywheelMetric,
  origin: PlannerFlywheelOrigin,
): { value: number | null; den: number } {
  const values = weeks
    .map((week) =>
      week.values.find(
        (value) => value.metric === metric && value.origin === origin,
      ),
    )
    .filter((value): value is PlannerMetricValueDto => Boolean(value));
  if (plannerFlywheelMetrics[metric].unit === "share") {
    const num = values.reduce((sum, value) => sum + value.num, 0);
    const den = values.reduce((sum, value) => sum + value.den, 0);
    return { value: share(num, den), den };
  }
  const present = values.filter((value) => value.value !== null);
  if (present.length === 0) return { value: null, den: 0 };
  return {
    value:
      present.reduce((sum, value) => sum + (value.value ?? 0), 0) /
      present.length,
    den: values.reduce((sum, value) => sum + value.den, 0),
  };
}

/** The origin a metric is judged on: the agent's side when it has one. */
export function plannerMetricOrigin(
  metric: PlannerFlywheelMetric,
): PlannerFlywheelOrigin {
  const origins: readonly PlannerFlywheelOrigin[] =
    plannerFlywheelMetrics[metric].origins;
  return origins.includes("ai") ? "ai" : (origins[0] ?? "all");
}

/**
 * Whether the agent's proposing is paused: over the fourteen days before the
 * last one it made at least PLANNER_FLYWHEEL_PAUSE_MIN proposals and fewer
 * than one in ten was ever shown to the owner. Proposing nobody looks at only spends money.
 */
export async function plannerFlywheelProposalsPaused(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<boolean> {
  const nowIso = plannerNow(input.now).toISOString();
  const since = plusDays(nowIso, -14);
  // The last day's proposals are left out: the owner has not had the chance
  // to open them yet, and one busy chat must not pause itself.
  const until = plusDays(nowIso, -1);
  const row = await db
    .select({
      made: sql<number>`count(*)`,
      shown: sql<number>`count(${plannerAgentAction.shownAt})`,
    })
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        gte(plannerAgentAction.createdAt, since),
        lt(plannerAgentAction.createdAt, until),
      ),
    )
    .get();
  const made = Number(row?.made ?? 0);
  const shown = Number(row?.shown ?? 0);
  return made >= PLANNER_FLYWHEEL_PAUSE_MIN && shown * 10 < made;
}

/**
 * Records that the owner opened the scorecard and says how many days it had
 * been since the last time (null for the first). One row an hour at most.
 */
export async function plannerFlywheelViewed(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; now?: Date },
): Promise<number | null> {
  const now = plannerNow(input.now);
  const last = await db
    .select({ occurredAt: plannerEvent.occurredAt })
    .from(plannerEvent)
    .where(
      and(
        eq(plannerEvent.userId, input.userId),
        eq(plannerEvent.kind, "scorecard.viewed"),
      ),
    )
    .orderBy(desc(plannerEvent.occurredAt))
    .get();
  const ago = last ? now.getTime() - Date.parse(last.occurredAt) : null;
  if (ago === null || ago > 3_600_000) {
    await plannerRecordEvents(
      db,
      [
        {
          userId: input.userId,
          kind: "scorecard.viewed",
          subject: "scorecard",
          subjectId: input.weekStart,
        },
      ],
      now,
    );
  }
  return ago === null ? null : Math.floor(ago / DAY_MS);
}

// ---------------------------------------------------------------------------
// The tuning
// ---------------------------------------------------------------------------

export function plannerTuningToDto(row: PlannerTuningRow): PlannerTuningDto {
  const known = new Set<string>(plannerFlywheelMetricNames);
  return {
    id: row.id,
    version: row.version,
    instructions: row.instructions,
    why: row.why,
    metric:
      row.metric && known.has(row.metric)
        ? (row.metric as PlannerFlywheelMetric)
        : null,
    baseline: row.baseline,
    state: row.state,
    proposed_by: row.proposedBy,
    created_at: row.createdAt,
    activated_at: row.activatedAt,
    judged_at: row.judgedAt,
  };
}

/** The version the agent follows now: the newest active or kept one. */
export async function plannerCurrentTuning(
  db: FlareMoDb,
  userId: string,
): Promise<PlannerTuningRow | null> {
  const row = await db
    .select()
    .from(plannerTuning)
    .where(
      and(
        eq(plannerTuning.userId, userId),
        inArray(plannerTuning.state, ["active", "kept"]),
      ),
    )
    .orderBy(desc(plannerTuning.version))
    .get();
  return row ?? null;
}

/** The proposal waiting for the owner, if any. */
export async function plannerOpenTuningProposal(
  db: FlareMoDb,
  userId: string,
): Promise<PlannerTuningRow | null> {
  const row = await db
    .select()
    .from(plannerTuning)
    .where(
      and(
        eq(plannerTuning.userId, userId),
        eq(plannerTuning.state, "proposed"),
      ),
    )
    .orderBy(desc(plannerTuning.createdAt))
    .get();
  return row ?? null;
}

/**
 * The standing instructions as the agent reads them on a session's first
 * message, or "" when there are none.
 */
export function plannerTuningBlock(
  tuning: Pick<PlannerTuningRow, "version" | "instructions"> | null,
): string {
  const text = tuning?.instructions.trim();
  if (!tuning || !text) return "";
  return `Standing instructions from the owner (version ${tuning.version ?? "?"}). They come from what the owner kept, edited and undid of your earlier work. Follow them in this session:\n\n${text}`;
}

/** Whether a new tuning proposal is due: none open and none in the last four weeks. */
export async function plannerTuningProposalDue(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<boolean> {
  const since = plusDays(
    plannerNow(input.now).toISOString(),
    -PLANNER_FLYWHEEL_TUNING_DAYS,
  );
  const recent = await db
    .select({ id: plannerTuning.id })
    .from(plannerTuning)
    .where(
      and(
        eq(plannerTuning.userId, input.userId),
        gte(plannerTuning.createdAt, since),
      ),
    )
    .get();
  if (recent) return false;
  return !(await plannerOpenTuningProposal(db, input.userId));
}

/** The weekly notes to the agent from the last `weeks` weeks, oldest first. */
export async function plannerRecentTuningNotes(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; weeks: number },
): Promise<Array<{ week: string; note: string }>> {
  const first = plannerAddDays(input.weekStart, -7 * input.weeks);
  const rows = await db
    .select({ week: plannerWeek.weekStart, note: plannerWeek.tuningNote })
    .from(plannerWeek)
    .where(
      and(
        eq(plannerWeek.userId, input.userId),
        gte(plannerWeek.weekStart, first),
        isNotNull(plannerWeek.tuningNote),
      ),
    )
    .orderBy(asc(plannerWeek.weekStart))
    .all();
  return rows
    .filter((row) => row.note?.trim())
    .map((row) => ({ week: row.week, note: row.note ?? "" }));
}

/**
 * Saves the owner's note to the agent for a reviewed week, or a pass (null),
 * with the tuning version they were reviewing under.
 */
export async function plannerSaveTuningNote(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    note: string | null;
    now?: Date;
  },
): Promise<void> {
  const nowIso = plannerNow(input.now).toISOString();
  const note = input.note?.trim() ?? "";
  const current = await plannerCurrentTuning(db, input.userId);
  const tuningVersion = current?.version ?? null;
  await plannerRunBatch(db, [
    db
      .insert(plannerWeek)
      .values({
        userId: input.userId,
        weekStart: input.weekStart,
        source: "review",
        tuningNote: note,
        tuningVersion,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [plannerWeek.userId, plannerWeek.weekStart],
        set: { tuningNote: note, tuningVersion, updatedAt: nowIso },
      }),
  ]);
  await plannerRecordEvents(
    db,
    [
      {
        userId: input.userId,
        kind: note ? "review.tuning_note" : "review.tuning_skipped",
        subject: "review",
        subjectId: input.weekStart,
        data: { length: note.length, tuning_version: tuningVersion },
      },
    ],
    input.now,
  );
}

/** The scorecard metric's mean over the four weeks before `weekStart`. */
async function baselineOf(
  db: FlareMoDb,
  input: { userId: string; metric: PlannerFlywheelMetric; weekStart: string },
): Promise<number | null> {
  const weeks = await plannerReadScorecard(db, {
    userId: input.userId,
    weekStart: plannerAddDays(input.weekStart, -7),
    weeks: 4,
  });
  return plannerPooledMetric(
    weeks,
    input.metric,
    plannerMetricOrigin(input.metric),
  ).value;
}

/**
 * Files a tuning proposal, replacing an open one. The baseline is the metric
 * over the four weeks before this one.
 */
export async function plannerAddTuningProposal(
  db: FlareMoDb,
  input: {
    userId: string;
    instructions: string;
    why: string;
    metric: PlannerFlywheelMetric | null;
    proposedBy: "agent" | "owner";
    model?: string | null;
    now?: Date;
  },
): Promise<PlannerTuningDto> {
  const now = plannerNow(input.now);
  const nowIso = now.toISOString();
  const instructions = input.instructions
    .trim()
    .slice(0, plannerTuningInstructionsMax);
  if (!instructions) throw new ValidationError("The instructions are empty.");
  const current = await plannerCurrentTuning(db, input.userId);
  const baseline = input.metric
    ? await baselineOf(db, {
        userId: input.userId,
        metric: input.metric,
        weekStart: plannerFlywheelWeekOf(now),
      })
    : null;
  const row: PlannerTuningRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    version: null,
    instructions,
    why: input.why.trim().slice(0, 600),
    metric: input.metric,
    baseline,
    state: "proposed",
    proposedBy: input.proposedBy,
    model: input.model ?? null,
    parentId: current?.id ?? null,
    createdAt: nowIso,
    activatedAt: null,
    judgedAt: null,
    settledAt: null,
  };
  await plannerRunBatch(db, [
    db
      .update(plannerTuning)
      .set({ state: "dismissed", settledAt: nowIso })
      .where(
        and(
          eq(plannerTuning.userId, input.userId),
          eq(plannerTuning.state, "proposed"),
        ),
      ),
    db.insert(plannerTuning).values(row),
  ]);
  await plannerRecordEvents(
    db,
    [
      {
        userId: input.userId,
        kind: "tuning.proposed",
        subject: "tuning",
        subjectId: row.id,
        data: {
          proposed_by: input.proposedBy,
          metric: input.metric,
          length: instructions.length,
          edit_chars: plannerEditChars(
            current?.instructions ?? "",
            instructions,
          ),
        },
      },
    ],
    now,
  );
  return plannerTuningToDto(row);
}

async function loadTuning(
  db: FlareMoDb,
  userId: string,
  id: string,
): Promise<PlannerTuningRow> {
  const row = await db
    .select()
    .from(plannerTuning)
    .where(and(eq(plannerTuning.userId, userId), eq(plannerTuning.id, id)))
    .get();
  if (!row) throw new NotFoundError("That tuning is gone.");
  return row;
}

async function nextVersion(db: FlareMoDb, userId: string): Promise<number> {
  const row = await db
    .select({ top: sql<number | null>`max(${plannerTuning.version})` })
    .from(plannerTuning)
    .where(eq(plannerTuning.userId, userId))
    .get();
  return Number(row?.top ?? 0) + 1;
}

/** Whether a version has run its four weeks and waits for keep or roll back. */
export function plannerTuningJudgeable(
  row: PlannerTuningRow,
  now: Date,
): boolean {
  return (
    row.state === "active" &&
    !row.judgedAt &&
    Boolean(row.activatedAt) &&
    Date.parse(row.activatedAt ?? "") + PLANNER_FLYWHEEL_TUNING_DAYS * DAY_MS <=
      now.getTime()
  );
}

/**
 * Settles a tuning row. A proposal is accepted (with the owner's edits, which
 * become the active version) or dismissed; a version four weeks on is kept or
 * rolled back (the version before it becomes active again as a new row).
 */
export async function plannerSettleTuning(
  db: FlareMoDb,
  input: {
    userId: string;
    id: string;
    decision: "accept" | "dismiss" | "keep" | "roll_back";
    instructions?: string;
    now?: Date;
  },
): Promise<void> {
  const now = plannerNow(input.now);
  const nowIso = now.toISOString();
  const row = await loadTuning(db, input.userId, input.id);
  const current = await plannerCurrentTuning(db, input.userId);
  const event = (kind: string, data: PlannerEventData) =>
    plannerRecordEvents(
      db,
      [
        {
          userId: input.userId,
          kind,
          subject: "tuning",
          subjectId: row.id,
          origin: row.proposedBy === "agent" ? "proposal" : "manual",
          proposalId: row.proposedBy === "agent" ? row.id : null,
          data,
        },
      ],
      now,
    );

  if (input.decision === "accept" || input.decision === "dismiss") {
    if (row.state !== "proposed") {
      throw new ValidationError("This proposal was already settled.");
    }
    if (input.decision === "dismiss") {
      await db
        .update(plannerTuning)
        .set({ state: "dismissed", settledAt: nowIso })
        .where(eq(plannerTuning.id, row.id))
        .run();
      await event("tuning.dismissed", { metric: row.metric });
      return;
    }
    const instructions = (input.instructions ?? row.instructions)
      .trim()
      .slice(0, plannerTuningInstructionsMax);
    const version = await nextVersion(db, input.userId);
    await plannerRunBatch(db, [
      ...(current
        ? [
            db
              .update(plannerTuning)
              .set({ state: "superseded", settledAt: nowIso })
              .where(eq(plannerTuning.id, current.id)),
          ]
        : []),
      db
        .update(plannerTuning)
        .set({
          state: "active",
          version,
          instructions,
          activatedAt: nowIso,
          settledAt: nowIso,
        })
        .where(eq(plannerTuning.id, row.id)),
    ]);
    await event("tuning.accepted", {
      version,
      metric: row.metric,
      edited: instructions !== row.instructions,
      edit_chars: plannerEditChars(row.instructions, instructions),
    });
    return;
  }

  if (current?.id !== row.id || row.state !== "active" || row.judgedAt) {
    throw new ValidationError("This version is not waiting for a verdict.");
  }
  if (input.decision === "keep") {
    await db
      .update(plannerTuning)
      .set({ state: "kept", judgedAt: nowIso })
      .where(eq(plannerTuning.id, row.id))
      .run();
    await event("tuning.kept", { version: row.version, metric: row.metric });
    return;
  }
  const parent = row.parentId
    ? await db
        .select()
        .from(plannerTuning)
        .where(eq(plannerTuning.id, row.parentId))
        .get()
    : undefined;
  const version = await nextVersion(db, input.userId);
  await plannerRunBatch(db, [
    db
      .update(plannerTuning)
      .set({ state: "rolled_back", judgedAt: nowIso, settledAt: nowIso })
      .where(eq(plannerTuning.id, row.id)),
    db.insert(plannerTuning).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      version,
      instructions: parent?.instructions ?? "",
      why: `Rolled back from version ${row.version ?? "?"}.`,
      metric: null,
      baseline: null,
      // Judged already: the version it restores had its four weeks.
      state: "kept",
      proposedBy: "owner",
      model: null,
      parentId: row.id,
      createdAt: nowIso,
      activatedAt: nowIso,
      judgedAt: nowIso,
      settledAt: nowIso,
    }),
  ]);
  await event("tuning.rolled_back", {
    version: row.version,
    restored_version: version,
    metric: row.metric,
  });
}

/** The verdict card for the current version, once its four weeks are up. */
export async function plannerTuningVerdict(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<PlannerTuningVerdictDto | null> {
  const now = plannerNow(input.now);
  const current = await plannerCurrentTuning(db, input.userId);
  if (!current?.metric || !current.activatedAt) return null;
  if (!plannerTuningJudgeable(current, now)) return null;
  const tuning = plannerTuningToDto(current);
  if (!tuning.metric) return null;
  const firstWeek = plannerWeekStartOf(current.activatedAt.slice(0, 10));
  const weeks = await plannerReadScorecard(db, {
    userId: input.userId,
    weekStart: plannerAddDays(firstWeek, 21),
    weeks: 4,
  });
  const after = plannerPooledMetric(
    weeks,
    tuning.metric,
    plannerMetricOrigin(tuning.metric),
  );
  return {
    tuning,
    metric: tuning.metric,
    before: current.baseline,
    after: after.value,
    after_den: after.den,
  };
}

// ---------------------------------------------------------------------------
// The tuning proposal's prompt
// ---------------------------------------------------------------------------

function percent(value: number | null): string {
  return value === null ? "none" : `${Math.round(value * 100)}%`;
}

function scorecardLines(weeks: readonly PlannerMetricWeekDto[]): string[] {
  const lines: string[] = [];
  for (const week of [...weeks].reverse()) {
    const parts = week.values
      .filter((value) => value.den > 0 || value.value !== null)
      .map((value) => {
        const meta = plannerFlywheelMetrics[value.metric];
        const shown =
          meta.unit === "share"
            ? `${percent(value.value)} of ${value.den}`
            : `${value.value ?? "none"}`;
        return `${value.metric}/${value.origin}=${shown}`;
      });
    lines.push(
      `- Week of ${week.week_start}: ${parts.join(", ") || "nothing to count"}`,
    );
  }
  return lines;
}

/**
 * The messages that ask a model for one tuning proposal: the current standing
 * instructions, four to eight weeks of scorecard and the owner's weekly notes
 * to the agent. No diary text is sent.
 */
export function plannerTuningProposalMessages(input: {
  ownerName: string;
  current: Pick<PlannerTuningRow, "version" | "instructions"> | null;
  weeks: readonly PlannerMetricWeekDto[];
  notes: ReadonlyArray<{ week: string; note: string }>;
}): PlannerChatMessage[] {
  const metrics = plannerFlywheelMetricNames
    .map((name) => `- ${name}: ${plannerFlywheelMetrics[name].label}`)
    .join("\n");
  const system = `You tune a diary agent for its one user, ${input.ownerName}. The agent reads ${input.ownerName}'s diary, goals and tasks, runs the weekly review with them, and proposes goals, tasks, task changes and diary entries that ${input.ownerName} accepts or dismisses. The agent follows a short block of standing instructions that ${input.ownerName} approves. Your job: propose ONE revision of that block that should move ONE scorecard number in the right direction, based only on the numbers and ${input.ownerName}'s own notes below.

Rules:
- Change one thing at a time; keep every earlier instruction that still holds.
- Instructions tell the agent how to behave (what to propose, how much, in what tone). They never put words in ${input.ownerName}'s mouth or decide for them.
- A share over fewer than 10 cases is noise: do not tune on it.
- Plain English, at most 12 short lines, no headings.

Scorecard metrics (origin ai = started by the agent's proposal, manual = by ${input.ownerName}):
${metrics}

Answer with JSON only: {"instructions": "<the whole revised block>", "why": "<one or two sentences: which number, what you expect>", "metric": "<one metric name from the list>"}`;
  const user = [
    `Current standing instructions (version ${input.current?.version ?? "none"}):`,
    input.current?.instructions.trim() || "(none yet)",
    "",
    "Scorecard, oldest week first:",
    ...scorecardLines(input.weeks),
    "",
    `${input.ownerName}'s weekly notes to the agent ("What should the agent do differently?"):`,
    ...(input.notes.length
      ? input.notes.map((note) => `- Week of ${note.week}: ${note.note}`)
      : ["(none)"]),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** The model's tuning proposal, or null when it is not usable. */
export function plannerParseTuningProposal(text: string): {
  instructions: string;
  why: string;
  metric: PlannerFlywheelMetric | null;
} | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = safeJson(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const instructions =
    typeof record.instructions === "string" ? record.instructions.trim() : "";
  if (!instructions) return null;
  const metric =
    typeof record.metric === "string" &&
    (plannerFlywheelMetricNames as string[]).includes(record.metric)
      ? (record.metric as PlannerFlywheelMetric)
      : null;
  return {
    instructions: instructions.slice(0, plannerTuningInstructionsMax),
    why: typeof record.why === "string" ? record.why.trim().slice(0, 600) : "",
    metric,
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Whether a week's scorecard was built within the last hour. */
async function scorecardFresh(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; now: Date },
): Promise<boolean> {
  const row = await db
    .select({ at: sql<string | null>`max(${plannerMetricWeek.computedAt})` })
    .from(plannerMetricWeek)
    .where(
      and(
        eq(plannerMetricWeek.userId, input.userId),
        eq(plannerMetricWeek.weekStart, input.weekStart),
      ),
    )
    .get();
  if (!row?.at) return false;
  return input.now.getTime() - Date.parse(row.at) < 3_600_000;
}

/**
 * Everything the Sunday review's scorecard card shows for the reviewed week:
 * the numbers (rebuilt first when older than an hour), the tuning, the owner's
 * note and the guardrails. Records the visit.
 */
export async function plannerReadFlywheel(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    canPropose: boolean;
    now?: Date;
  },
): Promise<PlannerFlywheelResponse> {
  const now = plannerNow(input.now);
  const { userId, weekStart } = input;
  if (!(await scorecardFresh(db, { userId, weekStart, now }))) {
    await plannerFlywheelRollup(db, { userId, weekStart, now });
  }
  const lastViewed = await plannerFlywheelViewed(db, {
    userId,
    weekStart,
    now,
  });
  const [weeks, current, proposal, verdict, due, paused, week] =
    await Promise.all([
      plannerReadScorecard(db, { userId, weekStart, weeks: 8 }),
      plannerCurrentTuning(db, userId),
      plannerOpenTuningProposal(db, userId),
      plannerTuningVerdict(db, { userId, now }),
      plannerTuningProposalDue(db, { userId, now }),
      plannerFlywheelProposalsPaused(db, { userId, now }),
      db
        .select({ note: plannerWeek.tuningNote })
        .from(plannerWeek)
        .where(
          and(
            eq(plannerWeek.userId, userId),
            eq(plannerWeek.weekStart, weekStart),
          ),
        )
        .get(),
    ]);
  const note = week?.note ?? null;
  return {
    week_start: weekStart,
    weeks,
    current: current ? plannerTuningToDto(current) : null,
    proposal: proposal ? plannerTuningToDto(proposal) : null,
    verdict,
    proposal_due: due,
    note: note?.trim() ? note : null,
    note_skipped: note === "",
    last_viewed_days: lastViewed,
    proposing_paused: paused,
    can_propose: input.canPropose,
  };
}
