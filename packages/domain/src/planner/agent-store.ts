import {
  healthLocalMoment,
  type PlannerAgentProposalDto,
  type PlannerAskMessage,
  type PlannerPillar,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos, memoTags } from "@flaremo/db";
import {
  type PlannerAgentProposalRow,
  type PlannerAgentRunRow,
  plannerAgentChat,
  plannerAgentProposal,
  plannerAgentRun,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { NotFoundError } from "../errors";
import {
  type PlannerRawRow,
  plannerVerifyQuote,
} from "./period-review-context";

// The general agent's own records (fork-owned add-on,
// docs/fork-general-agent.md): one row per session it ran with what it cost,
// the goals and tasks it proposed for a week's plan, and the Ask chat. The
// Worker's agent client writes the runs; the MCP tools write the proposals;
// the routes read them. Money is in US cents at list price throughout.

export type { PlannerAgentRunRow };
export type PlannerAgentJob = PlannerAgentRunRow["job"];

/** A weekly review's runs: the Monday of the week looked back on. */
export function plannerAgentWeekKey(weekStart: string): string {
  return `week:${weekStart}`;
}

/** An Ask conversation's runs. */
export function plannerAgentAskKey(conversation: string): string {
  return `ask:${conversation}`;
}

/** Below this a session cannot do a step's work, so none is started. */
export const PLANNER_AGENT_MIN_BUDGET_CENTS = 50;

/** The first instant of the UTC month `now` is in. */
function monthStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

/**
 * This month's spend: what the month's sessions cost so far, and what the
 * sessions still open may yet spend up to their caps. Both count against the
 * monthly cap, so two sessions at once can never pass it.
 */
export async function plannerAgentMonthSpend(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<{ spentCents: number; reservedCents: number }> {
  const since = monthStart(input.now ?? new Date());
  const [spent, reserved] = await Promise.all([
    db
      .select({
        cents: sql<number>`coalesce(sum(${plannerAgentRun.costCents}), 0)`,
      })
      .from(plannerAgentRun)
      .where(
        and(
          eq(plannerAgentRun.userId, input.userId),
          gte(plannerAgentRun.createdAt, since),
        ),
      )
      .get(),
    db
      .select({
        cents: sql<number>`coalesce(sum(max(0, ${plannerAgentRun.budgetCents} - ${plannerAgentRun.costCents})), 0)`,
      })
      .from(plannerAgentRun)
      .where(
        and(
          eq(plannerAgentRun.userId, input.userId),
          eq(plannerAgentRun.state, "open"),
        ),
      )
      .get(),
  ]);
  return {
    spentCents: Number(spent?.cents ?? 0),
    reservedCents: Number(reserved?.cents ?? 0),
  };
}

/**
 * The cap a new session gets: the per-run cap, or what is left of the month's
 * when that is less. Zero when too little is left to do a step's work.
 */
export function plannerAgentBudget(input: {
  runCents: number;
  monthCents: number;
  spentCents: number;
  reservedCents: number;
}): number {
  const left = input.monthCents - input.spentCents - input.reservedCents;
  const budget = Math.floor(Math.min(input.runCents, left));
  return budget >= PLANNER_AGENT_MIN_BUDGET_CENTS ? budget : 0;
}

export async function plannerAgentCreateRun(
  db: FlareMoDb,
  input: {
    userId: string;
    job: PlannerAgentJob;
    ownerKey: string;
    budgetCents: number;
    startedBy?: "owner" | "schedule";
    step: string;
    stepInput?: unknown;
    now?: Date;
  },
): Promise<PlannerAgentRunRow> {
  const at = (input.now ?? new Date()).toISOString();
  const row: PlannerAgentRunRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    job: input.job,
    ownerKey: input.ownerKey,
    sessionId: null,
    state: "open",
    startedBy: input.startedBy ?? "owner",
    step: input.step,
    stepInput: input.stepInput ?? null,
    stepAt: at,
    stepDoneAt: null,
    budgetCents: input.budgetCents,
    costCents: 0,
    error: null,
    createdAt: at,
    updatedAt: at,
    endedAt: null,
  };
  await db.insert(plannerAgentRun).values(row).run();
  return row;
}

export async function plannerAgentAttachSession(
  db: FlareMoDb,
  input: { runId: string; sessionId: string },
): Promise<void> {
  await db
    .update(plannerAgentRun)
    .set({ sessionId: input.sessionId, updatedAt: new Date().toISOString() })
    .where(eq(plannerAgentRun.id, input.runId))
    .run();
}

/** The newest open run of a review or a conversation that has a session. */
export async function plannerAgentFindOpenRun(
  db: FlareMoDb,
  input: { userId: string; ownerKey: string },
): Promise<PlannerAgentRunRow | null> {
  const row = await db
    .select()
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.userId, input.userId),
        eq(plannerAgentRun.ownerKey, input.ownerKey),
        eq(plannerAgentRun.state, "open"),
      ),
    )
    .orderBy(desc(plannerAgentRun.createdAt))
    .limit(1)
    .get();
  return row?.sessionId ? row : null;
}

