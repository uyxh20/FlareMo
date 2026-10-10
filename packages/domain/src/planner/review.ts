import {
  type PlannerCommitResponse,
  type PlannerGoalDto,
  type PlannerGoalFlagDto,
  type PlannerGoalResult,
  type PlannerPillar,
  type PlannerReviewResponse,
  type PlannerReviewStatusResponse,
  type PlannerVerdictKind,
  type PlannerWeekDto,
  plannerAddDays,
  plannerKeyQuestionLine,
  plannerMemoNextSteps,
  plannerReviewDueDay,
  plannerReviewStateMax,
  plannerReviewWeekFor,
  plannerSnapScore,
  plannerSummaryMemoClientId,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
  plannerTodoMarker,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb, MemoPayload, MemoRow } from "@flaremo/db";
import {
  type PlannerGoalFlagRow,
  type PlannerReviewRow,
  plannerGoal,
  plannerGoalFlag,
  plannerReview,
  plannerTaskPlan,
  plannerWeek,
} from "@flaremo/db/src/schema/planner";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getMemoByClientId } from "../memos-read";
import { createMemo, updateMemo } from "../memos-write";
import type { QuotaScope } from "../quotas";
import type { TeamViewer } from "../team-permissions";
import { plannerReadBoard } from "./board";
import { plannerRespreadColumn } from "./board-rank";
import { type PlannerColumn, plannerColumnFor } from "./columns";
import {
  plannerReadWeek,
  plannerReadWeekGoals,
  plannerRequireMonday,
  plannerSetTaskGoal,
  plannerWeekUpsertStatement,
} from "./goals";
import { plannerApplyColumnMove, plannerCreateTask } from "./plans";
import {
  plannerFindSummaryMemo,
  plannerReadFlagGoals,
  plannerReadLastQuestion,
} from "./review-context";
import { plannerCleanMemo } from "./review-prompts";
import {
  type PlannerActor,
  plannerLoadLiveTask,
  plannerLoadPlan,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// The weekly review (fork-owned add-on, docs/planning-cockpit-goals-review.md):
// what the review page reads, its saved progress, and the two saves that change
// the owner's data. Look back writes the week's record (scores, the question for
// the next review, the verdict), last week's goal results and the summary memo.
// Look forward writes the next week's goals, links and plans their tasks, and
// keeps what the conflict check flagged.
//
// Both saves can be sent again safely. The summary memo is one memo per week
// (its client id), the plan's goals carry the page's own ids, and each new task
// of the plan is created once per ref: `planner_review.commit_log` records the
// task each ref made before anything else happens to it. Task rows change only
// through upstream's services and the planner's own plan functions, which write
// their events.

/** How many weeks of scores the review's side panel draws. */
const SCORE_WEEKS = 19;

const LIVE_MEMO_STATUSES: readonly string[] = ["normal", "archived"];

/**
 * The week a review is about: `week` when given, else the week `today` looks
 * back on (plannerReviewWeekFor). A week that has not started yet is a 400; the
 * current week can be reviewed early.
 */
export function plannerResolveReviewWeek(
  today: string,
  week?: string | null,
): string {
  const day = plannerRequireDay(today, "today");
  if (week === undefined || week === null) return plannerReviewWeekFor(day);
  const monday = plannerRequireMonday(week, "The week");
  if (monday > plannerWeekStartOf(day)) {
    throw new ValidationError("That week has not started yet.");
  }
  return monday;
}

export function plannerGoalFlagToDto(
  row: PlannerGoalFlagRow,
): PlannerGoalFlagDto {
  return {
    id: row.id,
    week_start: row.weekStart,
    goal_id: row.goalId ?? null,
    pillar: row.pillar ?? null,
    with_goal_id: row.withGoalId ?? null,
    with_label: row.withLabel,
    why: row.why,
    state: row.state,
    created_at: row.createdAt,
    settled_at: row.settledAt ?? null,
  };
}

/** The caller's flags by id, in no particular order; unknown ids are left out. */
export async function plannerReadFlags(
  db: FlareMoDb,
  input: { userId: string; ids: readonly string[] },
): Promise<PlannerGoalFlagDto[]> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(plannerGoalFlag)
    .where(
      and(
        eq(plannerGoalFlag.userId, input.userId),
        inArray(plannerGoalFlag.id, ids),
      ),
    )
    .all();
  return rows.map(plannerGoalFlagToDto);
}

