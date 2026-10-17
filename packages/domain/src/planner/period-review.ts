import {
  type PlannerEvidenceDto,
  type PlannerPeriodDue,
  type PlannerPeriodLevel,
  type PlannerPeriodReviewResponse,
  type PlannerPeriodStateResponse,
  type PlannerPeriodStatusResponse,
  type PlannerSavePeriodInput,
  type PlannerSavePeriodResponse,
  plannerIsPeriodStart,
  plannerLatestClosedPeriod,
  plannerPeriodLabel,
  plannerPeriodLevels,
  plannerPeriodMemoClientId,
  plannerPeriodMemoSource,
  plannerPeriodMemoTag,
  plannerPeriodStateMax,
  plannerPeriodsClosingWith,
  plannerReviewDueDay,
  plannerReviewWeekFor,
} from "@flaremo/contracts";
import type { FlareMoDb, MemoPayload, MemoRow } from "@flaremo/db";
import {
  plannerEvidence,
  plannerGoal,
  plannerPeriodReview,
  plannerReview,
} from "@flaremo/db/src/schema/planner";
import { and, eq, inArray } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import { getMemoByClientId } from "../memos-read";
import { createMemo, updateMemo } from "../memos-write";
import type { QuotaScope } from "../quotas";
import type { TeamViewer } from "../team-permissions";
import {
  type PlannerPeriodContext,
  plannerEvidenceToDto,
  plannerReadPeriodContext,
  plannerVerifyQuote,
} from "./period-review-context";
import {
  plannerCleanPeriodMemo,
  plannerRewriteRate,
} from "./period-review-prompts";
import { plannerNow, plannerRequireDay, plannerRunBatch } from "./shared";

// The month, quarter and year reviews (fork-owned add-on,
// docs/planning-cockpit-period-review.md): what the page reads, its saved
// progress, and the one save that changes the owner's data. Saving writes the
// period's memo (one per period, found again by its client id), the results
// and decisions on the period's goals, the receipts (each checked word for
// word against the raw rows), the verdict and the forecast, and grades the
// last period's forecast. All of it can be sent again safely.

const LIVE_MEMO_STATUSES: readonly string[] = ["normal", "archived"];

/** The level and period a request names, or the latest closed period of the level. */
export function plannerResolvePeriod(
  today: string,
  level: unknown,
  period?: string | null,
): { level: PlannerPeriodLevel; periodStart: string } {
  const day = plannerRequireDay(today, "today");
  const found = plannerPeriodLevels.find((entry) => entry === level);
  if (!found)
    throw new ValidationError("level must be month, quarter or year.");
  if (period === undefined || period === null) {
    return { level: found, periodStart: plannerLatestClosedPeriod(found, day) };
  }
  if (!plannerIsPeriodStart(found, period)) {
    throw new ValidationError(
      `period must be the first day of a ${found} (YYYY-MM-DD).`,
    );
  }
  if (period > day)
    throw new ValidationError("That period has not started yet.");
  return { level: found, periodStart: period };
}

async function readDue(
  db: FlareMoDb,
  userId: string,
  today: string,
): Promise<{
  reviewWeek: string;
  lookBackDone: boolean;
  due: PlannerPeriodDue[];
}> {
  const reviewWeek = plannerReviewWeekFor(today);
  const closing = plannerPeriodsClosingWith(reviewWeek);
  const [weekly, rows] = await Promise.all([
    db
      .select({ lookBackDoneAt: plannerReview.lookBackDoneAt })
      .from(plannerReview)
      .where(
        and(
          eq(plannerReview.userId, userId),
          eq(plannerReview.weekStart, reviewWeek),
        ),
      )
      .get(),
    closing.length
      ? db
          .select({
            level: plannerPeriodReview.level,
            periodStart: plannerPeriodReview.periodStart,
            doneAt: plannerPeriodReview.doneAt,
          })
          .from(plannerPeriodReview)
          .where(
            and(
              eq(plannerPeriodReview.userId, userId),
              inArray(
                plannerPeriodReview.periodStart,
                closing.map((entry) => entry.period_start),
              ),
            ),
          )
          .all()
      : Promise.resolve([]),
  ]);
  return {
    reviewWeek,
    lookBackDone: Boolean(weekly?.lookBackDoneAt),
    due: closing.map((entry) => ({
      level: entry.level,
      period_start: entry.period_start,
      done: rows.some(
        (row) =>
          row.level === entry.level &&
          row.periodStart === entry.period_start &&
          Boolean(row.doneAt),
      ),
    })),
  };
}

