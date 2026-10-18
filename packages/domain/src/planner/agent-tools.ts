import {
  healthAddDays,
  healthLocalDayStart,
  healthLocalMoment,
  listMemosQuerySchema,
  type PlannerAgentToolInput,
  type PlannerAgentToolName,
  type PlannerGoalDto,
  plannerAddDays,
  plannerAgentToolInputs,
  plannerPeriodStartOf,
  plannerPillarNames,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { memos, memoTags } from "@flaremo/db";
import {
  plannerAgentProposal,
  plannerAgentRun,
  plannerGoal,
} from "@flaremo/db/src/schema/planner";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { healthReadWeek, healthToday } from "../health/read";
import { createMemory, isRejectedRecently, listMemories } from "../memory";
import { computeFingerprint } from "../memory/shared";
import { listMemos } from "../memos-read";
import {
  plannerAgentAddProposal,
  plannerAgentFindQuote,
} from "./agent-store";
import { plannerReadBoard } from "./board";
import { plannerReadGoalsYear } from "./goals";
import { plannerPeriodChatContextBlock } from "./period-review-chat";
import { plannerReadPeriodContext } from "./period-review-context";
import {
  plannerFindSummaryMemo,
  plannerReadReviewContext,
  plannerWeekInstants,
} from "./review-context";
import { plannerReviewContextBlock } from "./review-prompts";

// The general agent's MCP tools (fork-owned add-on, docs/fork-general-agent.md):
// what each one reads, as text the agent reads. The Worker's MCP endpoint
// (routes/planner-agent-mcp.ts) answers `tools/call` with these, and so does the
// eval runner's bridge. Every read is the owner's own rows only. The three
// propose tools are the agent's only writes, and each lands where the owner
// decides on it: a memory waits on the Memory page, a goal or task on the
// review page. A session that may not propose (the Ask chat) has them turned
// off in its tool settings.

/** A whole diary for the agent: it reads tool results, so nothing is cut. */
export const PLANNER_AGENT_DIARY_CHARS = 1_000_000;

/** Who wrote memories the agent proposes, as the memory ledger records it. */
export const PLANNER_AGENT_MEMORY_SOURCE = "agent";

export type PlannerAgentToolContext = {
  db: FlareMoDb;
  user: UserRow;
  now?: Date;
};

/** A tool call the agent can fix: the message goes back to it as the result. */
export class PlannerAgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerAgentToolError";
  }
}

const LIVE = ["normal", "archived"] as const;
const ENTRY_INDEX_MAX = 1_000;
const LIST_DAYS_MAX = 400;
const HEALTH_WEEKS_MAX = 26;

function firstName(user: UserRow): string {
  return user.name.trim().split(/\s+/)[0] || "the owner";
}

function local(at: string): string {
  const moment = healthLocalMoment(at);
  return `${moment.day} ${String(moment.hour).padStart(2, "0")}:${String(moment.minute).padStart(2, "0")}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type EntryRow = {
  id: string;
  at: string;
  content: string;
  source: string;
  summary: boolean;
};

/**
 * The owner's live entries written in [from, to), oldest first, each marked
 * when it is a review memo a model wrote (a weekly or period summary).
 */
async function readEntries(
  db: FlareMoDb,
  userId: string,
  range: { from: string; to: string } | { ids: readonly string[] },
  limit: number,
): Promise<EntryRow[]> {
  const rows = await db
    .select({
      id: memos.id,
      at: memos.createdAt,
      content: memos.content,
      source: memos.source,
    })
    .from(memos)
    .where(
      and(
        eq(memos.userId, userId),
        isNull(memos.deletedAt),
        inArray(memos.status, [...LIVE]),
        "ids" in range
          ? inArray(memos.id, [...range.ids])
          : and(gte(memos.createdAt, range.from), lt(memos.createdAt, range.to)),
      ),
    )
    .orderBy(asc(memos.createdAt))
    .limit(limit)
    .all();
  if (rows.length === 0) return [];
  const tagged = await db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
        inArray(
          memoTags.memoId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .all();
  const summaries = new Set(tagged.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    summary:
      summaries.has(row.id) || row.source === plannerSummaryMemoSource,
  }));
}

function author(entry: EntryRow, name: string): string {
  return entry.summary ? "review memo (a model wrote it)" : name;
}

function indexLine(entry: EntryRow, name: string): string {
  return `${entry.id} | ${local(entry.at)} | ${author(entry, name)} | ${entry.content.length} chars | ${oneLine(entry.content, 90)}`;
}

function wholeEntry(entry: EntryRow, name: string): string {
  return [
    `### Entry ${entry.id}`,
    `Written ${local(entry.at)} by ${author(entry, name)}.`,
    "",
    entry.content.trim(),
  ].join("\n");
}