async function readReviewRow(
  db: FlareMoDb,
  userId: string,
  weekStart: string,
): Promise<PlannerReviewRow | undefined> {
  return db
    .select()
    .from(plannerReview)
    .where(
      and(
        eq(plannerReview.userId, userId),
        eq(plannerReview.weekStart, weekStart),
      ),
    )
    .get();
}

type ReviewFields = {
  state?: Record<string, unknown>;
  commitLog?: { tasks?: Record<string, string> };
  lookBackDoneAt?: string | null;
  lookForwardDoneAt?: string | null;
};

/** The statement that writes a review row; only the fields given change. */
function reviewUpsertStatement(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    fields: ReviewFields;
    nowIso: string;
  },
) {
  const { fields } = input;
  return db
    .insert(plannerReview)
    .values({
      userId: input.userId,
      weekStart: input.weekStart,
      state: fields.state ?? {},
      commitLog: fields.commitLog ?? {},
      lookBackDoneAt: fields.lookBackDoneAt ?? null,
      lookForwardDoneAt: fields.lookForwardDoneAt ?? null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .onConflictDoUpdate({
      target: [plannerReview.userId, plannerReview.weekStart],
      set: { ...fields, updatedAt: input.nowIso },
    });
}

/** The flags still open for a review of `weekStart`, oldest first. */
async function readOpenFlags(
  db: FlareMoDb,
  userId: string,
  weekStart: string,
): Promise<PlannerGoalFlagRow[]> {
  return db
    .select()
    .from(plannerGoalFlag)
    .where(
      and(
        eq(plannerGoalFlag.userId, userId),
        eq(plannerGoalFlag.state, "open"),
        lte(plannerGoalFlag.weekStart, weekStart),
      ),
    )
    .orderBy(asc(plannerGoalFlag.createdAt), asc(plannerGoalFlag.id))
    .all();
}

/** The scores of the 19 weeks ending with `weekStart`, oldest first; null where none. */
async function readScores(
  db: FlareMoDb,
  userId: string,
  weekStart: string,
): Promise<PlannerReviewResponse["scores"]> {
  const first = plannerAddDays(weekStart, -7 * (SCORE_WEEKS - 1));
  const rows = await db
    .select({
      weekStart: plannerWeek.weekStart,
      auth: plannerWeek.auth,
      ach: plannerWeek.ach,
    })
    .from(plannerWeek)
    .where(
      and(
        eq(plannerWeek.userId, userId),
        gte(plannerWeek.weekStart, first),
        lte(plannerWeek.weekStart, weekStart),
      ),
    )
    .all();
  const byWeek = new Map(rows.map((row) => [row.weekStart, row]));
  return Array.from({ length: SCORE_WEEKS }, (_, index) => {
    const week = plannerAddDays(first, index * 7);
    const row = byWeek.get(week);
    return { week_start: week, auth: row?.auth ?? null, ach: row?.ach ?? null };
  });
}

/**
 * Everything the review page needs for one week: its saved progress, last
 * week's question, the week's goals and the next week's, the open flags, the
 * scores, the week's record and summary, and the Next Steps to plan from.
 */
export async function plannerReadReview(
  db: FlareMoDb,
  input: { userId: string; today: string; week?: string | null; ai: boolean },
): Promise<PlannerReviewResponse> {
  const { userId } = input;
  const today = plannerRequireDay(input.today, "today");
  const reviewWeek = plannerResolveReviewWeek(today, input.week);
  const planWeek = plannerAddDays(reviewWeek, 7);

  const [
    review,
    lastQuestion,
    weekGoals,
    planGoals,
    flags,
    scores,
    week,
    summary,
  ] = await Promise.all([
    readReviewRow(db, userId, reviewWeek),
    plannerReadLastQuestion(db, { userId, weekStart: reviewWeek }),
    plannerReadWeekGoals(db, { userId, weekStart: reviewWeek }),
    plannerReadWeekGoals(db, { userId, weekStart: planWeek }),
    readOpenFlags(db, userId, reviewWeek),
    readScores(db, userId, reviewWeek),
    plannerReadWeek(db, { userId, weekStart: reviewWeek }),
    plannerFindSummaryMemo(db, { userId, weekStart: reviewWeek }),
  ]);
  const flagGoals = await plannerReadFlagGoals(db, { userId, flags });
  // The plan starts from the Next Steps of this week's summary once Look back
  // wrote it, else from last week's.
  const stepsFrom =
    summary ??
    (await plannerFindSummaryMemo(db, {
      userId,
      weekStart: plannerAddDays(reviewWeek, -7),
    }));

  return {
    today,
    review_week: reviewWeek,
    plan_week: planWeek,
    state: review ? review.state : null,
    look_back_done_at: review?.lookBackDoneAt ?? null,
    look_forward_done_at: review?.lookForwardDoneAt ?? null,
    last_question: lastQuestion,
    week_goals: weekGoals,
    plan_goals: planGoals,
    flags: flags.map(plannerGoalFlagToDto),
    flag_goals: flagGoals,
    scores,
    week,
    summary: summary ? { id: summary.id, content: summary.content } : null,
    suggested_goals: stepsFrom ? plannerMemoNextSteps(stepsFrom.content) : {},
    ai: input.ai,
  };
}

/**
 * Whether the review `today` points at is due, for the sidebar's dot: from
 * Saturday to Monday, until both parts are done.
 */
export async function plannerReviewStatus(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerReviewStatusResponse> {
  const today = plannerRequireDay(input.today, "today");
  const reviewWeek = plannerReviewWeekFor(today);
  const review = await readReviewRow(db, input.userId, reviewWeek);
  const lookBackDone = Boolean(review?.lookBackDoneAt);
  const lookForwardDone = Boolean(review?.lookForwardDoneAt);
  return {
    review_week: reviewWeek,
    due: plannerReviewDueDay(today) && !(lookBackDone && lookForwardDone),
    look_back_done: lookBackDone,
    look_forward_done: lookForwardDone,
  };
}

/** Saves the page's own record of a review in progress, replacing the last one. */
export async function plannerSaveReviewState(
  db: FlareMoDb,
  input: {
    userId: string;
    weekStart: string;
    state: Record<string, unknown>;
    now?: Date;
  },
): Promise<{ updated_at: string }> {
  const weekStart = plannerRequireMonday(input.weekStart, "The week");
  if (JSON.stringify(input.state).length > plannerReviewStateMax) {
    throw new ValidationError("The review is too large to save.");
  }
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    reviewUpsertStatement(db, {
      userId: input.userId,
      weekStart,
      fields: { state: input.state },
      nowIso,
    }),
  ]);
  return { updated_at: nowIso };
}

// ---------------------------------------------------------------------------
// The summary memo
// ---------------------------------------------------------------------------

/** The memo's payload with the summary tag added and the week's client id. */
function summaryPayload(
  payload: MemoPayload | null | undefined,
  clientId: string,
): MemoPayload {
  const tags = [...(payload?.tags ?? [])];
  if (!tags.includes(plannerSummaryMemoTag))
    tags.unshift(plannerSummaryMemoTag);
  return { ...(payload ?? {}), tags, client_id: clientId };
}

/**
 * Writes the week's summary memo: one memo per week, found again by its client
 * id. A second save replaces the text and keeps the memo; a summary the owner
 * moved to the recycle bin comes back with the new text. The tag rides in the
 * payload, like the imported summaries, so the text needs no #tag.
 */
async function writeSummaryMemo(
  db: FlareMoDb,
  input: {
    user: TeamViewer;
    scope?: QuotaScope;
    weekStart: string;
    content: string;
  },
): Promise<MemoRow> {
  const clientId = plannerSummaryMemoClientId(input.weekStart);
  const existing = await getMemoByClientId(db, input.user.id, clientId);
  if (!existing) {
    return createMemo(
      db,
      input.user,
      {
        content: input.content,
        visibility: "private",
        payload: { tags: [plannerSummaryMemoTag], client_id: clientId },
        source: plannerSummaryMemoSource,
      },
      input.scope,
    );
  }
  const live = LIVE_MEMO_STATUSES.includes(existing.status);
  const tagged = (existing.payload?.tags ?? []).includes(plannerSummaryMemoTag);
  if (live && tagged && existing.content === input.content) return existing;
  return updateMemo(db, input.user, existing.id, {
    content: input.content,
    payload: summaryPayload(existing.payload, clientId),
    ...(live ? {} : { status: "normal" as const }),
  });
}

const KEY_QUESTION_LINE =
  /^\*\*Key question for W\d+(?:'s)?(?: review)?:?\*\*.*$/m;

/**
 * Puts the question chosen in Look forward into the week's summary memo, when
 * the review wrote one and it still has its key question line.
 */
async function patchSummaryQuestion(
  db: FlareMoDb,
  input: { user: TeamViewer; weekStart: string; question: string | null },
): Promise<void> {
  const clientId = plannerSummaryMemoClientId(input.weekStart);
  const memo = await getMemoByClientId(db, input.user.id, clientId);
  if (!memo || !LIVE_MEMO_STATUSES.includes(memo.status)) return;
  if (!KEY_QUESTION_LINE.test(memo.content)) return;
  const line = plannerKeyQuestionLine(input.weekStart, input.question);
  const content = memo.content.replace(KEY_QUESTION_LINE, () => line);
  if (content === memo.content) return;
  await updateMemo(db, input.user, memo.id, {
    content,
    payload: summaryPayload(memo.payload, clientId),
  });
}

// ---------------------------------------------------------------------------
// Look back
// ---------------------------------------------------------------------------

export type PlannerLookBackBody = {
  today: string;
  scores: { auth: number; ach: number };
  question: string | null;
  verdict: { kind: PlannerVerdictKind; text: string } | null;
  goal_results: ReadonlyArray<{
    goal_id: string;
    result: PlannerGoalResult | null;
  }>;
  memo: string;
};

/**
 * Saves Look back: the summary memo first (it can be written again safely),
 * then in one batch the week's goal results, the week's record and the time
 * Look back was done. A result for a goal that is not one of the week's live
 * weekly goals is ignored.
 */
export async function plannerSaveLookBack(
  db: FlareMoDb,
  input: {
    user: TeamViewer;
    scope?: QuotaScope;
    weekStart: string;
    body: PlannerLookBackBody;
    now?: Date;
  },
): Promise<{ week: PlannerWeekDto; memo_id: string }> {
  const { user, body } = input;
  const weekStart = plannerResolveReviewWeek(body.today, input.weekStart);
  const auth = plannerSnapScore(body.scores.auth);
  const ach = plannerSnapScore(body.scores.ach);
  if (auth === null || ach === null) {
    throw new ValidationError("Scores must be 1 to 5 in half steps.");
  }
  const content = plannerCleanMemo(body.memo, weekStart);
  if (!content.trim()) throw new ValidationError("The summary is empty.");

  const memo = await writeSummaryMemo(db, {
    user,
    scope: input.scope,
    weekStart,
    content,
  });
  const goals = await plannerReadWeekGoals(db, { userId: user.id, weekStart });
  const known = new Set(goals.map((goal) => goal.id));
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    ...body.goal_results
      .filter((entry) => known.has(entry.goal_id))
      .map((entry) =>
        db
          .update(plannerGoal)
          .set({ result: entry.result, updatedAt: nowIso })
          .where(
            and(
              eq(plannerGoal.id, entry.goal_id),
              eq(plannerGoal.userId, user.id),
            ),
          ),
      ),
    plannerWeekUpsertStatement(db, {
      userId: user.id,
      weekStart,
      patch: {
        auth,
        ach,
        question: body.question,
        verdict: body.verdict?.text ?? null,
        memoId: memo.id,
        source: "review",
        reviewedAt: nowIso,
      },
      nowIso,
    }),
    reviewUpsertStatement(db, {
      userId: user.id,
      weekStart,
      fields: { lookBackDoneAt: nowIso },
      nowIso,
    }),
  ]);
  const week = await plannerReadWeek(db, { userId: user.id, weekStart });
  if (!week) throw new NotFoundError("The week could not be read back.");
  return { week, memo_id: memo.id };
}

