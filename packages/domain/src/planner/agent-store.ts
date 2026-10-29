import {
  healthLocalMoment,
  PLANNER_AGENT_ACTION_DAYS,
  PLANNER_AGENT_ACTIONS_PER_DAY,
  type PlannerAgentActionDto,
  type PlannerAgentActionField,
  type PlannerAgentProposalDto,
  type PlannerAskMessage,
  type PlannerPillar,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos, memoTags } from "@flaremo/db";
import {
  type PlannerAgentActionRow,
  type PlannerAgentProposalRow,
  type PlannerAgentRunRow,
  plannerAgentAction,
  plannerAgentChat,
  plannerAgentProposal,
  plannerAgentRun,
  plannerGoal,
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
// the goals and tasks it proposed for a week's plan, the Ask chat, and the
// actions it proposed into tasks and the diary (migration 9015). The Worker's
// agent client writes the runs; the MCP tools write the proposals and the
// actions; the routes read them and settle them. Money is in US cents at list
// price throughout.

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

/**
 * Moves a run from one step to the next unless another request already did:
 * true for the one request that may act on the move (two polls of the same
 * finished memo must not both send the propose step).
 */
export async function plannerAgentClaimStep(
  db: FlareMoDb,
  input: { runId: string; from: string; to: string },
): Promise<boolean> {
  const at = new Date().toISOString();
  const result = await db
    .update(plannerAgentRun)
    .set({
      step: input.to,
      stepInput: null,
      stepAt: at,
      stepDoneAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(plannerAgentRun.id, input.runId),
        eq(plannerAgentRun.step, input.from),
      ),
    );
  return result.meta?.changes === 1;
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
  serves: PlannerAgentProposalDto["serves"] = null,
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
    serves: row.kind === "goal" ? serves : null,
  };
}

/**
 * Removes a week's proposals nobody has acted on yet: a new propose step
 * replaces them. Accepted and dismissed ones stay.
 */