function goalLine(goal: PlannerGoalDto): string {
  const where =
    goal.level === "north_star"
      ? "North star"
      : `${goal.level} ${goal.period_start}${goal.pillar ? ` · ${plannerPillarNames[goal.pillar]} (${goal.pillar})` : ""}`;
  const lines = goal.lines
    .map((line) => `${line.struck ? "~~" : ""}${line.text}${line.struck ? "~~" : ""}${line.note ? ` (${line.note})` : ""}`)
    .join("; ");
  return [
    `- [${goal.id}] ${where}: ${goal.title || "(no title)"}`,
    lines ? ` Lines: ${lines}.` : "",
    goal.status !== "active" ? ` Status: ${goal.status}.` : "",
    goal.result ? ` Result: ${goal.result}.` : "",
    goal.note ? ` Note: ${oneLine(goal.note, 400)}` : "",
  ].join("");
}

function requireSpan(from: string, to: string, maxDays: number): void {
  if (to < from) {
    throw new PlannerAgentToolError("`to` must not be before `from`.");
  }
  if (plannerAddDays(from, maxDays) < to) {
    throw new PlannerAgentToolError(
      `Ask for at most ${maxDays} days at a time.`,
    );
  }
}

/** The Monday of a week a proposal may plan: last week up to two weeks on. */
function requirePlanWeek(week: string, today: string): void {
  const current = plannerWeekStartOf(today);
  if (week < plannerAddDays(current, -7) || week > plannerAddDays(current, 14)) {
    throw new PlannerAgentToolError(
      "Propose only for the week being planned (next week).",
    );
  }
}

/** The receipt of a proposal, found word for word, or a refusal. */
async function receiptOf(
  context: PlannerAgentToolContext,
  quote: string | undefined,
  entryId: string | undefined,
): Promise<{ quote: string; id: string; day: string } | null> {
  if (!quote) return null;
  const found = await plannerAgentFindQuote(context.db, {
    userId: context.user.id,
    quote,
    entryId,
    now: context.now,
  });
  if (!found) {
    throw new PlannerAgentToolError(
      "Those words were not found word for word in the owner's diary entries (review memos don't count). Copy the owner's words exactly, or leave the quote out.",
    );
  }
  return { quote: quote.replace(/\s+/g, " ").trim(), ...found };
}

/** The newest open review run, which a proposal is filed under. */
async function reviewRunId(
  context: PlannerAgentToolContext,
): Promise<string | null> {
  const row = await context.db
    .select({ id: plannerAgentRun.id })
    .from(plannerAgentRun)
    .where(
      and(
        eq(plannerAgentRun.userId, context.user.id),
        eq(plannerAgentRun.state, "open"),
        inArray(plannerAgentRun.job, ["review", "period"]),
      ),
    )
    .orderBy(desc(plannerAgentRun.updatedAt))
    .limit(1)
    .get();
  return row?.id ?? null;
}

type Handlers = {
  [N in PlannerAgentToolName]: (
    context: PlannerAgentToolContext,
    input: PlannerAgentToolInput<N>,
  ) => Promise<string>;
};