/** What is due this Sunday, for the sidebar's dot and the weekly review's hand-off. */
export async function plannerPeriodStatus(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerPeriodStatusResponse> {
  const today = plannerRequireDay(input.today, "today");
  const { reviewWeek, lookBackDone, due } = await readDue(
    db,
    input.userId,
    today,
  );
  return {
    review_week: reviewWeek,
    look_back_done: lookBackDone,
    due,
    any_due: plannerReviewDueDay(today) && due.some((entry) => !entry.done),
  };
}

/** The review as the page reads it. */
export async function plannerReadPeriodReview(
  db: FlareMoDb,
  input: {
    userId: string;
    ownerName: string;
    today: string;
    level?: string | null;
    period?: string | null;
    ai: boolean;
  },
): Promise<PlannerPeriodReviewResponse> {
  const today = plannerRequireDay(input.today, "today");
  const status = await readDue(db, input.userId, today);
  const fallbackLevel =
    input.level ??
    status.due.find((entry) => !entry.done)?.level ??
    status.due.at(-1)?.level ??
    "month";
  const { level, periodStart } = plannerResolvePeriod(
    today,
    fallbackLevel,
    input.period,
  );
  const context = await plannerReadPeriodContext(db, {
    userId: input.userId,
    ownerName: input.ownerName,
    level,
    periodStart,
    today,
  });
  return plannerPeriodResponse(context, status, input.ai);
}

export function plannerPeriodResponse(
  context: PlannerPeriodContext,
  status: {
    reviewWeek: string;
    lookBackDone: boolean;
    due: PlannerPeriodDue[];
  },
  ai: boolean,
): PlannerPeriodReviewResponse {
  return {
    level: context.level,
    period_start: context.periodStart,
    period_end: context.periodEnd,
    label: plannerPeriodLabel(context.level, context.periodStart),
    review_week: status.reviewWeek,
    look_back_done: status.lookBackDone,
    due: status.due,
    weeks: context.weeks.map(
      ({
        summary: _summary,
        diary: _diary,
        goals: _goals,
        health: _health,
        done: _done,
        ...week
      }) => week,
    ),
    goals: context.goals,
    child_goals: context.childGoals,
    north_star: context.northStar,
    previous: context.previous
      ? {
          period_start: context.previous.periodStart,
          verdict: context.previous.verdict,
          forecast: context.previous.forecast,
          forecast_grade: context.previous.forecastGrade,
          memo_id: null,
          question: context.previous.question,
        }
      : null,
    memories: {
      created: context.memories.created,
      revised: context.memories.revised,
      created_lines: context.memories.createdLines,
      revised_lines: context.memories.revisedLines,
    },
    state: context.row?.state ?? {},
    done_at: context.row?.doneAt ?? null,
    memo: context.memo,
    verdict: context.row?.verdict ?? null,
    forecast: context.row?.forecast ?? null,
    rewrite_rate: context.row?.rewriteRate ?? null,
    evidence: context.evidence.map(plannerEvidenceToDto),
    ai,
  };
}

function periodUpsert(
  db: FlareMoDb,
  input: {
    userId: string;
    level: PlannerPeriodLevel;
    periodStart: string;
    fields: Partial<typeof plannerPeriodReview.$inferInsert>;
    nowIso: string;
  },
) {
  return db
    .insert(plannerPeriodReview)
    .values({
      userId: input.userId,
      level: input.level,
      periodStart: input.periodStart,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      ...input.fields,
    })
    .onConflictDoUpdate({
      target: [
        plannerPeriodReview.userId,
        plannerPeriodReview.level,
        plannerPeriodReview.periodStart,
      ],
      set: { ...input.fields, updatedAt: input.nowIso },
    });
}

/** Saves the page's own record of a review in progress, replacing the last one. */
export async function plannerSavePeriodState(
  db: FlareMoDb,
  input: {
    userId: string;
    level: string;
    periodStart: string;
    state: Record<string, unknown>;
    now?: Date;
  },
): Promise<PlannerPeriodStateResponse> {
  const level = plannerPeriodLevels.find((entry) => entry === input.level);
  if (!level)
    throw new ValidationError("level must be month, quarter or year.");
  if (!plannerIsPeriodStart(level, input.periodStart)) {
    throw new ValidationError("period must be the first day of the period.");
  }
  if (JSON.stringify(input.state).length > plannerPeriodStateMax) {
    throw new ValidationError("The review's state is too large to save.");
  }
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    periodUpsert(db, {
      userId: input.userId,
      level,
      periodStart: input.periodStart,
      fields: { state: input.state },
      nowIso,
    }),
  ]);
  return { updated_at: nowIso };
}