export async function plannerAgentClearOpenProposals(
  db: FlareMoDb,
  input: { userId: string; weekStart: string; kind?: "goal" | "task" },
): Promise<void> {
  await db
    .delete(plannerAgentProposal)
    .where(
      and(
        eq(plannerAgentProposal.userId, input.userId),
        eq(plannerAgentProposal.weekStart, input.weekStart),
        eq(plannerAgentProposal.state, "open"),
        input.kind ? eq(plannerAgentProposal.kind, input.kind) : undefined,
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
  // A goal proposal names the month or quarter goal it serves.
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.kind === "goal" && row.goalRef ? [row.goalRef] : [],
      ),
    ),
  ];
  const parents = ids.length
    ? await db
        .select({
          id: plannerGoal.id,
          level: plannerGoal.level,
          periodStart: plannerGoal.periodStart,
          title: plannerGoal.title,
        })
        .from(plannerGoal)
        .where(
          and(
            eq(plannerGoal.userId, input.userId),
            inArray(plannerGoal.id, ids),
            isNull(plannerGoal.deletedAt),
          ),
        )
        .all()
    : [];
  const byId = new Map(parents.map((goal) => [goal.id, goal]));
  return rows.map((row) => {
    const parent = row.goalRef ? byId.get(row.goalRef) : undefined;
    return plannerAgentProposalToDto(
      row,
      parent &&
        (parent.level === "month" || parent.level === "quarter") &&
        parent.periodStart
        ? {
            level: parent.level,
            period_start: parent.periodStart,
            title: parent.title,
          }
        : null,
    );
  });
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
    /** The task the conversation is held from; null for the global chat. */
    taskId?: string | null;
  },
): Promise<PlannerAskMessage> {
  const row = {
    id: crypto.randomUUID(),
    userId: input.userId,
    conversationId: input.conversationId,
    role: input.role,
    text: input.text,
    runId: input.runId,
    taskId: input.taskId ?? null,
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

/**
 * The conversation the owner wrote in last, or null: of a task's own chat
 * when `taskId` is given, else of the global Ask chat (task chats stay out
 * of it).
 */
export async function plannerAgentLatestConversation(
  db: FlareMoDb,
  userId: string,
  taskId: string | null = null,
): Promise<string | null> {
  const row = await db
    .select({ conversationId: plannerAgentChat.conversationId })
    .from(plannerAgentChat)
    .where(
      and(
        eq(plannerAgentChat.userId, userId),
        taskId === null
          ? isNull(plannerAgentChat.taskId)
          : eq(plannerAgentChat.taskId, taskId),
      ),
    )
    .orderBy(desc(plannerAgentChat.createdAt))
    .limit(1)
    .get();
  return row?.conversationId ?? null;
}

/** The task a conversation is held from, or null (also for an unknown one). */
export async function plannerAgentConversationTask(
  db: FlareMoDb,
  input: { userId: string; conversationId: string },
): Promise<string | null> {
  const row = await db
    .select({ taskId: plannerAgentChat.taskId })
    .from(plannerAgentChat)
    .where(
      and(
        eq(plannerAgentChat.userId, input.userId),
        eq(plannerAgentChat.conversationId, input.conversationId),
      ),
    )
    .limit(1)
    .get();
  return row?.taskId ?? null;
}

// ---------------------------------------------------------------------------
// Proposed actions (migration 9015)
// ---------------------------------------------------------------------------

export function plannerAgentActionToDto(
  row: PlannerAgentActionRow,
): PlannerAgentActionDto {
  return {
    id: row.id,
    kind: row.kind,
    task_id: row.taskId,
    field: (row.field as PlannerAgentActionField | null) ?? null,
    change: row.change,
    why: row.why,
    state: row.state,
    landed_id: row.landedId,
    created_at: row.createdAt,
  };
}

/** The first instant of the owner's local day `now` falls in. */
function localDayStart(now: Date): string {
  const day = healthLocalMoment(now.toISOString()).day;
  // The local day starts at most 14 hours before its UTC date and ends 12 hours
  // after; counting from the UTC day's start keeps the cap within a day either way.
  return `${day}T00:00:00.000Z`;
}

/** How many actions the agent proposed today (the owner's day). */
export async function plannerAgentActionsToday(
  db: FlareMoDb,
  input: { userId: string; now?: Date },
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        gte(
          plannerAgentAction.createdAt,
          localDayStart(input.now ?? new Date()),
        ),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Files an action the agent proposed. Throws RangeError at the daily cap, so
 * the tool can tell the agent. A proposal identical to an open one of the same
 * conversation (same kind, task, field and change) is returned instead of
 * filed again.
 */
export async function plannerAgentAddAction(
  db: FlareMoDb,
  input: {
    userId: string;
    runId: string | null;
    conversationId: string | null;
    kind: PlannerAgentActionDto["kind"];
    taskId: string | null;
    field: PlannerAgentActionField | null;
    change: Record<string, unknown>;
    why: string;
    now?: Date;
  },
): Promise<PlannerAgentActionDto> {
  const now = input.now ?? new Date();
  const why = input.why.replace(/\s+/g, " ").trim();
  if (input.conversationId) {
    const open = await db
      .select()
      .from(plannerAgentAction)
      .where(
        and(
          eq(plannerAgentAction.userId, input.userId),
          eq(plannerAgentAction.conversationId, input.conversationId),
          eq(plannerAgentAction.state, "open"),
        ),
      )
      .all();
    const same = open.find(
      (row) =>
        row.kind === input.kind &&
        row.taskId === input.taskId &&
        row.field === input.field &&
        JSON.stringify(row.change) === JSON.stringify(input.change),
    );
    if (same) return plannerAgentActionToDto(same);
  }
  const today = await plannerAgentActionsToday(db, {
    userId: input.userId,
    now,
  });
  if (today >= PLANNER_AGENT_ACTIONS_PER_DAY) {
    throw new RangeError(
      `Today's ${PLANNER_AGENT_ACTIONS_PER_DAY} proposals are used up. Propose again tomorrow; for now, answer in words.`,
    );
  }
  const row: PlannerAgentActionRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    runId: input.runId,
    conversationId: input.conversationId,
    kind: input.kind,
    taskId: input.taskId,
    field: input.field,
    change: input.change,
    why,
    state: "open",
    landedId: null,
    before: null,
    createdAt: now.toISOString(),
    shownAt: null,
    settledAt: null,
  };
  await db.insert(plannerAgentAction).values(row).run();
  return plannerAgentActionToDto(row);
}

/**
 * A conversation's actions, oldest first: the open ones still within their
 * seven days, and the settled ones. Marks the open ones as shown the first
 * time the owner's page lists them.
 */
export async function plannerAgentListActions(
  db: FlareMoDb,
  input: { userId: string; conversationId: string; now?: Date },
): Promise<PlannerAgentActionDto[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.conversationId, input.conversationId),
      ),
    )
    .orderBy(asc(plannerAgentAction.createdAt))
    .limit(200)
    .all();
  const expiry = new Date(
    now.getTime() - PLANNER_AGENT_ACTION_DAYS * 86_400_000,
  ).toISOString();
  const unseen = rows.filter((row) => row.state === "open" && !row.shownAt);
  if (unseen.length) {
    const shownAt = now.toISOString();
    await db
      .update(plannerAgentAction)
      .set({ shownAt })
      .where(
        inArray(
          plannerAgentAction.id,
          unseen.map((row) => row.id),
        ),
      )
      .run();
    for (const row of unseen) row.shownAt = shownAt;
  }
  return rows
    .filter((row) => row.state !== "open" || row.createdAt >= expiry)
    .map(plannerAgentActionToDto);
}