const handlers: Handlers = {
  async review_week(context, input) {
    const { db, user } = context;
    const today = healthToday(context.now);
    const review = await plannerReadReviewContext(db, {
      userId: user.id,
      ownerName: user.name,
      weekStart: input.week,
      today,
      diaryChars: PLANNER_AGENT_DIARY_CHARS,
    });
    const span = plannerWeekInstants(input.week);
    const entries = await readEntries(db, user.id, span, 400);
    const name = firstName(user);
    return [
      `# The week starting Monday ${input.week} (today is ${today})`,
      "",
      plannerReviewContextBlock(review),
      "",
      `Index of every entry written this week, review memos included (id | written | by | length | first words). Quote entries by these ids:`,
      ...(entries.length
        ? entries.map((entry) => indexLine(entry, name))
        : ["(none)"]),
    ].join("\n");
  },

  async review_period(context, input) {
    const { db, user } = context;
    const today = healthToday(context.now);
    const periodStart = plannerPeriodStartOf(input.level, input.period_start);
    const period = await plannerReadPeriodContext(db, {
      userId: user.id,
      ownerName: user.name,
      level: input.level,
      periodStart,
      today,
      diaryChars: PLANNER_AGENT_DIARY_CHARS,
    });
    return [
      `# The ${input.level} starting ${periodStart} (today is ${today})`,
      "",
      plannerPeriodChatContextBlock(period),
    ].join("\n");
  },

  async week_diary(context, input) {
    const { db, user } = context;
    const name = firstName(user);
    const [entries, summary] = await Promise.all([
      readEntries(db, user.id, plannerWeekInstants(input.week), 400),
      plannerFindSummaryMemo(db, { userId: user.id, weekStart: input.week }),
    ]);
    const own = entries.filter((entry) => !entry.summary);
    return [
      `# Week of Monday ${input.week}`,
      "",
      "## Saved weekly summary (a model wrote it; check it against the diary)",
      "",
      summary?.content.trim() ?? "No summary was saved for this week.",
      "",
      `## ${name}'s diary entries, oldest first`,
      "",
      ...(own.length
        ? own.map((entry) => wholeEntry(entry, name))
        : ["No diary entries were written this week."]),
    ].join("\n");
  },

  async list_entries(context, input) {
    requireSpan(input.from, input.to, LIST_DAYS_MAX);
    const { db, user } = context;
    const name = firstName(user);
    const entries = await readEntries(
      db,
      user.id,
      {
        from: healthLocalDayStart(input.from),
        to: healthLocalDayStart(plannerAddDays(input.to, 1)),
      },
      ENTRY_INDEX_MAX + 1,
    );
    const shown = entries.slice(0, ENTRY_INDEX_MAX);
    return [
      `Entries written ${input.from} to ${input.to}, oldest first (id | written | by | length | first words):`,
      ...(shown.length
        ? shown.map((entry) => indexLine(entry, name))
        : ["(none)"]),
      ...(entries.length > ENTRY_INDEX_MAX
        ? [`More than ${ENTRY_INDEX_MAX}: ask for a shorter span.`]
        : []),
    ].join("\n");
  },

  async read_entries(context, input) {
    const { db, user } = context;
    const name = firstName(user);
    const entries = await readEntries(
      db,
      user.id,
      { ids: input.ids },
      input.ids.length,
    );
    const found = new Set(entries.map((entry) => entry.id));
    const missing = input.ids.filter((id) => !found.has(id));
    return [
      ...entries.map((entry) => wholeEntry(entry, name)),
      ...(missing.length ? [`Not found: ${missing.join(", ")}`] : []),
    ].join("\n\n");
  },

  async search_entries(context, input) {
    const { db, user } = context;
    const name = firstName(user);
    const filters = [
      input.from ? `after:${input.from}` : "",
      input.to ? `before:${plannerAddDays(input.to, 1)}` : "",
    ].filter(Boolean);
    const limit = input.limit ?? 20;
    const result = await listMemos(
      db,
      user,
      listMemosQuerySchema.parse({
        q: [input.query, ...filters].join(" "),
        page_size: Math.min(100, limit),
      }),
    );
    const rows = result.memos
      .filter((memo) => memo.userId === user.id)
      .slice(0, limit);
    if (rows.length === 0) return `No entry holds "${input.query}".`;
    const entries = await readEntries(
      db,
      user.id,
      { ids: rows.map((row) => row.id) },
      rows.length,
    );
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    return [
      `Entries holding "${input.query}", newest first (id | written | by | snippet):`,
      ...rows.flatMap((row) => {
        const entry = byId.get(row.id);
        if (!entry) return [];
        const flat = entry.content.replace(/\s+/g, " ");
        const at = Math.max(
          0,
          words
            .map((word) => flat.toLowerCase().indexOf(word))
            .filter((index) => index >= 0)
            .sort((a, b) => a - b)[0] ?? 0,
        );
        const start = Math.max(0, at - 100);
        const snippet = `${start > 0 ? "…" : ""}${flat.slice(start, start + 260)}${start + 260 < flat.length ? "…" : ""}`;
        return [`${entry.id} | ${local(entry.at)} | ${author(entry, name)} | ${snippet}`];
      }),
    ].join("\n");
  },

  async read_goals(context, input) {
    const today = healthToday(context.now);
    const year = input.year ?? Number(today.slice(0, 4));
    const goals = await plannerReadGoalsYear(context.db, {
      userId: context.user.id,
      year,
      today,
    });
    return [
      `# Goals of ${year} (today is ${today})`,
      "",
      goals.north_star ? goalLine(goals.north_star) : "- North star: not written",
      ...goals.goals.map(goalLine),
      "",
      "## Recorded weeks (Authenticity / Achievement, key question for the next review, verdict)",
      ...(goals.weeks.length
        ? goals.weeks.map(
            (week) =>
              `- ${week.week_start}: ${week.auth ?? "–"} / ${week.ach ?? "–"}${week.question ? `; question: ${oneLine(week.question, 300)}` : ""}${week.verdict ? `; verdict: ${oneLine(week.verdict, 300)}` : ""}${week.source === "import" ? " (imported)" : ""}`,
          )
        : ["(none)"]),
    ].join("\n");
  },

  async read_tasks(context, input) {
    const today = healthToday(context.now);
    const board = await plannerReadBoard(context.db, {
      userId: context.user.id,
      today,
      doneDays: input.done_days ?? 14,
    });
    const column = (title: string, cards: typeof board.columns.todo) => [
      `## ${title} (${cards.length})`,
      ...(cards.length
        ? cards.map(
            (card) =>
              `- [${card.id}] ${oneLine(card.title, 200)}${card.horizon ? ` · planned for the ${card.horizon} of ${card.period_start}` : ""}${card.due_at ? ` · due ${card.due_at.slice(0, 10)}` : ""}${card.completed_at ? ` · done ${local(card.completed_at)}` : ""}${card.project_name ? ` · project ${card.project_name}` : ""}${card.goal_id ? ` · goal ${card.goal_id}` : ""}${card.carry_count ? ` · carried over ${card.carry_count}×` : ""}`,
          )
        : ["(none)"]),
      "",
    ];
    return [
      `# The task board (today is ${today})`,
      "",
      ...column("Doing", board.columns.doing),
      ...column("To Do", board.columns.todo),
      ...column(
        `Done in the last ${input.done_days ?? 14} days`,
        board.columns.done,
      ),
      ...column("Backlog", board.columns.backlog),
      ...(board.columns.other.length
        ? column("Other", board.columns.other)
        : []),
      ...(board.truncated ? ["The board was cut at 500 cards."] : []),
    ].join("\n");
  },

  async read_health(context, input) {
    requireSpan(input.from, input.to, HEALTH_WEEKS_MAX * 7);
    const out: string[] = [
      `# Health tracker, ${input.from} to ${input.to}`,
    ];
    for (
      let start = input.from;
      start <= input.to;
      start = healthAddDays(start, 7)
    ) {
      const week = await healthReadWeek(context.db, {
        userId: context.user.id,
        start,
        now: context.now,
      });
      const s = week.summary;
      out.push(
        "",
        `## ${week.start} to ${week.end}: training ${s.training.sessions} of ${s.training.target}; breathwork on ${s.breath.days} days (${s.breath.minutes} min, target ${s.breath.target}); nights out ${s.night_out.nights} (${s.night_out.units} units, ${s.night_out.year_used} of ${s.night_out.year_target} this year)${week.trackers.length ? `; ${week.trackers.map((t) => `${t.kind}: ${t.days} days, ${t.minutes} min`).join("; ")}` : ""}`,
        ...week.entries
          .filter((entry) => entry.day <= input.to)
          .map(
            (entry) =>
              `- ${entry.day} ${entry.kind}${entry.variant ? ` (${entry.variant})` : ""}${entry.minutes ? `, ${entry.minutes} min` : ""}${entry.units !== null ? `, ${entry.units} units` : ""}${entry.home_at ? `, home ${entry.home_at}` : ""}${entry.bender ? ", bender" : ""}${entry.feel ? `, felt: ${oneLine(entry.feel, 120)}` : ""}`,
          ),
      );
    }
    return out.join("\n");
  },

  async read_memories(context, input) {
    const result = await listMemories(context.db, context.user, {
      q: input.query || undefined,
      status: "active",
      pageSize: 100,
    });
    if (result.memories.length === 0) {
      return input.query
        ? `No memory holds "${input.query}".`
        : "The memory ledger is empty.";
    }
    return [
      "Memories (id | kind | standing | content):",
      ...result.memories.map(
        (memory) =>
          `- ${memory.id} | ${memory.kind} | ${
            memory.verification === "confirmed" || memory.verification === "locked"
              ? "confirmed by the owner"
              : memory.needs_review
                ? "a proposal, waiting for the owner"
                : "noted by an agent"
          } | ${oneLine(memory.content, 400)}`,
      ),
    ].join("\n");
  },

  async propose_memory(context, input) {
    const { db, user } = context;
    const receipt = await receiptOf(context, input.quote, input.entry_id);
    if (!receipt) {
      throw new PlannerAgentToolError("A memory needs the owner's words.");
    }
    const fingerprint = await computeFingerprint(
      user,
      input.content.trim().replace(/\s+/g, " "),
      "semantic",
      input.kind,
      "global",
      null,
    );
    const rejected = await isRejectedRecently(db, user.id, null, fingerprint);
    if (rejected.blocked) {
      throw new PlannerAgentToolError(
        "The owner rejected this memory in the last 30 days. Don't propose it again.",
      );
    }
    const created = await createMemory(
      db,
      user,
      { type: "agent", name: PLANNER_AGENT_MEMORY_SOURCE },
      {
        content: input.content,
        factKey: null,
        tags: [],
        type: "semantic",
        kind: input.kind,
        scopeType: "global",
        scopeKey: null,
        tier: "normal",
        importance: 50,
        confidence: 60,
        verification: "inferred",
        sourceAgent: PLANNER_AGENT_MEMORY_SOURCE,
        evidence: [
          {
            sourceType: "memo",
            sourceId: `memos/${receipt.id}`,
            relationType: "derived_from",
            observedAt: receipt.day,
            excerpt: receipt.quote,
          },
        ],
      },
    );
    if (created.duplicate) {
      return `Already held as memory ${created.memory.id}; nothing new was proposed.`;
    }
    return `Proposed as memory ${created.memory.id}. It waits on the Memory page for the owner; the receipt is the entry of ${receipt.day}.`;
  },

  async propose_goal(context, input) {
    requirePlanWeek(input.week, healthToday(context.now));
    const receipt = await receiptOf(context, input.quote, input.entry_id);
    const proposal = await plannerAgentAddProposal(context.db, {
      userId: context.user.id,
      runId: await reviewRunId(context),
      weekStart: input.week,
      kind: "goal",
      pillar: input.pillar,
      title: input.title,
      lines: input.lines ?? [],
      goalRef: null,
      why: input.why,
      receipt,
    }).catch((error: unknown) => {
      if (error instanceof RangeError) {
        throw new PlannerAgentToolError(error.message);
      }
      throw error;
    });
    return `Proposed goal ${proposal.id} for the week of ${input.week}. A task can name it as goal_ref.`;
  },

  async propose_task(context, input) {
    const { db, user } = context;
    requirePlanWeek(input.week, healthToday(context.now));
    if (input.goal_ref) {
      const [goal, proposal] = await Promise.all([
        db
          .select({ id: plannerGoal.id })
          .from(plannerGoal)
          .where(
            and(
              eq(plannerGoal.userId, user.id),
              eq(plannerGoal.id, input.goal_ref),
              isNull(plannerGoal.deletedAt),
            ),
          )
          .get(),
        db
          .select({ id: plannerAgentProposal.id })
          .from(plannerAgentProposal)
          .where(
            and(
              eq(plannerAgentProposal.userId, user.id),
              eq(plannerAgentProposal.id, input.goal_ref),
              eq(plannerAgentProposal.kind, "goal"),
            ),
          )
          .get(),
      ]);
      if (!goal && !proposal) {
        throw new PlannerAgentToolError(
          "goal_ref names no goal: use a goal id from read_goals or an id propose_goal returned.",
        );
      }
    }
    const receipt = await receiptOf(context, input.quote, input.entry_id);
    const proposal = await plannerAgentAddProposal(db, {
      userId: user.id,
      runId: await reviewRunId(context),
      weekStart: input.week,
      kind: "task",
      pillar: input.pillar ?? null,
      title: input.title,
      lines: [],
      goalRef: input.goal_ref ?? null,
      why: input.why,
      receipt,
    }).catch((error: unknown) => {
      if (error instanceof RangeError) {
        throw new PlannerAgentToolError(error.message);
      }
      throw error;
    });
    return `Proposed task ${proposal.id} for the week of ${input.week}.`;
  },
};

/**
 * Runs one tool for the owner and returns its text. A bad input or a refused
 * proposal is a PlannerAgentToolError, whose message the agent can act on.
 */
export async function plannerAgentCallTool(
  context: PlannerAgentToolContext,
  name: string,
  args: unknown,
): Promise<string> {
  if (!Object.hasOwn(plannerAgentToolInputs, name)) {
    throw new PlannerAgentToolError(`There is no tool named ${name}.`);
  }
  const tool = name as PlannerAgentToolName;
  const parsed = plannerAgentToolInputs[tool].safeParse(args ?? {});
  if (!parsed.success) {
    throw new PlannerAgentToolError(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  const handler = handlers[tool] as (
    context: PlannerAgentToolContext,
    input: unknown,
  ) => Promise<string>;
  return handler(context, parsed.data);
}
