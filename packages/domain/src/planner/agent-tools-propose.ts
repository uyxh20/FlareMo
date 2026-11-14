import {
  healthBreathVariants,
  healthIsBuiltinKind,
  healthNightUnitsFor,
  healthParseDay,
  healthTrainingVariants,
  healthWellnessVariants,
  plannerAddDays,
  plannerAgentInputFields,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import {
  plannerAgentProposal,
  plannerGoal,
} from "@flaremo/db/src/schema/planner";
import { and, eq, isNull } from "drizzle-orm";
import { healthToday } from "../health/read";
import { healthFindEntry } from "../health/write";
import { parseResourceName } from "../ids";
import {
  plannerAgentTaskFieldNow,
  plannerEntryReferences,
} from "./agent-apply";
import { plannerAgentAddProposal } from "./agent-store";
import { plannerTodoSourceKey } from "./diary-todos";
import { plannerEntryRetag } from "./entry-tags";
import {
  plannerGoalToDto,
  plannerLoadLiveGoal,
  plannerRequireWeeklyGoal,
} from "./goals";
import { plannerNormalizeTaskId } from "./shared";
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
  cascadeGoalOf,
  entryPreview,
  entrySource,
  fileAction,
  type Handlers,
  offeredTodos,
  PlannerAgentToolError,
  proposedEntry,
  proposePlace,
  proposingRun,
  receiptOf,
  requirePlanWeek,
  toolToday,
} from "./agent-tools-shared";

type Names =
  | "propose_goal"
  | "propose_task"
  | "propose_task_change"
  | "propose_task_comment"
  | "propose_entry_edit"
  | "propose_entry_tags"
  | "propose_entry_state"
  | "propose_entry_link"
  | "propose_health_change"
  | "propose_goal_change"
  | "propose_add_task"
  | "propose_entry";