// ---------------------------------------------------------------------------
// Look forward
// ---------------------------------------------------------------------------

export type PlannerCommitBody = {
  today: string;
  goals: ReadonlyArray<{
    id: string;
    pillar: PlannerPillar | null;
    title: string;
  }>;
  tasks: ReadonlyArray<{
    ref: string;
    goal_id: string;
    task_id?: string;
    title?: string;
  }>;
  to_backlog: readonly string[];
  question: string | null;
  settled: ReadonlyArray<{
    flag_id: string;
    state: "kept" | "rewritten";
    title?: string;
  }>;
  flags: ReadonlyArray<{
    goal_id: string | null;
    pillar: PlannerPillar | null;
    with_goal_id: string | null;
    with_label: string;
    why: string;
  }>;
};

/**
 * Settles the flags the owner answered in Check goals. "Keep for now" only
 * marks the flag. A rewrite also replaces the goal the flag pulls against (or,
 * when it names none, the goal it is about): the new title, no lines, active,
 * and no contest note, since the rewrite is what settles it.
 */
async function settleFlags(
  db: FlareMoDb,
  input: {
    userId: string;
    settled: PlannerCommitBody["settled"];
    nowIso: string;
  },
): Promise<void> {
  if (input.settled.length === 0) return;
  const rows = await db
    .select()
    .from(plannerGoalFlag)
    .where(
      and(
        eq(plannerGoalFlag.userId, input.userId),
        inArray(
          plannerGoalFlag.id,
          input.settled.map((entry) => entry.flag_id),
        ),
      ),
    )
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const statements: unknown[] = [];
  for (const entry of input.settled) {
    const flag = byId.get(entry.flag_id);
    if (!flag) throw new NotFoundError(`Flag not found: ${entry.flag_id}`);
    statements.push(
      db
        .update(plannerGoalFlag)
        .set({ state: entry.state, settledAt: input.nowIso })
        .where(
          and(
            eq(plannerGoalFlag.id, flag.id),
            eq(plannerGoalFlag.userId, input.userId),
          ),
        ),
    );
    const target = flag.withGoalId ?? flag.goalId;
    const title = entry.title?.trim();
    if (entry.state === "rewritten" && target && title) {
      statements.push(
        db
          .update(plannerGoal)
          .set({
            title,
            lines: [],
            status: "active",
            note: null,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(plannerGoal.id, target),
              eq(plannerGoal.userId, input.userId),
              isNull(plannerGoal.deletedAt),
            ),
          ),
      );
    }
  }
  await plannerRunBatch(db, statements);
}