/** The run a session belongs to, when it is this user's. */
export async function plannerAgentRunOfSession(
  db: FlareMoDb,
  input: { userId: string; sessionId: string },
): Promise<PlannerAgentRunRow | null> {
  const row = await db
    .select()
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.userId, input.userId),
        eq(plannerAgentRun.sessionId, input.sessionId),
      ),
    )
    .get();
  return row ?? null;
}

export async function plannerAgentSetStep(
  db: FlareMoDb,
  input: { runId: string; step: string; stepInput?: unknown },
): Promise<void> {
  const at = new Date().toISOString();
  await db
    .update(plannerAgentRun)
    .set({
      step: input.step,
      stepInput: input.stepInput ?? null,
      stepAt: at,
      stepDoneAt: null,
      updatedAt: at,
    })
    .where(eq(plannerAgentRun.id, input.runId))
    .run();
}

/** The last step's answer was read; `costCents` is the session's cost now. */
export async function plannerAgentStepDone(
  db: FlareMoDb,
  input: { runId: string; costCents?: number | null },
): Promise<void> {
  const at = new Date().toISOString();
  await db
    .update(plannerAgentRun)
    .set({
      stepDoneAt: at,
      updatedAt: at,
      ...(typeof input.costCents === "number"
        ? { costCents: input.costCents }
        : {}),
    })
    .where(eq(plannerAgentRun.id, input.runId))
    .run();
}

export async function plannerAgentRecordCost(
  db: FlareMoDb,
  input: { runId: string; costCents: number },
): Promise<void> {
  await db
    .update(plannerAgentRun)
    .set({ costCents: input.costCents, updatedAt: new Date().toISOString() })
    .where(eq(plannerAgentRun.id, input.runId))
    .run();
}

/** Closes a run once its session is gone. `error` is a short reason only. */
export async function plannerAgentEndRun(
  db: FlareMoDb,
  input: {
    runId: string;
    state: "ended" | "failed";
    costCents?: number | null;
    error?: string | null;
  },
): Promise<void> {
  const at = new Date().toISOString();
  await db
    .update(plannerAgentRun)
    .set({
      state: input.state,
      endedAt: at,
      updatedAt: at,
      ...(typeof input.costCents === "number"
        ? { costCents: input.costCents }
        : {}),
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
    })
    .where(eq(plannerAgentRun.id, input.runId))
    .run();
}

/** Open runs not touched since `before`, oldest first: the nightly sweep's. */
export async function plannerAgentIdleRuns(
  db: FlareMoDb,
  input: { before: string; limit?: number },
): Promise<PlannerAgentRunRow[]> {
  return db
    .select()
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.state, "open"),
        lt(plannerAgentRun.updatedAt, input.before),
      ),
    )
    .orderBy(asc(plannerAgentRun.updatedAt))
    .limit(input.limit ?? 50)
    .all();
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** How far back a quote with no entry id is looked for. */
const QUOTE_LOOKBACK_DAYS = 400;