/** One of the owner's actions, or null. */
export async function plannerAgentFindAction(
  db: FlareMoDb,
  input: { userId: string; id: string },
): Promise<PlannerAgentActionRow | null> {
  const row = await db
    .select()
    .from(plannerAgentAction)
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.id, input.id),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Settles an action. `accepted` records what the accept wrote (`landedId`);
 * `reverted` is set when the owner reverts the History event the accept
 * wrote. Only an open action can be accepted or dismissed, and only an
 * accepted one reverted: anything else returns null and changes nothing.
 */
export async function plannerAgentSettleAction(
  db: FlareMoDb,
  input: {
    userId: string;
    id: string;
    state: "accepted" | "dismissed" | "reverted";
    landedId?: string | null;
    now?: Date;
  },
): Promise<PlannerAgentActionDto | null> {
  const from = input.state === "reverted" ? "accepted" : "open";
  const settledAt = (input.now ?? new Date()).toISOString();
  const result = await db
    .update(plannerAgentAction)
    .set({
      state: input.state,
      settledAt,
      ...(input.landedId !== undefined ? { landedId: input.landedId } : {}),
    })
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.id, input.id),
        eq(plannerAgentAction.state, from),
      ),
    );
  if (result.meta?.changes !== 1) return null;
  const row = await plannerAgentFindAction(db, input);
  return row ? plannerAgentActionToDto(row) : null;
}

/** Records what an accepted action wrote (the task or entry id). */
export async function plannerAgentLandAction(
  db: FlareMoDb,
  input: {
    userId: string;
    id: string;
    landedId: string;
    /** The changed field's value before the write, for a revert. */
    before?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .update(plannerAgentAction)
    .set({ landedId: input.landedId, before: input.before ?? null })
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.id, input.id),
        eq(plannerAgentAction.state, "accepted"),
      ),
    )
    .run();
}

/** Puts an accepted action whose write failed back to open. */
export async function plannerAgentReopenAction(
  db: FlareMoDb,
  input: { userId: string; id: string },
): Promise<void> {
  await db
    .update(plannerAgentAction)
    .set({ state: "open", settledAt: null, landedId: null })
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.id, input.id),
        eq(plannerAgentAction.state, "accepted"),
      ),
    )
    .run();
}

/** The actor an accepted action writes as: the archive names the proposal. */
export const PLANNER_AGENT_ACTION_ACTOR_PREFIX = "proposal:";

/** The action id an archived event's actor name carries, or null. */
export function plannerAgentActionOfActor(
  actorName: string | null | undefined,
): string | null {
  return actorName?.startsWith(PLANNER_AGENT_ACTION_ACTOR_PREFIX)
    ? actorName.slice(PLANNER_AGENT_ACTION_ACTOR_PREFIX.length)
    : null;
}

/** The nightly sweep's: expires open actions older than seven days. */
export async function plannerAgentExpireActions(
  db: FlareMoDb,
  now: Date,
): Promise<number> {
  const expiry = new Date(
    now.getTime() - PLANNER_AGENT_ACTION_DAYS * 86_400_000,
  ).toISOString();
  const result = await db
    .update(plannerAgentAction)
    .set({ state: "expired", settledAt: now.toISOString() })
    .where(
      and(
        eq(plannerAgentAction.state, "open"),
        lt(plannerAgentAction.createdAt, expiry),
      ),
    );
  return result.meta?.changes ?? 0;
}