/**
 * Makes the plan's goals the week's weekly goals, in the plan's order: new ids
 * are created, known ones updated (and restored if an earlier save removed
 * them), and the week's other weekly goals are removed. An id that belongs to
 * someone else, or to a goal of another level or week, is refused before
 * anything is written.
 */
async function writePlanGoals(
  db: FlareMoDb,
  input: {
    userId: string;
    planWeek: string;
    goals: PlannerCommitBody["goals"];
    nowIso: string;
  },
): Promise<void> {
  const ids = input.goals.map((goal) => goal.id);
  const known =
    ids.length > 0
      ? await db
          .select()
          .from(plannerGoal)
          .where(inArray(plannerGoal.id, ids))
          .all()
      : [];
  for (const row of known) {
    if (row.userId !== input.userId) {
      throw new ConflictError("That goal id is already in use.");
    }
    if (row.level !== "week" || row.periodStart !== input.planWeek) {
      throw new ValidationError(
        "A goal of the plan belongs to another level or week.",
      );
    }
  }
  const knownById = new Map(known.map((row) => [row.id, row]));
  const current = await db
    .select({ id: plannerGoal.id })
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.userId, input.userId),
        eq(plannerGoal.level, "week"),
        eq(plannerGoal.periodStart, input.planWeek),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .all();
  const keep = new Set(ids);

  const statements: unknown[] = input.goals.map((goal, index) => {
    const title = goal.title.trim();
    const existing = knownById.get(goal.id);
    if (existing) {
      return db
        .update(plannerGoal)
        .set({
          pillar: goal.pillar,
          title,
          sortOrder: index,
          ...(existing.deletedAt ? { deletedAt: null, status: "active" } : {}),
          updatedAt: input.nowIso,
        })
        .where(
          and(
            eq(plannerGoal.id, goal.id),
            eq(plannerGoal.userId, input.userId),
          ),
        );
    }
    return db.insert(plannerGoal).values({
      id: goal.id,
      userId: input.userId,
      level: "week",
      periodStart: input.planWeek,
      pillar: goal.pillar,
      title,
      lines: [],
      status: "active",
      note: null,
      result: null,
      sortOrder: index,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    });
  });
  for (const row of current) {
    if (keep.has(row.id)) continue;
    statements.push(
      db
        .update(plannerGoal)
        .set({ deletedAt: input.nowIso, updatedAt: input.nowIso })
        .where(
          and(eq(plannerGoal.id, row.id), eq(plannerGoal.userId, input.userId)),
        ),
    );
  }
  await plannerRunBatch(db, statements);
}