/**
 * The diary entry that holds `quote` word for word (case, punctuation and
 * spacing aside): the one named, or else the newest of the owner's entries of
 * the last QUOTE_LOOKBACK_DAYS days that holds it. Review memos a model wrote
 * are never a receipt.
 */
export async function plannerAgentFindQuote(
  db: FlareMoDb,
  input: {
    userId: string;
    quote: string;
    entryId?: string | null;
    now?: Date;
  },
): Promise<{ id: string; day: string } | null> {
  const summaries = db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, input.userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
      ),
    );
  const own = and(
    eq(memos.userId, input.userId),
    isNull(memos.deletedAt),
    inArray(memos.status, ["normal", "archived"]),
    ne(memos.source, plannerSummaryMemoSource),
    notInArray(memos.id, summaries),
  );
  const since = new Date(
    (input.now ?? new Date()).getTime() - QUOTE_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  const rows = await db
    .select({ id: memos.id, at: memos.createdAt, content: memos.content })
    .from(memos)
    .where(
      input.entryId
        ? and(own, eq(memos.id, input.entryId))
        : and(own, gte(memos.createdAt, since)),
    )
    .orderBy(desc(memos.createdAt))
    .limit(2_000)
    .all();
  const raw: PlannerRawRow[] = rows.map((row) => ({
    source: "memo",
    id: row.id,
    day: healthLocalMoment(row.at).day,
    text: row.content,
  }));
  const found = plannerVerifyQuote(input.quote, raw);
  return found.source ? { id: found.source.id, day: found.source.day } : null;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export function plannerAgentProposalToDto(
  row: PlannerAgentProposalRow,
): PlannerAgentProposalDto {
  return {
    id: row.id,
    kind: row.kind,
    week_start: row.weekStart,
    pillar: row.pillar,
    title: row.title,
    lines: row.lines,
    goal_ref: row.goalRef,
    why: row.why,
    quote: row.verified === 1 ? row.quote : null,
    source_day: row.verified === 1 ? row.sourceDay : null,
    state: row.state,
  };
}

/**
 * Removes a week's proposals nobody has acted on yet: a new propose step
 * replaces them. Accepted and dismissed ones stay.
 */
export async function plannerAgentClearOpenProposals(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<void> {
  await db
    .delete(plannerAgentProposal)
    .where(
      and(
        eq(plannerAgentProposal.userId, input.userId),
        eq(plannerAgentProposal.weekStart, input.weekStart),
        eq(plannerAgentProposal.state, "open"),
      ),
    )
    .run();
}

/** At most this many open proposals of each kind for one week. */
export const PLANNER_AGENT_PROPOSALS_MAX = 8;

export async function plannerAgentAddProposal(
  db: FlareMoDb,
  input: {
    userId: string;
    runId: string | null;
    weekStart: string;
    kind: "goal" | "task";
    pillar: PlannerPillar | null;
    title: string;
    lines: string[];
    goalRef: string | null;
    why: string;
    receipt: { quote: string; id: string; day: string } | null;
  },
): Promise<PlannerAgentProposalDto> {
  const existing = await db
    .select()
    .from(plannerAgentProposal)
    .where(
      and(
        eq(plannerAgentProposal.userId, input.userId),
        eq(plannerAgentProposal.weekStart, input.weekStart),
        eq(plannerAgentProposal.kind, input.kind),
      ),
    )
    .all();
  const title = input.title.replace(/\s+/g, " ").trim();
  const same = existing.find(
    (row) => row.title.toLowerCase() === title.toLowerCase(),
  );
  if (same) return plannerAgentProposalToDto(same);
  if (
    existing.filter((row) => row.state === "open").length >=
    PLANNER_AGENT_PROPOSALS_MAX
  ) {
    throw new RangeError(
      `There are already ${PLANNER_AGENT_PROPOSALS_MAX} open ${input.kind} proposals for this week.`,
    );
  }
  const row: PlannerAgentProposalRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    runId: input.runId,
    weekStart: input.weekStart,
    kind: input.kind,
    pillar: input.pillar,
    title,
    lines: input.lines.map((text) => ({ text })),
    goalRef: input.goalRef,
    why: input.why.replace(/\s+/g, " ").trim(),
    quote: input.receipt?.quote ?? null,
    sourceId: input.receipt?.id ?? null,
    sourceDay: input.receipt?.day ?? null,
    verified: input.receipt ? 1 : 0,
    state: "open",
    createdAt: new Date().toISOString(),
    settledAt: null,
  };
  await db.insert(plannerAgentProposal).values(row).run();
  return plannerAgentProposalToDto(row);
}

/** A week's proposals, oldest first. */
export async function plannerAgentListProposals(
  db: FlareMoDb,
  input: { userId: string; weekStart: string },
): Promise<PlannerAgentProposalDto[]> {
  const rows = await db
    .select()
    .from(plannerAgentProposal)
    .where(
      and(
        eq(plannerAgentProposal.userId, input.userId),
        eq(plannerAgentProposal.weekStart, input.weekStart),
      ),
    )
    .orderBy(asc(plannerAgentProposal.createdAt))
    .all();
  return rows.map(plannerAgentProposalToDto);
}

/** Accepts or dismisses a proposal; `open` takes the decision back. */
export async function plannerAgentSettleProposal(
  db: FlareMoDb,
  input: {
    userId: string;
    id: string;
    state: "accepted" | "dismissed" | "open";
  },
): Promise<PlannerAgentProposalDto> {
  const row = await db
    .select()
    .from(plannerAgentProposal)
    .where(
      and(
        eq(plannerAgentProposal.userId, input.userId),
        eq(plannerAgentProposal.id, input.id),
      ),
    )
    .get();
  if (!row) throw new NotFoundError("Proposal not found.");
  const settledAt = input.state === "open" ? null : new Date().toISOString();
  await db
    .update(plannerAgentProposal)
    .set({ state: input.state, settledAt })
    .where(eq(plannerAgentProposal.id, row.id))
    .run();
  return plannerAgentProposalToDto({ ...row, state: input.state, settledAt });
}

// ---------------------------------------------------------------------------
// The Ask chat
// ---------------------------------------------------------------------------

export async function plannerAgentAddChat(
  db: FlareMoDb,
  input: {
    userId: string;
    conversationId: string;
    role: "owner" | "agent";
    text: string;
    runId: string | null;
  },
): Promise<PlannerAskMessage> {
  const row = {
    id: crypto.randomUUID(),
    userId: input.userId,
    conversationId: input.conversationId,
    role: input.role,
    text: input.text,
    runId: input.runId,
    createdAt: new Date().toISOString(),
  };
  await db.insert(plannerAgentChat).values(row).run();
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    created_at: row.createdAt,
  };
}

/** A conversation's messages, oldest first. */
export async function plannerAgentReadChat(
  db: FlareMoDb,
  input: { userId: string; conversationId: string },
): Promise<PlannerAskMessage[]> {
  const rows = await db
    .select()
    .from(plannerAgentChat)
    .where(
      and(
        eq(plannerAgentChat.userId, input.userId),
        eq(plannerAgentChat.conversationId, input.conversationId),
      ),
    )
    .orderBy(asc(plannerAgentChat.createdAt))
    .limit(400)
    .all();
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    created_at: row.createdAt,
  }));
}

/** The conversation the owner wrote in last, or null. */
export async function plannerAgentLatestConversation(
  db: FlareMoDb,
  userId: string,
): Promise<string | null> {
  const row = await db
    .select({ conversationId: plannerAgentChat.conversationId })
    .from(plannerAgentChat)
    .where(eq(plannerAgentChat.userId, userId))
    .orderBy(desc(plannerAgentChat.createdAt))
    .limit(1)
    .get();
  return row?.conversationId ?? null;
}
