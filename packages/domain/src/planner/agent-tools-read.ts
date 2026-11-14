import {
  healthAddDays,
  healthBreathVariants,
  healthLocalDayStart,
  healthLocalMoment,
  healthTrainingVariants,
  listMemosQuerySchema,
  PLANNER_FLYWHEEL_MIN_SAMPLE,
  PLANNER_STALE_BACKLOG_WEEKS,
  PLANNER_TODO_DAYS_DEFAULT,
  plannerAddDays,
  plannerFlywheelMetrics,
  plannerLinkSummarySource,
  plannerPeriodStartOf,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { healthReadWeek, healthToday } from "../health/read";
import { listMemos } from "../memos-read";
import {
  plannerAskAttention,
  plannerEntrySentences,
  plannerHealthKindOf,
  plannerMentionsHealth,
  plannerSentenceAboutTask,
  plannerSoundsDone,
  plannerSpanStart,
  plannerTrainingVariantOf,
} from "./ask-starters";
import { plannerReadBoard } from "./board";
import {
  PLANNER_TODO_LINES_MAX,
  plannerDiaryTodoLines,
  plannerTodoMatch,
  plannerTodoSourceKey,
} from "./diary-todos";
import {
  plannerCurrentTuning,
  plannerFlywheelWeekOf,
  plannerReadScorecard,
} from "./flywheel";
import { plannerReadGoalsYear } from "./goals";
import { plannerReadTaskHistory } from "./history-read";
import { plannerSyncHistory } from "./history-sync";
import { plannerPeriodChatContextBlock } from "./period-review-chat";
import { plannerReadPeriodContext } from "./period-review-context";
import { plannerBeforeAsOf } from "./review-as-of";
import {
  plannerFindSummaryMemo,
  plannerReadReviewContext,
  plannerWeekInstants,
} from "./review-context";
import { plannerReviewContextBlock } from "./review-prompts";
import { plannerNow } from "./shared";
import { plannerReadTaskDetail } from "./task-detail";

// The general agent's MCP tools (fork-owned add-on, docs/fork-general-agent.md):
// what each one reads, as text the agent reads. The Worker's MCP endpoint
// (routes/planner-agent-mcp.ts) answers `tools/call` with these, and so does the
// eval runner's bridge. Every read is the owner's own rows only. The propose
// tools are the agent's only writes, and each lands where the owner decides on
// it: a goal or task waits on the review page, and
// an action (one task field, a new task, a new diary entry; migration 9015) as
// a card in the chat it was proposed in. The review proposals work only while a
// review is at a step that asks for them (the Ask chat has them turned off in
// its tool settings); the actions only while an Ask chat is answering.

/** A whole diary for the agent: it reads tool results, so nothing is cut. */

import {
  askingRun,
  author,
  ENTRY_INDEX_MAX,
  fileState,
  fileText,
  firstName,
  goalLine,
  type Handlers,
  HEALTH_WEEKS_MAX,
  indexLine,
  LIST_DAYS_MAX,
  local,
  offeredTodos,
  oneLine,
  ownEntries,
  ownerGaveLink,
  PLANNER_AGENT_DIARY_CHARS,
  type PlannerAgentLinkReading,
  PlannerAgentToolError,
  plannerAgentLinkKey,
  plannerAgentLinkText,
  readEntries,
  requireSpan,
  toolToday,
  wholeEntry,
} from "./agent-tools-shared";

type Names =
  | "review_week"
  | "review_period"
  | "week_diary"
  | "list_entries"
  | "read_entries"
  | "search_entries"
  | "read_goals"
  | "read_tasks"
  | "read_task"
  | "read_health"
  | "find_todos"
  | "find_done_tasks"
  | "find_replan_tasks"
  | "find_stale_backlog"
  | "compare_health"
  | "read_scorecard"
  | "read_link";

export const plannerAgentReadHandlers: Pick<Handlers, Names> = {
  async review_week(context, input) {
    const { db, user } = context;
    const today = toolToday(context);
    const review = await plannerReadReviewContext(db, {
      userId: user.id,
      ownerName: user.name,
      weekStart: input.week,
      today,
      diaryChars: PLANNER_AGENT_DIARY_CHARS,
      cascade: context.cascade,
    });
    const span = plannerWeekInstants(input.week);
    const entries = await readEntries(db, user.id, span, 400, context.asOf);
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
      readEntries(
        db,
        user.id,
        plannerWeekInstants(input.week),
        400,
        context.asOf,
      ),
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
      context.asOf,
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
      context.asOf,
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
      context.asOf,
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
        return [
          `${entry.id} | ${local(entry.at)} | ${author(entry, name)} | ${snippet}`,
        ];
      }),
    ].join("\n");
  },

  async read_goals(context, input) {
    const today = toolToday(context);
    const year = input.year ?? Number(today.slice(0, 4));
    const read = await plannerReadGoalsYear(context.db, {
      userId: context.user.id,
      year,
      today,
    });
    // The replay's cut: goals made later and the weeks from the reviewed
    // one on (its scores are saved at the cut) are not there yet.
    const before = plannerBeforeAsOf(context.asOf);
    const goals = context.asOf
      ? {
          ...read,
          goals: read.goals.filter((goal) => before(goal.created_at)),
          weeks: read.weeks.filter(
            (week) => week.week_start < (context.asOf?.weekStart ?? ""),
          ),
        }
      : read;
    return [
      `# Goals of ${year} (today is ${today})`,
      "",
      goals.north_star
        ? goalLine(goals.north_star)
        : "- North star: not written",
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
    const today = toolToday(context);
    const read = await plannerReadBoard(context.db, {
      userId: context.user.id,
      today,
      doneDays: input.done_days ?? 14,
    });
    // The replay's cut: tasks made or finished after it are not there yet
    // (a task finished later shows nowhere rather than as done).
    const before = plannerBeforeAsOf(context.asOf);
    const cut = (cards: typeof read.columns.todo) =>
      cards.filter(
        (card) => before(card.created_at) && before(card.completed_at),
      );
    const board = context.asOf
      ? {
          ...read,
          columns: {
            ...read.columns,
            backlog: cut(read.columns.backlog),
            todo: cut(read.columns.todo),
            doing: cut(read.columns.doing),
            done: cut(read.columns.done),
            other: cut(read.columns.other),
            ...(read.columns.dropped
              ? { dropped: cut(read.columns.dropped) }
              : {}),
          },
        }
      : read;
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

  async read_task(context, input) {
    const { db, user } = context;
    const today = toolToday(context);
    const before = plannerBeforeAsOf(context.asOf);
    let detail: Awaited<ReturnType<typeof plannerReadTaskDetail>>;
    try {
      detail = await plannerReadTaskDetail(db, {
        userId: user.id,
        taskId: input.task_id,
      });
    } catch {
      throw new PlannerAgentToolError(
        "No task has that id. Use an id from read_tasks.",
      );
    }
    const { task, plan } = detail;
    const column = plan?.dropped_at
      ? "dropped"
      : task.status === "done"
        ? "Done"
        : task.status === "in_progress"
          ? "Doing"
          : plan?.horizon
            ? "To Do"
            : "Backlog";
    // The archive is synced first, as the panel's own History read does, so
    // the latest edits are in what the agent reads.
    await plannerSyncHistory(db, {
      userId: user.id,
      now: plannerNow(context.now),
    });
    const history = (
      await plannerReadTaskHistory(db, {
        userId: user.id,
        taskId: task.id,
        limit: 30,
      })
    ).filter((event) => before(event.occurred_at));
    if (context.asOf) {
      detail.comments = detail.comments.filter((comment) =>
        before(comment.created_at),
      );
      detail.attachments = detail.attachments.filter((file) =>
        before(file.created_at),
      );
    }
    return [
      `# Task ${task.id} (today is ${today})`,
      `Title: ${task.title}`,
      `Column: ${column}${plan?.horizon ? ` · planned for the ${plan.horizon} of ${plan.period_start}` : ""}`,
      `Due: ${task.due_at ?? "not set"} · Priority: ${task.priority} · Effort: ${plan?.effort ?? "not set"} · Start: ${plan?.start_date ?? "not set"}`,
      `Goal: ${plan?.goal_id ?? "none"}${detail.project ? ` · Project: ${detail.project.name}` : ""}`,
      `Created ${local(task.created_at)}; last changed ${local(task.updated_at)}.`,
      "",
      "## Notes",
      "",
      task.notes?.trim() || "(no notes)",
      "",
      `## Comments (${detail.comments.length}, oldest first)`,
      ...(detail.comments.length
        ? detail.comments.map(
            (comment) => `- ${local(comment.created_at)}: ${comment.body}`,
          )
        : ["(none)"]),
      "",
      // The files on the task: their text, when read, is in the comments above
      // (an accepted card) or follows here while the card waits, so "here is
      // the email, what should I do" works before the owner accepts anything.
      `## Files (${detail.attachments.length})`,
      ...(detail.attachments.length
        ? detail.attachments.flatMap((file) => [
            `- ${file.filename} (${file.content_type ?? "unknown type"}, ${file.size} bytes, added ${local(file.created_at)}): ${fileState(file)}`,
            ...fileText(file),
          ])
        : ["(none)"]),
      "",
      `## History (newest first, ${history.length} of the latest events)`,
      ...(history.length
        ? history.map(
            (event) =>
              `- ${local(event.occurred_at)} ${event.type}${event.actor_type === "agent" ? " (agent)" : ""}${Object.keys(event.data).length ? ` ${oneLine(JSON.stringify(event.data), 160)}` : ""}`,
          )
        : ["(none)"]),
    ].join("\n");
  },

  async read_health(context, input) {
    requireSpan(input.from, input.to, HEALTH_WEEKS_MAX * 7);
    const out: string[] = [`# Health tracker, ${input.from} to ${input.to}`];
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
          .filter((entry) => plannerBeforeAsOf(context.asOf)(entry.day))
          .map(
            (entry) =>
              `- ${entry.id} | ${entry.day} ${entry.kind}${entry.variant ? ` (${entry.variant})` : ""}${entry.minutes ? `, ${entry.minutes} min` : ""}${entry.units !== null ? `, ${entry.units} units` : ""}${entry.home_at ? `, home ${entry.home_at}` : ""}${entry.bender ? ", bender" : ""}${entry.feel ? `, felt: ${oneLine(entry.feel, 120)}` : ""}`,
          ),
      );
    }
    return out.join("\n");
  },

  async find_todos(context, input) {
    const { db, user } = context;
    const today = toolToday(context);
    const days = input.days ?? PLANNER_TODO_DAYS_DEFAULT;
    const from = plannerAddDays(today, -(days - 1));
    const entries = (
      await readEntries(
        db,
        user.id,
        {
          from: healthLocalDayStart(from),
          to: healthLocalDayStart(plannerAddDays(today, 1)),
        },
        ENTRY_INDEX_MAX,
        context.asOf,
      )
    ).filter(
      // The owner's own words only: no review memo, no link summary.
      (entry) => !entry.summary && entry.source !== plannerLinkSummarySource,
    );
    const board = await plannerReadBoard(db, {
      userId: user.id,
      today,
      doneDays: days + 30,
      includeDropped: true,
    });
    const tasks = [
      ...board.columns.backlog.map((card) => ({ ...card, where: "Backlog" })),
      ...board.columns.todo.map((card) => ({ ...card, where: "To Do" })),
      ...board.columns.doing.map((card) => ({ ...card, where: "Doing" })),
      ...board.columns.done.map((card) => ({ ...card, where: "Done" })),
      ...board.columns.other.map((card) => ({
        ...card,
        where: "on the board",
      })),
      ...(board.columns.dropped ?? []).map((card) => ({
        ...card,
        where: "dropped",
      })),
    ];
    const offered = await offeredTodos(context);
    const lines: string[] = [];
    let total = 0;
    // Newest entries first: a to-do written yesterday matters more.
    for (const entry of [...entries].reverse()) {
      for (const todo of plannerDiaryTodoLines(entry.content)) {
        total += 1;
        if (lines.length >= PLANNER_TODO_LINES_MAX) continue;
        const match = plannerTodoMatch(todo.quote, tasks);
        const before = offered.get(plannerTodoSourceKey(entry.id, todo.quote));
        const status = before
          ? `offered before (${before}): do not offer again`
          : match
            ? `maybe on the board: [${match.id}] "${oneLine(match.title, 120)}" (${match.where})`
            : "not on the board";
        lines.push(
          `- entry ${entry.id} | ${local(entry.at)}${todo.checkbox ? " | open box" : ""} | ${JSON.stringify(todo.quote)} | ${status}`,
        );
      }
    }
    return [
      `Lines that read like to-dos in the owner's entries ${from} to ${today}, newest first (entry | written | words | board):`,
      ...(lines.length ? lines : ["(none)"]),
      ...(total > lines.length
        ? [`${total - lines.length} more not listed: ask for fewer days.`]
        : []),
      "",
      "These come from fixed word rules: many are plans already done, wishes or thoughts, not tasks. Read the entry with read_entries when unsure. A 'maybe on the board' match is loose: check the title. For each real, still-open to-do with no task, call propose_add_task with from_entry_id and from_quote copied exactly from the words above, a short task title in the owner's language, and a due day only when the entry names one. Offer at most 12, the clearest first.",
    ].join("\n");
  },

  async find_done_tasks(context, input) {
    const today = toolToday(context);
    const days = input.days ?? PLANNER_TODO_DAYS_DEFAULT;
    const from = plannerSpanStart(today, days);
    const entries = await ownEntries(context, from, today);
    const board = await plannerReadBoard(context.db, {
      userId: context.user.id,
      today,
      doneDays: 0,
    });
    const open = (["doing", "todo", "backlog"] as const).flatMap((column) =>
      board.columns[column].map((card) => ({ ...card, column })),
    );
    const out: string[] = [];
    for (const task of open) {
      const lines: string[] = [];
      for (const entry of [...entries].reverse()) {
        for (const sentence of plannerEntrySentences(entry.content)) {
          if (!plannerSentenceAboutTask(sentence, task.title)) continue;
          lines.push(
            `    - entry ${entry.id} | ${local(entry.at)} | ${JSON.stringify(oneLine(sentence, 280))}${plannerSoundsDone(sentence) ? " | sounds done" : ""}`,
          );
          if (lines.length >= 4) break;
        }
        if (lines.length >= 4) break;
      }
      if (lines.length === 0) continue;
      out.push(
        `- [${task.id}] ${JSON.stringify(oneLine(task.title, 200))} (${task.column}${task.due_at ? `, due ${task.due_at.slice(0, 10)}` : ""})`,
        ...lines,
      );
    }
    return [
      `Open tasks that the owner's entries ${from} to ${today} mention, newest lines first:`,
      ...(out.length ? out : ["(none)"]),
      "",
      "Fixed word rules: a line can mention a task without finishing it ('need to send the invoice'). Propose only a task an entry shows is finished: propose_task_change with column 'done', from_entry_id and from_quote (the line's words, exactly). Say how many you left open and why in one line.",
    ].join("\n");
  },

  async find_replan_tasks(context) {
    const today = toolToday(context);
    const { overdue, stuck } = await plannerAskAttention(context.db, {
      userId: context.user.id,
      today,
    });
    const line = (card: (typeof overdue)[number], why: string) =>
      `- [${card.id}] ${JSON.stringify(oneLine(card.title, 200))} | ${why} | ${card.column}${card.due_at ? ` | due ${card.due_at.slice(0, 10)}` : ""} | untouched ${card.idle_days} days${card.carry_count ? ` | carried over ${card.carry_count}x` : ""}${card.goal_id ? ` | goal ${card.goal_id}` : ""}`;
    return [
      `Tasks to replan, today ${today} (the week runs to ${plannerAddDays(plannerWeekStartOf(today), 6)}):`,
      ...overdue.map((card) => line(card, "overdue")),
      ...stuck.map((card) => line(card, "stuck in Doing")),
      ...(overdue.length + stuck.length ? [] : ["(none)"]),
      "",
      "One row per task, with propose_task_change: a new due_at (a realistic day; spread them, at most two or three a day), column 'backlog' when it is not for now, or dropped true when the record shows it no longer matters. Read the task first with read_task when unsure. Keep each why to one short line.",
    ].join("\n");
  },

  async find_stale_backlog(context, input) {
    const today = toolToday(context);
    const weeks = input.weeks ?? PLANNER_STALE_BACKLOG_WEEKS;
    const { stale } = await plannerAskAttention(context.db, {
      userId: context.user.id,
      today,
      staleWeeks: weeks,
    });
    return [
      `Backlog cards untouched for ${weeks} weeks or more, oldest first:`,
      ...(stale.length
        ? stale.map(
            (card) =>
              `- [${card.id}] ${JSON.stringify(oneLine(card.title, 200))} | untouched ${card.idle_days} days | made ${card.created_at.slice(0, 10)}${card.due_at ? ` | due ${card.due_at.slice(0, 10)}` : ""}${card.goal_id ? ` | goal ${card.goal_id}` : ""}`,
          )
        : ["(none)"]),
      "",
      "One row per card, at most 25, with propose_task_change: schedule it (a due_at, or column 'todo' when it belongs to this week) when the diary or a goal shows it still matters, otherwise drop it (dropped true; it can be put back). The owner unticks a row to keep the card as it is.",
    ].join("\n");
  },

  async compare_health(context, input) {
    const today = toolToday(context);
    const days = input.days ?? PLANNER_TODO_DAYS_DEFAULT;
    const from = plannerSpanStart(today, days);
    const entries = await ownEntries(context, from, today);
    const rows = await context.db
      .select()
      .from(healthEntry)
      .where(
        and(
          eq(healthEntry.userId, context.user.id),
          gte(healthEntry.day, from),
          lte(healthEntry.day, today),
          isNull(healthEntry.deletedAt),
          eq(healthEntry.dismissed, false),
        ),
      )
      .orderBy(asc(healthEntry.day))
      .all();
    type Mention = {
      entry: string;
      kind: "training" | "breath" | "night_out";
      /** A cardio line meets only a cardio row: a gym row is another session. */
      variant: string | null;
      sentence: string;
    };
    const mentions = new Map<string, Mention[]>();
    for (const entry of entries) {
      const day = healthLocalMoment(entry.at).day;
      for (const sentence of plannerEntrySentences(entry.content)) {
        if (!plannerMentionsHealth(sentence)) continue;
        const kind = plannerHealthKindOf(sentence);
        const list = mentions.get(day) ?? [];
        list.push({
          entry: entry.id,
          kind,
          variant:
            kind === "training" ? plannerTrainingVariantOf(sentence) : null,
          sentence,
        });
        mentions.set(day, list);
      }
    }
    const kindName = (kind: string) => kind.replace("_", " ");
    const out: string[] = [];
    let missing = 0;
    for (let day = from; day <= today; day = plannerAddDays(day, 1)) {
      const logged = rows.filter((row) => row.day === day);
      const said = mentions.get(day) ?? [];
      if (logged.length === 0 && said.length === 0) continue;
      const fits = (row: (typeof rows)[number], m: Mention) =>
        row.kind === m.kind && (!m.variant || row.variant === m.variant);
      const unmatched = said.filter(
        (m) =>
          !logged.some((row) => fits(row, m)) &&
          !rows.some((row) => row.memoId === m.entry && fits(row, m)),
      );
      missing += unmatched.length;
      const mark =
        logged.length === 0
          ? " | entries mention it, no row"
          : said.length === 0
            ? " | rows, no entry mentions it"
            : unmatched.length
              ? " | an entry mentions a session with no row"
              : "";
      out.push(
        `## ${day}${mark}`,
        ...logged.map(
          (row) =>
            `  - row ${row.id} | ${row.kind}${row.variant ? ` (${row.variant})` : ""}${row.minutes ? `, ${row.minutes} min` : ""}${row.homeAt ? `, home ${row.homeAt}` : ""} | ${row.source}${row.memoId ? ` from entry ${row.memoId}` : ""}${row.edited ? ", edited by the owner" : ""}`,
        ),
        ...said.map((m) => {
          const name = `${kindName(m.kind)}${m.variant ? ` (${m.variant})` : ""}`;
          const fromThis = rows.find(
            (row) => row.memoId === m.entry && fits(row, m),
          );
          const same = logged.filter((row) => fits(row, m));
          const other = logged.filter(
            (row) => row.kind === m.kind && !fits(row, m),
          );
          const status = fromThis
            ? `${name}: logged from this entry${fromThis.day === day ? "" : ` on ${fromThis.day}`}`
            : same.length
              ? `${name}: the day has a ${name} row; check it is this session`
              : `${name}: NO ${name} row that day${other.length ? ` (it has ${other.map((row) => row.variant ?? kindName(row.kind)).join(", ")}, another session)` : ""}`;
          return `    - entry ${m.entry} | ${JSON.stringify(oneLine(m.sentence, 280))} | ${status}`;
        }),
      );
    }
    return [
      `The health log next to the diary, ${from} to today ${today}. Each entry line says whether the log has a row of its kind that day. ${missing} ${missing === 1 ? "line has" : "lines have"} none. An entry's mention may be about another day ('yesterday'), a plan or a skip, so read the line:`,
      ...(out.length ? out : ["(nothing logged or mentioned)"]),
      "",
      `Propose with propose_health_change what the diary shows: add a row for a session or night the log lacks (action add, day, kind, and variant and minutes when the line gives them), fix a row's minutes, variant or day, or remove a row the diary contradicts ('skipped the gym'). A line marked NO ... row that describes a session that happened (a run, a gym session, breathwork, a night out) is the main thing to add. Training variants: ${healthTrainingVariants.join(", ")} (a run, ride, swim or zone 2 is cardio); breathwork: ${healthBreathVariants.join(", ")}. A day can hold two training sessions of different variants. Do not add a row the log already holds for that day, kind and variant, and leave a row the owner edited unless the diary plainly says otherwise.`,
    ].join("\n");
  },

  async read_scorecard(context, input) {
    const now = plannerNow(context.now);
    const weekStart = plannerFlywheelWeekOf(now);
    const weeks = await plannerReadScorecard(context.db, {
      userId: context.user.id,
      weekStart,
      weeks: input.weeks ?? 8,
    });
    const tuning = await plannerCurrentTuning(context.db, context.user.id);
    const out = [
      tuning?.instructions.trim()
        ? `Your standing instructions from the owner (version ${tuning.version}):\n${tuning.instructions.trim()}`
        : "You have no standing instructions from the owner yet.",
      "",
      `The scorecard, newest week first. ai = started by one of your accepted proposals, manual = by the owner. A share over fewer than ${PLANNER_FLYWHEEL_MIN_SAMPLE} cases is too few to read.`,
    ];
    if (weeks.length === 0) out.push("No week has been scored yet.");
    for (const week of weeks) {
      const parts = week.values
        .filter((value) => value.den > 0 || value.value !== null)
        .map((value) => {
          const meta = plannerFlywheelMetrics[value.metric];
          const shown =
            meta.unit === "share"
              ? value.den < PLANNER_FLYWHEEL_MIN_SAMPLE
                ? `too few (${value.num} of ${value.den})`
                : `${Math.round((value.value ?? 0) * 100)}% of ${value.den}`
              : meta.unit === "cents"
                ? `${value.value ?? "none"} cents`
                : `${value.value ?? "none"}`;
          return `${meta.label} (${value.origin}): ${shown}`;
        });
      out.push(
        `- Week of ${week.week_start}: ${parts.join("; ") || "nothing to count"}`,
      );
    }
    return out.join("\n");
  },

  async read_link(context, input) {
    const asking = await askingRun(context);
    const url = plannerAgentLinkKey(input.url);
    if (!url) {
      throw new PlannerAgentToolError(
        "That is not a web address (it must start with http:// or https://).",
      );
    }
    const given = await ownerGaveLink(context, asking, url, input.entry_id);
    if (!given) {
      throw new PlannerAgentToolError(
        input.entry_id
          ? `Entry ${input.entry_id} does not hold that address. Read only links the owner gave you.`
          : "The owner did not give that address in this chat. Read only links the owner gave you; for a link in an entry, name the entry with entry_id.",
      );
    }
    if (!context.readLink) {
      throw new PlannerAgentToolError("Links cannot be read here.");
    }
    let reading: PlannerAgentLinkReading;
    try {
      reading = await context.readLink(input.url.trim());
    } catch (error) {
      throw new PlannerAgentToolError(
        `The link could not be read: ${error instanceof Error ? error.message : "unknown error"}. Tell the owner; they can paste the text into the chat instead.`,
      );
    }
    return plannerAgentLinkText(reading, {
      url: input.url.trim(),
      fromEntryId: input.entry_id,
    });
  },
};