/** The board column a live task is in, or null when it is gone or dropped. */
async function liveColumnOf(
  db: FlareMoDb,
  userId: string,
  taskId: string,
): Promise<PlannerColumn | "other" | null> {
  let task: Awaited<ReturnType<typeof plannerLoadLiveTask>>;
  try {
    task = await plannerLoadLiveTask(db, userId, taskId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const plan = await plannerLoadPlan(db, userId, taskId);
  const column = plannerColumnFor({
    status: task.status,
    horizon: plan?.horizon ?? null,
    periodStart: plan?.periodStart ?? null,
    droppedAt: plan?.droppedAt ?? null,
  });
  return column === "dropped" ? null : column;
}

/**
 * Saves Look forward for the week after `weekStart`, in an order that can be
 * run again safely from the top:
 *
 *   1. the answered flags are settled (and rewrites applied);
 *   2. the plan's goals become the week's weekly goals;
 *   3. the cards sent back go from To Do to Backlog;
 *   4. each task of the plan is linked to its goal and put in To Do when it was
 *      in Backlog; a new one is created in To Do once per ref (commit_log);
 *   5. tasks linked to the week's goals that left the plan are unlinked;
 *   6. To Do is re-ordered with the plan's tasks on top, in the plan's order;
 *   7. what the conflict check found replaces the week's earlier open flags;
 *   8. the question for the next review goes on this week's record and into
 *      the summary memo, and Look forward is marked done.
 *
 * A task the plan names that is gone or dropped is skipped, not an error.
 */
export async function plannerCommitPlan(
  db: FlareMoDb,
  input: {
    user: TeamViewer;
    actor: PlannerActor;
    weekStart: string;
    body: PlannerCommitBody;
    now?: Date;
  },
): Promise<PlannerCommitResponse> {
  const { user, actor, body } = input;
  const userId = user.id;
  const today = plannerRequireDay(body.today, "today");
  const reviewWeek = plannerResolveReviewWeek(today, input.weekStart);
  const planWeek = plannerAddDays(reviewWeek, 7);

  // Checks that need no database, before anything is written.
  const goalOrder = new Map(body.goals.map((goal, index) => [goal.id, index]));
  if (goalOrder.size !== body.goals.length) {
    throw new ValidationError("Goal ids must be unique.");
  }
  if (body.goals.some((goal) => !goal.title.trim())) {
    throw new ValidationError("A goal of the plan needs a title.");
  }
  const refs = new Set<string>();
  const named = new Set<string>();
  for (const task of body.tasks) {
    if (!goalOrder.has(task.goal_id)) {
      throw new ValidationError(
        "Every task must belong to a goal of the plan.",
      );
    }
    if (refs.has(task.ref))
      throw new ValidationError("Task refs must be unique.");
    refs.add(task.ref);
    if ((task.task_id === undefined) === (task.title === undefined)) {
      throw new ValidationError("A plan task needs either task_id or title.");
    }
    if (task.task_id !== undefined) {
      const id = plannerNormalizeTaskId(task.task_id);
      if (named.has(id)) {
        throw new ValidationError(
          "A task can serve only one goal of the plan.",
        );
      }
      named.add(id);
    }
  }
  // The plan's tasks grouped by goal, in the plan's goal order.
  const tasks = [...body.tasks].sort(
    (left, right) =>
      (goalOrder.get(left.goal_id) ?? 0) - (goalOrder.get(right.goal_id) ?? 0),
  );
  const stamp = () => plannerNow(input.now).toISOString();

  // 1 and 2.
  await settleFlags(db, { userId, settled: body.settled, nowIso: stamp() });
  await writePlanGoals(db, {
    userId,
    planWeek,
    goals: body.goals,
    nowIso: stamp(),
  });

  // 3.
  for (const raw of body.to_backlog) {
    const taskId = plannerNormalizeTaskId(raw);
    if (named.has(taskId)) continue;
    if ((await liveColumnOf(db, userId, taskId)) !== "todo") continue;
    await plannerApplyColumnMove(db, {
      user,
      actor,
      taskId,
      to: "backlog",
      today,
      now: input.now,
    });
  }

  // 4.
  const review = await readReviewRow(db, userId, reviewWeek);
  const log: Record<string, string> = { ...(review?.commitLog?.tasks ?? {}) };
  const created: Record<string, string> = {};
  const planned: string[] = [];
  for (const task of tasks) {
    let taskId: string;
    if (task.task_id !== undefined) {
      taskId = plannerNormalizeTaskId(task.task_id);
    } else {
      const logged = log[task.ref];
      if (logged) {
        taskId = logged;
      } else {
        const made = await plannerCreateTask(db, {
          user,
          actor,
          title: (task.title ?? "").trim(),
          column: "todo",
          plan: plannerTodoMarker(today),
          today,
          now: input.now,
        });
        taskId = made.task.id;
        log[task.ref] = taskId;
        // Recorded before anything else happens to the task, so a save that
        // fails after this point never creates it again.
        await plannerRunBatch(db, [
          reviewUpsertStatement(db, {
            userId,
            weekStart: reviewWeek,
            fields: { commitLog: { tasks: { ...log } } },
            nowIso: stamp(),
          }),
        ]);
      }
      created[task.ref] = taskId;
    }
    const column = await liveColumnOf(db, userId, taskId);
    if (column === null) continue;
    await plannerSetTaskGoal(db, {
      user,
      actor,
      taskId,
      goalId: task.goal_id,
      now: input.now,
    });
    if (column === "backlog") {
      await plannerApplyColumnMove(db, {
        user,
        actor,
        taskId,
        to: "todo",
        today,
        now: input.now,
      });
    }
    planned.push(taskId);
  }

  // 5. Every weekly goal of the plan week, removed ones included.
  const weekGoalIds = (
    await db
      .select({ id: plannerGoal.id })
      .from(plannerGoal)
      .where(
        and(
          eq(plannerGoal.userId, userId),
          eq(plannerGoal.level, "week"),
          eq(plannerGoal.periodStart, planWeek),
        ),
      )
      .all()
  ).map((row) => row.id);
  if (weekGoalIds.length > 0) {
    const linked = await db
      .select({ taskId: plannerTaskPlan.taskId })
      .from(plannerTaskPlan)
      .where(
        and(
          eq(plannerTaskPlan.userId, userId),
          inArray(plannerTaskPlan.goalId, weekGoalIds),
        ),
      )
      .all();
    const inPlan = new Set(planned);
    for (const row of linked) {
      if (inPlan.has(row.taskId)) continue;
      if ((await liveColumnOf(db, userId, row.taskId)) === null) continue;
      await plannerSetTaskGoal(db, {
        user,
        actor,
        taskId: row.taskId,
        goalId: null,
        now: input.now,
      });
    }
  }

  // 6.
  const board = await plannerReadBoard(db, { userId, today });
  const todo = board.columns.todo.map((card) => card.id);
  const inTodo = new Set(todo);
  const top = [...new Set(planned)].filter((id) => inTodo.has(id));
  const onTop = new Set(top);
  const order = [...top, ...todo.filter((id) => !onTop.has(id))];
  if (top.length > 0) {
    await plannerRespreadColumn(db, {
      userId,
      column: "todo",
      order,
      now: input.now,
    });
  }

  // 7. The flags may only name the plan's goals and the owner's own goals.
  const withIds = body.flags
    .map((flag) => flag.with_goal_id)
    .filter((id): id is string => typeof id === "string");
  const owned = new Set(
    withIds.length > 0
      ? (
          await db
            .select({ id: plannerGoal.id })
            .from(plannerGoal)
            .where(
              and(
                eq(plannerGoal.userId, userId),
                inArray(plannerGoal.id, withIds),
              ),
            )
            .all()
        ).map((row) => row.id)
      : [],
  );
  const flagsAt = stamp();
  await plannerRunBatch(db, [
    db
      .delete(plannerGoalFlag)
      .where(
        and(
          eq(plannerGoalFlag.userId, userId),
          eq(plannerGoalFlag.weekStart, planWeek),
          eq(plannerGoalFlag.state, "open"),
        ),
      ),
    ...body.flags.map((flag) =>
      db.insert(plannerGoalFlag).values({
        id: crypto.randomUUID(),
        userId,
        weekStart: planWeek,
        goalId:
          flag.goal_id !== null && goalOrder.has(flag.goal_id)
            ? flag.goal_id
            : null,
        pillar: flag.pillar,
        withGoalId:
          flag.with_goal_id !== null && owned.has(flag.with_goal_id)
            ? flag.with_goal_id
            : null,
        withLabel: flag.with_label.trim(),
        why: flag.why.trim(),
        state: "open",
        createdAt: flagsAt,
        settledAt: null,
      }),
    ),
  ]);

  // 8.
  await patchSummaryQuestion(db, {
    user,
    weekStart: reviewWeek,
    question: body.question,
  });
  const doneAt = stamp();
  await plannerRunBatch(db, [
    plannerWeekUpsertStatement(db, {
      userId,
      weekStart: reviewWeek,
      patch: { question: body.question },
      nowIso: doneAt,
    }),
    reviewUpsertStatement(db, {
      userId,
      weekStart: reviewWeek,
      fields: { commitLog: { tasks: log }, lookForwardDoneAt: doneAt },
      nowIso: doneAt,
    }),
  ]);

  const goals: PlannerGoalDto[] = await plannerReadWeekGoals(db, {
    userId,
    weekStart: planWeek,
  });
  return { plan_week: planWeek, goals, created };
}