/** Start over: clears the page's state and the done mark; the memo and results stay. */
export async function plannerStartPeriodOver(
  db: FlareMoDb,
  input: { userId: string; level: string; periodStart: string; now?: Date },
): Promise<PlannerPeriodStateResponse> {
  const level = plannerPeriodLevels.find((entry) => entry === input.level);
  if (!level)
    throw new ValidationError("level must be month, quarter or year.");
  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    db
      .update(plannerPeriodReview)
      .set({ state: {}, doneAt: null, updatedAt: nowIso })
      .where(
        and(
          eq(plannerPeriodReview.userId, input.userId),
          eq(plannerPeriodReview.level, level),
          eq(plannerPeriodReview.periodStart, input.periodStart),
        ),
      ),
  ]);
  return { updated_at: nowIso };
}

function memoPayload(
  payload: MemoPayload | null | undefined,
  clientId: string,
): MemoPayload {
  const tags = [...(payload?.tags ?? [])];
  if (!tags.includes(plannerPeriodMemoTag)) tags.unshift(plannerPeriodMemoTag);
  return { ...(payload ?? {}), tags, client_id: clientId };
}

async function writePeriodMemo(
  db: FlareMoDb,
  input: {
    user: TeamViewer;
    scope?: QuotaScope;
    level: PlannerPeriodLevel;
    periodStart: string;
    content: string;
  },
): Promise<MemoRow> {
  const clientId = plannerPeriodMemoClientId(input.level, input.periodStart);
  const existing = await getMemoByClientId(db, input.user.id, clientId);
  if (!existing) {
    return createMemo(
      db,
      input.user,
      {
        content: input.content,
        visibility: "private",
        payload: { tags: [plannerPeriodMemoTag], client_id: clientId },
        source: plannerPeriodMemoSource,
      },
      input.scope,
    );
  }
  const live = LIVE_MEMO_STATUSES.includes(existing.status);
  const tagged = (existing.payload?.tags ?? []).includes(plannerPeriodMemoTag);
  if (live && tagged && existing.content === input.content) return existing;
  return updateMemo(db, input.user, existing.id, {
    content: input.content,
    payload: memoPayload(existing.payload, clientId),
    ...(live ? {} : { status: "normal" as const }),
  });
}

/**
 * Saves the review: the memo first (it can be written again safely), then in
 * one batch the goal results and decisions, the receipts, the period's record
 * and the grade on the last period's forecast. A result for a goal outside the
 * period (and its level below) is ignored.
 */