export const plannerAgentProposeHandlers: Pick<Handlers, Names> = {
  async propose_goal(context, input) {
    requirePlanWeek(input.week, healthToday(context.now));
    const runId = await proposingRun(context, ["review"]);
    if (input.serves) {
      const parent = await context.db
        .select({ level: plannerGoal.level })
        .from(plannerGoal)
        .where(
          and(
            eq(plannerGoal.userId, context.user.id),
            eq(plannerGoal.id, input.serves),
            isNull(plannerGoal.deletedAt),
          ),
        )
        .get();
      if (parent?.level !== "month" && parent?.level !== "quarter") {
        throw new PlannerAgentToolError(
          "serves names no month or quarter goal: use a month or quarter goal's id from read_goals.",
        );
      }
    }
    const receipt = await receiptOf(context, input.quote, input.entry_id);
    const proposal = await plannerAgentAddProposal(context.db, {
      userId: context.user.id,
      runId,
      weekStart: input.week,
      kind: "goal",
      pillar: input.pillar,
      title: input.title,
      lines: input.lines ?? [],
      goalRef:
        input.serves ??
        (await cascadeGoalOf(context, input.pillar, input.week)),
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
    const runId = await proposingRun(context, ["review"]);
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
      runId,
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

  async propose_task_change(context, input) {
    const taskId = plannerNormalizeTaskId(input.task_id);
    const detail = await plannerReadTaskDetail(context.db, {
      userId: context.user.id,
      taskId,
    }).catch(() => {
      throw new PlannerAgentToolError(
        "No task has that id. Use an id from read_tasks.",
      );
    });
    const field = plannerAgentInputFields.find(
      (name) => input[name] !== undefined,
    );
    if (!field) {
      throw new PlannerAgentToolError("Propose exactly one field per call.");
    }
    if (
      field === "column" &&
      (input.before_id !== undefined || input.after_id !== undefined)
    ) {
      return proposePlace(context, input, taskId, detail);
    }
    let goalTitle: string | null = null;
    if (field === "goal_id" && input.goal_id) {
      const goalId = input.goal_id;
      await plannerRequireWeeklyGoal(context.db, context.user.id, goalId).catch(
        () => {
          throw new PlannerAgentToolError(
            "goal_id names no weekly goal: use a week goal's id from read_goals.",
          );
        },
      );
      const goal = await context.db
        .select({ title: plannerGoal.title })
        .from(plannerGoal)
        .where(
          and(
            eq(plannerGoal.userId, context.user.id),
            eq(plannerGoal.id, goalId),
          ),
        )
        .get();
      goalTitle = goal?.title ?? null;
    }
    const was = plannerAgentTaskFieldNow(detail, field);
    if (JSON.stringify(was ?? null) === JSON.stringify(input[field] ?? null)) {
      throw new PlannerAgentToolError(
        `The task's ${field} already holds that. Nothing was proposed.`,
      );
    }
    // An entry that shows why (it says the task is done): shown on the card.
    const source =
      input.from_entry_id && input.from_quote
        ? await entrySource(context, input.from_entry_id, input.from_quote)
        : null;
    const action = await fileAction(context, {
      kind: "task_change",
      taskId,
      field,
      change: {
        [field]: input[field],
        was,
        task_title: detail.task.title,
        ...(goalTitle ? { goal_title: goalTitle } : {}),
        ...(source ? { source } : {}),
      },
      why: input.why,
    });
    return `Proposed ${field} change ${action.id} for task ${taskId}. It shows in this answer's card; the owner accepts or dismisses it. Say in your answer that you proposed it, not that you changed it.`;
  },

  async propose_task_comment(context, input) {
    const taskId = plannerNormalizeTaskId(input.task_id);
    const detail = await plannerReadTaskDetail(context.db, {
      userId: context.user.id,
      taskId,
    }).catch(() => {
      throw new PlannerAgentToolError(
        "No task has that id. Use an id from read_tasks.",
      );
    });
    const action = await fileAction(context, {
      kind: "comment_new",
      taskId,
      field: null,
      change: { body: input.body, task_title: detail.task.title },
      why: input.why,
    });
    return `Proposed comment ${action.id} on task ${taskId}. It shows in this answer's card; the owner accepts or dismisses it.`;
  },

  async propose_entry_edit(context, input) {
    const memo = await proposedEntry(context, input.entry_id);
    // The quote must be this entry's own words, found word for word.
    const receipt = input.quote
      ? await receiptOf(context, input.quote, memo.id)
      : null;
    const action = await fileAction(context, {
      kind: "entry_edit",
      taskId: null,
      field: null,
      change: {
        entry_id: memo.id,
        flag: input.flag,
        ...(receipt ? { quote: receipt.quote } : {}),
        was: memo.content,
        preview: entryPreview(memo.content),
      },
      why: input.why,
    });
    return `Flagged entry ${memo.id} (${action.id}). The card shows the owner the entry with your flag; the owner rewrites it there, and nothing changes before they accept.`;
  },

  async propose_entry_tags(context, input) {
    const memo = await proposedEntry(context, input.entry_id);
    const retag = plannerEntryRetag(memo.content, {
      add: input.add ?? [],
      remove: input.remove ?? [],
    });
    if ("refused" in retag) throw new PlannerAgentToolError(retag.refused);
    const action = await fileAction(context, {
      kind: "entry_edit",
      taskId: null,
      field: null,
      change: {
        entry_id: memo.id,
        tags: { add: retag.added, remove: retag.removed },
        content: retag.content,
        was: memo.content,
        preview: entryPreview(memo.content),
      },
      why: input.why,
    });
    return `Proposed ${[
      retag.added.length
        ? `adding ${retag.added.map((t) => `#${t}`).join(" ")}`
        : "",
      retag.removed.length
        ? `removing ${retag.removed.map((t) => `#${t}`).join(" ")}`
        : "",
    ]
      .filter(Boolean)
      .join(
        " and ",
      )} on entry ${memo.id} (${action.id}). It shows in this answer's card; nothing changes before the owner accepts it.`;
  },

  async propose_entry_state(context, input) {
    const memo = await proposedEntry(context, input.entry_id);
    const change =
      input.archived !== undefined
        ? {
            entry_id: memo.id,
            archived: input.archived,
            was: memo.status === "archived",
            preview: entryPreview(memo.content),
          }
        : {
            entry_id: memo.id,
            pinned: input.pinned,
            was: memo.pinned,
            preview: entryPreview(memo.content),
          };
    if (change.was === (change.archived ?? change.pinned)) {
      throw new PlannerAgentToolError(
        "The entry is already like that. Nothing was proposed.",
      );
    }
    const action = await fileAction(context, {
      kind: "entry_state",
      taskId: null,
      field: null,
      change,
      why: input.why,
    });
    return `Proposed ${input.archived !== undefined ? (input.archived ? "archiving" : "bringing back") : input.pinned ? "pinning" : "unpinning"} entry ${memo.id} (${action.id}). It shows in this answer's card.`;
  },

  async propose_entry_link(context, input) {
    const memo = await proposedEntry(context, input.entry_id);
    const other = await proposedEntry(context, input.related_entry_id);
    if (memo.id === other.id) {
      throw new PlannerAgentToolError("An entry cannot link to itself.");
    }
    const was = await plannerEntryReferences(context.db, memo.id);
    const linked = was.includes(parseResourceName(other.id, "memos"));
    if (input.remove ? !linked : linked) {
      throw new PlannerAgentToolError(
        input.remove
          ? "The entries are not linked. Nothing was proposed."
          : "The entries are already linked. Nothing was proposed.",
      );
    }
    const action = await fileAction(context, {
      kind: "entry_link",
      taskId: null,
      field: null,
      change: {
        entry_id: memo.id,
        related_entry_id: other.id,
        ...(input.remove ? { remove: true } : {}),
        was,
        preview: entryPreview(memo.content),
        related_preview: entryPreview(other.content),
      },
      why: input.why,
    });
    return `Proposed ${input.remove ? "unlinking" : "linking"} entry ${memo.id} and entry ${other.id} (${action.id}). It shows in this answer's card; nothing changes before the owner accepts it.`;
  },

  async propose_health_change(context, input) {
    const variantsOf = (kind: string): readonly string[] | null =>
      kind === "training"
        ? healthTrainingVariants
        : kind === "breath"
          ? healthBreathVariants
          : kind === "wellness"
            ? healthWellnessVariants
            : null;
    const checkFields = (kind: string) => {
      const allowed = variantsOf(kind);
      if (input.variant !== undefined) {
        if (!allowed) {
          throw new PlannerAgentToolError("A night out has no variant.");
        }
        if (!allowed.includes(input.variant)) {
          throw new PlannerAgentToolError(
            `variant must be one of: ${allowed.join(", ")}.`,
          );
        }
      }
      if (input.minutes !== undefined && kind === "night_out") {
        throw new PlannerAgentToolError("A night out has no minutes.");
      }
      if (input.home_at !== undefined) {
        if (kind !== "night_out") {
          throw new PlannerAgentToolError("Only a night out has a home time.");
        }
        if (!healthNightUnitsFor(input.home_at)) {
          throw new PlannerAgentToolError("home_at must be HH:MM.");
        }
      }
    };
    if (input.action === "remove") {
      const row = await healthFindEntry(context.db, {
        userId: context.user.id,
        entryId: input.entry_id as string,
      });
      if (!row) {
        throw new PlannerAgentToolError(
          "No health row of the owner's has that id. Use an id from read_health.",
        );
      }
      if (!healthIsBuiltinKind(row.kind) || row.dismissed) {
        throw new PlannerAgentToolError(
          "That health row cannot be removed: it is already dismissed or belongs to a tracker.",
        );
      }
      const label = `${row.day} ${row.kind.replace("_", " ")}${row.variant ? ` ${row.variant}` : ""}`;
      const action = await fileAction(context, {
        kind: "health_change",
        taskId: null,
        field: null,
        change: {
          action: "remove",
          health_id: row.id,
          was: {
            day: row.day,
            kind: row.kind,
            variant: row.variant,
            minutes: row.minutes,
            home_at: row.homeAt,
          },
          label,
        },
        why: input.why,
      });
      return `Proposed removing health row ${row.id} (${label}) (${action.id}). It shows in this answer's card; nothing is removed before the owner accepts it. A removed row stays removed when the diary is re-read.`;
    }
    if (input.action === "fix") {
      const row = await healthFindEntry(context.db, {
        userId: context.user.id,
        entryId: input.entry_id as string,
      });
      if (!row) {
        throw new PlannerAgentToolError(
          "No health row of the owner's has that id. Use an id from read_health.",
        );
      }
      if (!healthIsBuiltinKind(row.kind) || row.dismissed) {
        throw new PlannerAgentToolError(
          "That health row cannot be fixed: it is dismissed or belongs to a tracker.",
        );
      }
      checkFields(row.kind);
      const now = {
        day: row.day,
        variant: row.variant,
        minutes: row.minutes,
        home_at: row.homeAt,
      };
      const patch: Partial<typeof now> = {};
      for (const field of ["day", "variant", "minutes", "home_at"] as const) {
        const value = input[field];
        if (value !== undefined && value !== now[field]) {
          (patch as Record<string, unknown>)[field] = value;
        }
      }
      const fields = Object.keys(patch) as Array<keyof typeof now>;
      if (fields.length === 0) {
        throw new PlannerAgentToolError(
          "The row already holds those values. Nothing was proposed.",
        );
      }
      const was = Object.fromEntries(
        fields.map((field) => [field, now[field]]),
      );
      const action = await fileAction(context, {
        kind: "health_change",
        taskId: null,
        field: null,
        change: {
          action: "fix",
          health_id: row.id,
          // The row's kind: the card's variant picker offers this kind's.
          row_kind: row.kind,
          ...patch,
          was,
          label: `${row.day} ${row.kind.replace("_", " ")}`,
        },
        why: input.why,
      });
      return `Proposed fixing health row ${row.id} (${action.id}). It shows in this answer's card; nothing changes before the owner accepts it.`;
    }
    const kind = input.kind as string;
    const day = input.day as string;
    if (!healthParseDay(day)) {
      throw new PlannerAgentToolError("day must be a real YYYY-MM-DD date.");
    }
    checkFields(kind);
    const same = await context.db
      .select({ id: healthEntry.id, variant: healthEntry.variant })
      .from(healthEntry)
      .where(
        and(
          eq(healthEntry.userId, context.user.id),
          eq(healthEntry.day, day),
          eq(healthEntry.kind, kind as "training"),
          isNull(healthEntry.deletedAt),
          eq(healthEntry.dismissed, false),
        ),
      )
      .all();
    if (same.some((row) => row.variant === (input.variant ?? null))) {
      throw new PlannerAgentToolError(
        `${day} already has that ${kind.replace("_", " ")} row. Nothing was proposed.`,
      );
    }
    const action = await fileAction(context, {
      kind: "health_change",
      taskId: null,
      field: null,
      change: {
        action: "add",
        day,
        kind,
        ...(input.variant !== undefined ? { variant: input.variant } : {}),
        ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
        ...(input.home_at !== undefined ? { home_at: input.home_at } : {}),
        label: `${day} ${kind.replace("_", " ")}`,
      },
      why: input.why,
    });
    return `Proposed adding a ${kind.replace("_", " ")} row on ${day} (${action.id}). It shows in this answer's card; nothing is added before the owner accepts it.`;
  },

  async propose_goal_change(context, input) {
    const today = toolToday(context);
    const current = plannerWeekStartOf(today);
    if (input.action === "add") {
      const week = input.period_start as string;
      if (week < current) {
        throw new PlannerAgentToolError(
          `period_start is in a past week (this week starts ${current}): a past week is closed. A weekly goal can be added to this week or a later one.`,
        );
      }
      if (week > plannerAddDays(current, 182)) {
        throw new PlannerAgentToolError(
          "period_start is too far ahead: a weekly goal is for this week or one within about six months ahead.",
        );
      }
      // No title yet: the owner writes it on the card, and the twin check runs
      // on Accept.
      const action = await fileAction(context, {
        kind: "goal_change",
        taskId: null,
        field: null,
        change: {
          action: "add",
          period_start: week,
          pillar: input.pillar,
          flag: input.flag,
          week,
          label: input.flag,
        },
        why: input.why,
      });
      return `Proposed a new weekly goal for the week of ${week} (${action.id}). The card asks the owner to write its title; nothing is added before they accept it.`;
    }
    const goalId = input.goal_id as string;
    try {
      await plannerRequireWeeklyGoal(context.db, context.user.id, goalId);
    } catch {
      throw new PlannerAgentToolError(
        "No weekly goal of the owner's has that id. Use the id of a week-level goal from read_goals.",
      );
    }
    const row = await plannerLoadLiveGoal(context.db, context.user.id, goalId);
    const goal = plannerGoalToDto(row);
    if (goal.period_start && goal.period_start < current) {
      throw new PlannerAgentToolError(
        `That goal is for the week of ${goal.period_start}, which is past (this week starts ${current}): a past week is closed and its goals are not rewritten here.`,
      );
    }
    const was = {
      title: goal.title,
      lines: goal.lines,
      note: goal.note,
      pillar: goal.pillar,
    };
    if (input.pillar !== undefined && input.pillar === goal.pillar) {
      throw new PlannerAgentToolError(
        "The goal is already under that objective. Leave pillar out to only flag it.",
      );
    }
    const action = await fileAction(context, {
      kind: "goal_change",
      taskId: null,
      field: null,
      change: {
        action: "edit",
        goal_id: goal.id,
        flag: input.flag,
        ...(input.pillar !== undefined ? { pillar: input.pillar } : {}),
        was,
        goal_title: goal.title || goal.lines[0]?.text || "Goal",
        week: goal.period_start,
        label: goal.title || goal.lines[0]?.text || "Goal",
      },
      why: input.why,
    });
    return `Flagged weekly goal ${goal.id} (${action.id}). The card shows the owner the goal with your flag; the owner rewrites it there, and nothing changes before they accept.`;
  },

  async propose_add_task(context, input) {
    const { why, from_entry_id: entryId, from_quote: quote, ...change } = input;
    let source: Record<string, string> | null = null;
    if (entryId && quote) {
      // A to-do from the diary: its words must be that entry's own, and one
      // the owner was offered before is not offered again.
      const found = await entrySource(context, entryId, quote);
      const before = (await offeredTodos(context)).get(
        plannerTodoSourceKey(found.entry_id, found.quote),
      );
      if (before) {
        throw new PlannerAgentToolError(
          `That to-do was offered before (${before}). Nothing was proposed.`,
        );
      }
      source = found;
    }
    const action = await fileAction(context, {
      kind: "task_new",
      taskId: null,
      field: null,
      change: source ? { ...change, source } : change,
      why,
    });
    return `Proposed new task ${action.id}${source ? ` from entry ${source.entry_id}` : ""}. It shows as a card; the owner accepts or dismisses it.`;
  },

  async propose_entry(context, input) {
    const action = await fileAction(context, {
      kind: "entry_new",
      taskId: null,
      field: null,
      change: input.link
        ? { content: input.content, link: input.link }
        : { content: input.content },
      why: input.why,
    });
    return `Proposed diary entry ${action.id}${input.link ? " (a link summary)" : ""}. It shows as a card; the owner accepts it to save it, or dismisses it.`;
  },
};