export async function plannerSavePeriodReview(
  db: FlareMoDb,
  input: {
    user: TeamViewer;
    scope?: QuotaScope;
    level: string;
    periodStart: string;
    body: PlannerSavePeriodInput;
    now?: Date;
  },
): Promise<PlannerSavePeriodResponse> {
  const { user, body } = input;
  const { level, periodStart } = plannerResolvePeriod(
    body.today,
    input.level,
    input.periodStart,
  );
  const content = plannerCleanPeriodMemo(body.memo, level, periodStart);
  if (!content.trim()) throw new ValidationError("The memo is empty.");
  const context = await plannerReadPeriodContext(db, {
    userId: user.id,
    ownerName: user.name,
    level,
    periodStart,
    today: body.today,
  });

  const memo = await writePeriodMemo(db, {
    user,
    scope: input.scope,
    level,
    periodStart,
    content,
  });
  const known = new Set(
    [...context.goals, ...context.childGoals].map((goal) => goal.id),
  );
  const nowIso = plannerNow(input.now).toISOString();
  const evidenceRows = body.evidence.map((entry) => {
    const check = plannerVerifyQuote(entry.quote, context.raw);
    return {
      id: crypto.randomUUID(),
      userId: user.id,
      level,
      periodStart,
      pillar: entry.pillar ?? null,
      claim: entry.claim,
      quote: entry.quote,
      source: check.source?.source ?? null,
      sourceId: check.source?.id ?? null,
      sourceDay: check.source?.day ?? null,
      verified: check.verified ? 1 : 0,
      createdAt: nowIso,
    };
  });
  // The draft is cleaned like the memo, so the marker line and a code fence
  // never count as a rewrite.
  const draft = body.draft_memo?.trim()
    ? plannerCleanPeriodMemo(body.draft_memo, level, periodStart)
    : null;
  const rewriteRate = plannerRewriteRate(draft, content);
  const weekMarks = Object.fromEntries(
    Object.entries(body.week_marks ?? {}).filter(([monday]) =>
      context.weeks.some((week) => week.week_start === monday),
    ),
  );
  await plannerRunBatch(db, [
    ...body.goal_results
      .filter((entry) => known.has(entry.goal_id))
      .map((entry) =>
        db
          .update(plannerGoal)
          .set({
            result: entry.result ?? null,
            ...(entry.note !== undefined ? { note: entry.note } : {}),
            ...(entry.decision === "kill" ? { status: "closed" as const } : {}),
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(plannerGoal.id, entry.goal_id),
              eq(plannerGoal.userId, user.id),
            ),
          ),
      ),
    db
      .delete(plannerEvidence)
      .where(
        and(
          eq(plannerEvidence.userId, user.id),
          eq(plannerEvidence.level, level),
          eq(plannerEvidence.periodStart, periodStart),
        ),
      ),
    ...(evidenceRows.length
      ? [db.insert(plannerEvidence).values(evidenceRows)]
      : []),
    periodUpsert(db, {
      userId: user.id,
      level,
      periodStart,
      fields: {
        memoId: memo.id,
        verdict: body.verdict
          ? `${body.verdict.kind}${body.verdict.text ? `: ${body.verdict.text}` : ""}`
          : null,
        forecast: body.forecast ?? null,
        draftMemo: draft,
        rewriteRate,
        weekMarks,
        doneAt: nowIso,
      },
      nowIso,
    }),
    ...(context.previous && body.previous_grade
      ? [
          db
            .update(plannerPeriodReview)
            .set({ forecastGrade: body.previous_grade, updatedAt: nowIso })
            .where(
              and(
                eq(plannerPeriodReview.userId, user.id),
                eq(plannerPeriodReview.level, level),
                eq(
                  plannerPeriodReview.periodStart,
                  context.previous.periodStart,
                ),
              ),
            ),
        ]
      : []),
  ]);
  const saved = await db
    .select()
    .from(plannerEvidence)
    .where(
      and(
        eq(plannerEvidence.userId, user.id),
        eq(plannerEvidence.level, level),
        eq(plannerEvidence.periodStart, periodStart),
      ),
    )
    .all();
  if (!memo.id) throw new NotFoundError("The memo could not be read back.");
  const evidence: PlannerEvidenceDto[] = saved.map(plannerEvidenceToDto);
  return {
    memo_id: memo.id,
    done_at: nowIso,
    rewrite_rate: rewriteRate,
    evidence,
  };
}
