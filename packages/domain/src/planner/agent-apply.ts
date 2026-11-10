import {
  type CreateMemoInput,
  type PlannerAgentActionDto,
  type PlannerGoalLine,
  type PlannerPillar,
  plannerAgentActionFields,
  plannerAgentLinkSchema,
  plannerColumns,
  plannerEventRevertible,
  plannerLinkSummarySource,
  plannerLinkSummaryTag,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { memoRelations } from "@flaremo/db";
import {
  plannerTaskEvent,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import { and, desc, eq } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { healthSnapshot, healthToDto } from "../health/rows";
import {
  healthCreateEntry,
  healthDismissEntry,
  healthFindEntry,
  healthPatchEntry,
  healthRevertEntry,
} from "../health/write";
import { parseResourceName } from "../ids";
import {
  archiveMemory,
  type MemoryActor,
  restoreMemory,
  updateMemory,
} from "../memory";
import { normalizeMemoryContent, requireMemory } from "../memory/shared";
import { getMemoById } from "../memos-read";
import { createMemo, updateMemo } from "../memos-write";
import type { QuotaScope } from "../quotas";
import { replaceMemoRelations } from "../relations";
import {
  type PlannerAgentEditResult,
  plannerAgentApplyEdit,
} from "./agent-edit";
import {
  PLANNER_AGENT_ACTION_ACTOR_PREFIX,
  plannerAgentActionToDto,
  plannerAgentFindAction,
  plannerAgentLandAction,
  plannerAgentReopenAction,
  plannerAgentSettleAction,
} from "./agent-store";
import {
  plannerColumnStoredRanks,
  plannerRestoreBoardRank,
  plannerRestoreBoardRanks,
} from "./board-rank";
import { type PlannerColumn, plannerColumnFor } from "./columns";
import { plannerAddComment } from "./comments";
import { plannerRecordEvents } from "./flywheel";
import {
  plannerGoalSnapshot,
  plannerLatestGoalVersion,
  plannerProposalActor,
  plannerSameSnapshot,
} from "./goal-version";
import {
  type PlannerGoalPatch,
  plannerCreateGoal,
  plannerDeleteGoal,
  plannerGoalToDto,
  plannerLoadLiveGoal,
  plannerUpdateGoal,
} from "./goals";
import { plannerEventToDto } from "./history-read";
import { plannerRevertEvent } from "./history-revert";
import { plannerDropTask } from "./plans";
import type { PlannerActor } from "./shared";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import { type PlannerTaskDetail, plannerReadTaskDetail } from "./task-detail";

// Accepting an action the agent proposed (fork-owned add-on,
// docs/fork-general-agent.md, migration 9015). The accept is the write: a task
// change goes through plannerChangeTask, a new task through plannerAddTask,
// and a diary entry through upstream's createMemo, each as the app's own
// routes would do it. The actor is the proposal itself ("proposal:<id>"), so
// every History event the accept writes names the proposal, and from it the
// conversation, the session and the agent's reason. The field reads as the
// owner's afterwards; only the archive says where it came from.
//
// The action is marked accepted before the write, so two accepts of the same
// card (two tabs, a double click) make one write: only the first settles it.
// A write that then fails puts the action back to open.

/** The actor an accepted action writes as. */
export function plannerAgentActionActor(actionId: string): PlannerActor {
  return {
    type: "agent",
    name: `${PLANNER_AGENT_ACTION_ACTOR_PREFIX}${actionId}`,
  };
}

/** What the diary records as the source of an entry the agent drafted. */
export const PLANNER_AGENT_ENTRY_SOURCE = "agent-draft";

/** A link summary's text, with the #link tag added when the agent left it out. */
export function plannerLinkSummaryContent(content: string): string {
  const tag = `#${plannerLinkSummaryTag}`;
  const has = new RegExp(`(^|\\s)${tag}(?![\\w/-])`).test(content);
  return has ? content : `${content}\n\n${tag}`;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function column(value: unknown): PlannerColumn | undefined {
  return (plannerColumns as readonly unknown[]).includes(value)
    ? (value as PlannerColumn)
    : undefined;
}

function priority(value: unknown) {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
    ? value
    : undefined;
}

/** The message an accept gets when the record changed after the proposal. */
export const PLANNER_AGENT_STALE =
  "This changed since the agent proposed it. Dismiss it and ask the agent again.";

/**
 * What a task field holds now, in the form a proposal records it as `was`:
 * the card shows it as the value before, and the accept compares it, so a
 * field edited after the proposal is not overwritten unseen.
 */
export function plannerAgentTaskFieldNow(
  detail: Pick<PlannerTaskDetail, "task" | "plan">,
  field: PlannerAgentActionDto["field"],
): unknown {
  const { task, plan } = detail;
  switch (field) {
    case "title":
      return task.title;
    case "notes":
      return task.notes ?? null;
    case "priority":
      return task.priority;
    case "due_at":
      return task.due_at ?? null;
    case "effort":
      return plan?.effort ?? null;
    case "start_date":
      return plan?.start_date ?? null;
    case "goal_id":
      return plan?.goal_id ?? null;
    case "dropped":
      return Boolean(plan?.dropped_at);
    case "column":
      return plannerColumnFor({
        status: task.status,
        horizon: plan?.horizon ?? null,
        periodStart: plan?.period_start ?? null,
        droppedAt: plan?.dropped_at ?? null,
      });
    case "place":
      return {
        column: plannerAgentTaskFieldNow(detail, "column"),
        board_rank: plan?.board_rank ?? null,
      };
    default:
      return null;
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The entries `entryId` references now, sorted: what an entry link records as
 * `was`, and what its accept and undo compare. Comments are not references.
 */
export async function plannerEntryReferences(
  db: FlareMoDb,
  entryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ related: memoRelations.relatedMemoId })
    .from(memoRelations)
    .where(
      and(
        eq(memoRelations.memoId, parseResourceName(entryId, "memos")),
        eq(memoRelations.type, "reference"),
      ),
    )
    .all();
  return rows.map((row) => row.related).sort();
}

/** Sets an entry's whole set of references (comments are never touched). */
async function replaceReferences(
  db: FlareMoDb,
  user: UserRow,
  entryId: string,
  ids: string[],
) {
  await replaceMemoRelations(db, user, entryId, {
    relations: ids.map((related_memo) => ({
      related_memo,
      type: "reference" as const,
    })),
  });
}

/** The owner's own hand on the memory ledger, as memory-api.ts uses it. */
const USER_MEMORY_ACTOR: MemoryActor = { type: "user" };

/** The live memory a memory action names (any status but deleted), or a ValidationError. */
async function memoryOf(
  db: FlareMoDb,
  user: UserRow,
  change: Record<string, unknown>,
) {
  const id = asString(change.memory_id);
  if (!id) throw new ValidationError("This proposal names no memory.");
  const memory = await requireMemory(db, user, id).catch(() => null);
  if (!memory || memory.deletedAt || memory.status === "deleted") {
    throw new ValidationError("That memory is gone.");
  }
  return memory;
}

/** A refused memory write (a twin, a fact key taken) as a message on the card. */
async function memoryWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
}

/** The fields of a weekly goal an edit changes, and the card's `was` holds. */
const GOAL_EDIT_FIELDS = ["title", "lines", "note", "pillar"] as const;

/** A weekly goal's words as the proposal records them. */
function goalWords(goal: {
  title: string;
  lines: unknown;
  note: string | null;
  pillar: string | null;
}): Record<string, unknown> {
  return {
    title: goal.title,
    lines: goal.lines,
    note: goal.note ?? null,
    pillar: goal.pillar ?? null,
  };
}

/** The live goal a goal action names, or a ValidationError. */
async function goalOf(db: FlareMoDb, user: UserRow, goalId: string | null) {
  if (!goalId) throw new ValidationError("This proposal names no goal.");
  try {
    return await plannerLoadLiveGoal(db, user.id, goalId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ValidationError("That goal is gone.");
    }
    throw error;
  }
}

/** The diary entry an entry action names, or a ValidationError. */
async function entryOf(
  db: FlareMoDb,
  user: UserRow,
  change: Record<string, unknown>,
) {
  const id = asString(change.entry_id);
  if (!id) throw new ValidationError("This proposal names no entry.");
  const memo = await getMemoById(db, user, id).catch(() => null);
  if (!memo || (memo.status !== "normal" && memo.status !== "archived")) {
    throw new ValidationError("That diary entry is gone.");
  }
  return memo;
}

/**
 * Accepts one open action and writes it. Returns the settled action with
 * `landed_id` (the task or entry written). Throws NotFoundError for an action
 * that is not the owner's, ValidationError for one that is not open any more.
 */
export async function plannerAgentAcceptAction(
  db: FlareMoDb,
  input: {
    user: UserRow;
    id: string;
    today: string;
    /** The memo quota scope the request runs under, for a diary entry. */
    quota?: QuotaScope;
    /** The owner's own values for what the card lets them change (agent-edit.ts). */
    edit?: unknown;
    now?: Date;
  },
): Promise<PlannerAgentActionDto> {
  const { user } = input;
  const row = await plannerAgentFindAction(db, {
    userId: user.id,
    id: input.id,
  });
  if (!row) throw new NotFoundError("Proposal not found.");
  const claimed = await plannerAgentSettleAction(db, {
    userId: user.id,
    id: row.id,
    state: "accepted",
    now: input.now,
  });
  if (!claimed) throw new ValidationError("This proposal was already settled.");
  const actor = plannerAgentActionActor(row.id);
  let landedId: string;
  // What the field held before: kept on the action for a revert, since
  // upstream's activity log records only the new value of a title, notes,
  // priority or due date.
  let before: Record<string, unknown> | undefined;
  // The change to write: the proposal's, with the owner's edited values laid
  // over it. `was` stays the agent's, so the stale check is still against what
  // the record held when it proposed.
  let change: Record<string, unknown> = row.change;
  let edited: PlannerAgentEditResult | null = null;
  try {
    if (input.edit !== undefined) {
      edited = await plannerAgentApplyEdit(db, {
        userId: user.id,
        row,
        edit: input.edit,
        today: input.today,
      });
      if (edited) {
        change = {
          ...edited.change,
          proposed: edited.proposed,
          edited: edited.edited,
        };
      }
    }
    switch (row.kind) {
      case "task_change": {
        const field = plannerAgentActionFields.find(
          (name) => name === row.field,
        );
        if (!row.taskId || !field) {
          throw new ValidationError("This proposal names no task field.");
        }
        const value = change[field];
        const detail = await plannerReadTaskDetail(db, {
          userId: user.id,
          taskId: row.taskId,
        });
        const now = plannerAgentTaskFieldNow(detail, field);
        if ("was" in change && !same(change.was, now)) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        before =
          field === "place"
            ? (now as Record<string, unknown>)
            : { [field]: now };
        const spot = field === "place";
        // A place may re-spread the whole target column (the card above has no
        // key), so keep every card's rank from before, and what the accept wrote.
        const targetColumn = spot ? column(change.column) : undefined;
        const ranksBefore = targetColumn
          ? await plannerColumnStoredRanks(db, {
              userId: user.id,
              column: targetColumn,
              today: input.today,
            })
          : undefined;
        await plannerChangeTask(db, {
          user,
          actor,
          taskId: row.taskId,
          today: input.today,
          change: {
            title: field === "title" ? asString(value) : undefined,
            notes: field === "notes" ? asString(value) : undefined,
            priority: field === "priority" ? priority(value) : undefined,
            dueAt: field === "due_at" ? asString(value) : undefined,
            effort:
              field === "effort" && typeof value === "number"
                ? value
                : undefined,
            startDate: field === "start_date" ? asString(value) : undefined,
            column:
              field === "column"
                ? column(value)
                : spot
                  ? column(change.column)
                  : undefined,
            beforeId: spot ? asString(change.before_id) : undefined,
            afterId: spot ? asString(change.after_id) : undefined,
            goalId:
              field === "goal_id"
                ? value === null
                  ? null
                  : asString(value)
                : undefined,
            dropped:
              field === "dropped" && typeof value === "boolean"
                ? value
                : undefined,
          },
        });
        if (ranksBefore && targetColumn) {
          before = {
            ...before,
            column_ranks: ranksBefore,
            written_ranks: await plannerColumnStoredRanks(db, {
              userId: user.id,
              column: targetColumn,
              today: input.today,
            }),
          };
        }
        landedId = row.taskId;
        break;
      }
      case "task_new": {
        const title = asString(change.title)?.trim();
        if (!title) throw new ValidationError("This proposal has no title.");
        const target = column(change.column);
        const created = await plannerAddTask(db, {
          user,
          actor,
          title,
          notes: asString(change.notes),
          priority: priority(change.priority),
          dueAt: asString(change.due_at),
          goalId: asString(change.goal_id),
          column: target,
          // A card in To Do is always planned: one proposed there is planned
          // for today, as the panel does for a task dragged in.
          plan: target === "todo" ? { horizon: "day", day: input.today } : null,
          today: input.today,
        });
        landedId = created.task.id;
        break;
      }
      case "comment_new": {
        // A comment read from a file on the task (docs/fork-task-attachments.md).
        const body = asString(change.body)?.trim();
        if (!row.taskId || !body) {
          throw new ValidationError("This proposal has no text.");
        }
        const comment = await plannerAddComment(db, {
          user,
          actor,
          taskId: row.taskId,
          body,
        });
        landedId = comment.id;
        break;
      }
      case "entry_new": {
        const content = asString(change.content)?.trim();
        if (!content) throw new ValidationError("This proposal has no text.");
        // fork: link summaries. A summary made from a link is saved as one,
        // tagged #link, and points back at the owner's entry it came from.
        const link = plannerAgentLinkSchema.safeParse(change.link);
        const entry: CreateMemoInput = {
          content: link.success ? plannerLinkSummaryContent(content) : content,
          visibility: "private",
          source: link.success
            ? plannerLinkSummarySource
            : PLANNER_AGENT_ENTRY_SOURCE,
        };
        const memo = await createMemo(db, user, entry, input.quota);
        landedId = memo.id;
        if (link.success && link.data.from_entry_id) {
          await replaceMemoRelations(db, user, memo.id, {
            relations: [
              { related_memo: link.data.from_entry_id, type: "reference" },
            ],
          }).catch(() => undefined);
        }
        break;
      }
      case "entry_edit": {
        const content = asString(change.content)?.trim();
        if (!content) throw new ValidationError("This proposal has no text.");
        const memo = await entryOf(db, user, change);
        if ("was" in change && !same(change.was, memo.content)) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        before = { content: memo.content };
        await updateMemo(db, user, memo.id, { content });
        landedId = memo.id;
        break;
      }
      case "entry_state": {
        const memo = await entryOf(db, user, change);
        if (typeof change.archived === "boolean") {
          const was = memo.status === "archived";
          if ("was" in change && !same(change.was, was)) {
            throw new ValidationError(PLANNER_AGENT_STALE);
          }
          before = { archived: was };
          await updateMemo(db, user, memo.id, {
            status: change.archived ? "archived" : "normal",
          });
        } else if (typeof change.pinned === "boolean") {
          if ("was" in change && !same(change.was, memo.pinned)) {
            throw new ValidationError(PLANNER_AGENT_STALE);
          }
          before = { pinned: memo.pinned };
          await updateMemo(db, user, memo.id, { pinned: change.pinned });
        } else {
          throw new ValidationError("This proposal changes nothing.");
        }
        landedId = memo.id;
        break;
      }
      case "entry_link": {
        const memo = await entryOf(db, user, change);
        const related = asString(change.related_entry_id);
        if (!related)
          throw new ValidationError("This proposal names no entry.");
        const target = parseResourceName(related, "memos");
        const current = await plannerEntryReferences(db, memo.id);
        if ("was" in change && !same(change.was, current)) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        before = { references: current };
        const next =
          change.remove === true
            ? current.filter((id) => id !== target)
            : [...current.filter((id) => id !== target), target];
        await replaceReferences(db, user, memo.id, next);
        landedId = memo.id;
        break;
      }
      case "memory_change": {
        const memory = await memoryOf(db, user, change);
        const now = { content: memory.content, status: memory.status };
        if ("was" in change && !same(change.was, now)) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        if (memory.status !== "active") {
          throw new ValidationError(
            "That memory is not active any more, so it cannot be changed.",
          );
        }
        before = {
          ...now,
          verification: memory.verification,
          fact_key: memory.factKey,
          tier: memory.tier,
        };
        if (change.action === "forget") {
          await archiveMemory(db, user, USER_MEMORY_ACTOR, memory.id);
        } else {
          const content = asString(change.content);
          if (!content) throw new ValidationError("The new words are missing.");
          await memoryWrite(
            updateMemory(db, user, USER_MEMORY_ACTOR, memory.id, { content }),
          );
        }
        landedId = memory.id;
        break;
      }
      case "health_change": {
        if (change.action === "add") {
          const made = await healthCreateEntry(db, {
            userId: user.id,
            day: asString(change.day) ?? "",
            kind: asString(change.kind) ?? "",
            variant: asString(change.variant),
            minutes:
              typeof change.minutes === "number" ? change.minutes : undefined,
            homeAt: asString(change.home_at),
            now: input.now,
          });
          const created = await healthFindEntry(db, {
            userId: user.id,
            entryId: made.id,
          });
          before = {
            created: true,
            accepted: created ? JSON.parse(healthSnapshot(created)) : null,
          };
          landedId = made.id;
          break;
        }
        const entryId = asString(change.health_id);
        if (!entryId) throw new ValidationError("This proposal names no row.");
        const current = await healthFindEntry(db, {
          userId: user.id,
          entryId,
        });
        if (!current) throw new ValidationError("That health row is gone.");
        const was = (change.was ?? {}) as Record<string, unknown>;
        const dto = healthToDto(current) as unknown as Record<string, unknown>;
        if (Object.keys(was).some((key) => !same(was[key], dto[key]))) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        if (change.action === "remove") {
          if (current.dismissed) throw new ValidationError(PLANNER_AGENT_STALE);
          await healthDismissEntry(db, {
            userId: user.id,
            entryId,
            now: input.now,
          });
          const removed = await healthFindEntry(db, {
            userId: user.id,
            entryId,
          });
          before = {
            ...JSON.parse(healthSnapshot(current)),
            accepted: removed ? JSON.parse(healthSnapshot(removed)) : null,
          };
          landedId = entryId;
          break;
        }
        const patch: Record<string, unknown> = {};
        for (const key of ["day", "variant", "minutes", "home_at"]) {
          if (key in change) patch[key] = change[key];
        }
        await healthPatchEntry(db, {
          userId: user.id,
          entryId,
          patch,
          now: input.now,
        });
        const changed = await healthFindEntry(db, { userId: user.id, entryId });
        before = {
          ...JSON.parse(healthSnapshot(current)),
          accepted: changed ? JSON.parse(healthSnapshot(changed)) : null,
        };
        landedId = entryId;
        break;
      }
      case "goal_change": {
        const proposalActor = plannerProposalActor(row.id);
        if (change.action === "add") {
          const title = asString(change.title)?.trim();
          const week = asString(change.period_start);
          const pillar = asString(change.pillar) as PlannerPillar | undefined;
          if (!title || !week || !pillar) {
            throw new ValidationError("This proposal is missing its goal.");
          }
          const created = await plannerCreateGoal(db, {
            userId: user.id,
            actor: proposalActor,
            now: input.now,
            goal: {
              level: "week",
              periodStart: week,
              pillar,
              title,
              lines: Array.isArray(change.lines)
                ? (change.lines as PlannerGoalLine[])
                : [],
              note: asString(change.note) ?? null,
            },
          });
          before = { created: true, goal: goalWords(created) };
          landedId = created.id;
          break;
        }
        const goal = await goalOf(db, user, asString(change.goal_id) ?? null);
        if (goal.level !== "week") {
          throw new ValidationError("Only a weekly goal can be changed here.");
        }
        const now = goalWords({ ...goal, lines: plannerGoalToDto(goal).lines });
        if ("was" in change && !same(change.was, now)) {
          throw new ValidationError(PLANNER_AGENT_STALE);
        }
        const patch: PlannerGoalPatch = {};
        if (typeof change.title === "string") patch.title = change.title;
        if (Array.isArray(change.lines)) {
          patch.lines = change.lines as PlannerGoalLine[];
        }
        if (typeof change.note === "string") patch.note = change.note;
        if (typeof change.pillar === "string") {
          patch.pillar = change.pillar as PlannerPillar;
        }
        if (Object.keys(patch).length === 0) {
          throw new ValidationError("This proposal changes nothing.");
        }
        before = now;
        await plannerUpdateGoal(db, {
          userId: user.id,
          goalId: goal.id,
          actor: proposalActor,
          patch,
          now: input.now,
        });
        landedId = goal.id;
        break;
      }
      default:
        throw new ValidationError("Unknown proposal kind.");
    }
  } catch (error) {
    await plannerAgentReopenAction(db, { userId: user.id, id: row.id }).catch(
      () => {},
    );
    throw error;
  }
  await plannerAgentLandAction(db, {
    userId: user.id,
    id: row.id,
    landedId,
    before,
    change: edited ? change : undefined,
  });
  if (edited) {
    // The learning log: which fields the owner fixed, by name only.
    await plannerRecordEvents(
      db,
      [
        {
          userId: user.id,
          kind: "proposal.accepted_edited",
          subject: "proposal",
          subjectId: row.id,
          origin: "proposal",
          proposalId: row.id,
          data: {
            action_kind: row.kind,
            field: row.field,
            fields: Object.keys(edited.edited).join(","),
            count: Object.keys(edited.edited).length,
          },
        },
      ],
      input.now,
    );
  }
  const after = await plannerAgentFindAction(db, {
    userId: user.id,
    id: row.id,
  });
  if (!after) throw new NotFoundError("Proposal not found.");
  return plannerAgentActionToDto(after);
}

/**
 * Puts back what an accepted action wrote, as new changes: the record's own
 * history (task History, an entry's versions) keeps both the change and the
 * revert, and the action reads `reverted`.
 *
 * - a task change or a comment: each History line the accept wrote is
 *   reverted, newest first, as the History's own Revert does;
 * - a new task: dropped off the board (never deleted);
 * - a new entry: archived (never deleted);
 * - an entry edit or state: the entry gets back what it held before, unless
 *   it was changed again since, which the revert refuses.
 *
 * The caller syncs the task archive first, so the lines written through
 * upstream are there to revert.
 */
export async function plannerAgentRevertAction(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    id: string;
    today: string;
  },
): Promise<PlannerAgentActionDto> {
  const { user, actor } = input;
  const row = await plannerAgentFindAction(db, {
    userId: user.id,
    id: input.id,
  });
  if (!row) throw new NotFoundError("Proposal not found.");
  if (row.state !== "accepted") {
    throw new ValidationError("Only an accepted proposal can be put back.");
  }
  const settle = () =>
    plannerAgentSettleAction(db, {
      userId: user.id,
      id: row.id,
      state: "reverted",
    });
  switch (row.kind) {
    case "task_change":
    case "comment_new": {
      const taskId = row.taskId;
      if (!taskId) throw new ValidationError("This proposal names no task.");
      const lines = (
        await db
          .select()
          .from(plannerTaskEvent)
          .where(
            and(
              eq(plannerTaskEvent.userId, user.id),
              eq(plannerTaskEvent.taskId, taskId),
              eq(
                plannerTaskEvent.actorName,
                `${PLANNER_AGENT_ACTION_ACTOR_PREFIX}${row.id}`,
              ),
            ),
          )
          .orderBy(desc(plannerTaskEvent.id))
          .all()
      )
        .map(plannerEventToDto)
        .filter(plannerEventRevertible);
      // A "place" inside the column writes no event: only its rank.
      if (lines.length === 0 && row.field !== "place") {
        throw new ValidationError(
          "There is nothing in the task's History to put back.",
        );
      }
      for (const line of lines) {
        await plannerRevertEvent(db, {
          user,
          actor,
          taskId,
          eventId: line.id,
          today: input.today,
        });
      }
      if (row.field === "place") {
        const was = row.before ?? {};
        const oldColumn = column(was.column);
        if (!oldColumn)
          throw new ValidationError("Its old place was not kept.");
        await plannerRestoreBoardRank(db, {
          user,
          taskId,
          column: oldColumn,
          boardRank: asString(was.board_rank) ?? null,
        });
        // The accept may have re-spread the target column: put every card's
        // rank back (only cards still there holding what the accept wrote).
        const ranks = was.column_ranks;
        const written = was.written_ranks;
        const target = column(row.change.column);
        if (target && ranks && typeof ranks === "object") {
          await plannerRestoreBoardRanks(db, {
            user,
            column: target,
            ranks: ranks as Record<string, string | null>,
            written: (written ?? {}) as Record<string, string | null>,
          });
        }
      }
      // plannerRevertEvent settles the action on its first line.
      await settle();
      break;
    }
    case "task_new": {
      if (!row.landedId) throw new ValidationError("No task was made.");
      await plannerDropTask(db, { user, actor, taskId: row.landedId });
      await settle();
      break;
    }
    case "entry_new": {
      if (!row.landedId) throw new ValidationError("No entry was saved.");
      await updateMemo(db, user, row.landedId, { status: "archived" });
      await settle();
      break;
    }
    case "entry_edit":
    case "entry_state": {
      const memo = await entryOf(db, user, row.change);
      const was = row.before ?? {};
      if (row.kind === "entry_edit") {
        const content = asString(was.content);
        if (!content) throw new ValidationError("The old text was not kept.");
        if (!same(memo.content, asString(row.change.content)?.trim())) {
          throw new ValidationError(
            "The entry was edited again since, so this cannot be put back.",
          );
        }
        await updateMemo(db, user, memo.id, { content });
      } else if (typeof was.archived === "boolean") {
        await updateMemo(db, user, memo.id, {
          status: was.archived ? "archived" : "normal",
        });
      } else if (typeof was.pinned === "boolean") {
        await updateMemo(db, user, memo.id, { pinned: was.pinned });
      } else {
        throw new ValidationError("What it held before was not kept.");
      }
      await settle();
      break;
    }
    case "entry_link": {
      const memo = await entryOf(db, user, row.change);
      const related = asString(row.change.related_entry_id);
      if (!related) throw new ValidationError("This proposal names no entry.");
      const target = parseResourceName(related, "memos");
      const current = await plannerEntryReferences(db, memo.id);
      const has = current.includes(target);
      const removed = row.change.remove === true;
      // Only the one link the accept wrote is touched; the rest stay as they are.
      if (removed ? has : !has) {
        throw new ValidationError(
          "The links of this entry changed since, so this cannot be put back.",
        );
      }
      await replaceReferences(
        db,
        user,
        memo.id,
        removed ? [...current, target] : current.filter((id) => id !== target),
      );
      await settle();
      break;
    }
    case "memory_change": {
      const memory = await memoryOf(db, user, row.change);
      const was = row.before ?? {};
      if (row.change.action === "forget") {
        if (memory.status !== "archived") {
          throw new ValidationError(
            "The memory is not archived any more, so this cannot be put back.",
          );
        }
        await memoryWrite(
          restoreMemory(db, user, USER_MEMORY_ACTOR, memory.id),
        );
      } else {
        const content = asString(was.content);
        if (!content) throw new ValidationError("The old words were not kept.");
        const accepted = normalizeMemoryContent(
          asString(row.change.content) ?? "",
        );
        if (memory.status !== "active" || memory.content !== accepted) {
          throw new ValidationError(
            "The memory changed since, so this cannot be put back.",
          );
        }
        // Puts the words back; updateMemory reads the owner's hand as a
        // confirmation, so the old confidence level does not come back.
        await memoryWrite(
          updateMemory(db, user, USER_MEMORY_ACTOR, memory.id, { content }),
        );
      }
      await settle();
      break;
    }
    case "health_change": {
      if (!row.landedId)
        throw new ValidationError("No health row was written.");
      const { accepted, created, ...snapshot } = row.before ?? {};
      if (!accepted || typeof accepted !== "object") {
        throw new ValidationError("What the row held was not kept.");
      }
      await healthRevertEntry(db, {
        userId: user.id,
        entryId: row.landedId,
        before: created === true ? null : snapshot,
        accepted: accepted as Record<string, unknown>,
      });
      await settle();
      break;
    }
    case "goal_change": {
      const proposalActor = plannerProposalActor(row.id);
      const goalId = row.landedId;
      if (!goalId) throw new ValidationError("No goal was written.");
      const goal = await goalOf(db, user, goalId);
      // Untouched since the accept: the goal's last write is the one the accept
      // made, and the goal still says what that write left.
      const last = await plannerLatestGoalVersion(db, {
        userId: user.id,
        goalId,
      });
      const untouched =
        last !== null &&
        last.actor === proposalActor &&
        plannerSameSnapshot(last.afterJson, plannerGoalSnapshot(goal));
      if (!untouched) {
        throw new ValidationError(
          "The goal changed since, so this cannot be put back.",
        );
      }
      const was = row.before ?? {};
      if (row.change.action === "add") {
        const linked = await db
          .select({ taskId: plannerTaskPlan.taskId })
          .from(plannerTaskPlan)
          .where(
            and(
              eq(plannerTaskPlan.userId, user.id),
              eq(plannerTaskPlan.goalId, goalId),
            ),
          )
          .limit(1)
          .get();
        if (linked) {
          throw new ValidationError(
            "Tasks were linked to this goal since, so it cannot be removed.",
          );
        }
        await plannerDeleteGoal(db, {
          userId: user.id,
          goalId,
          actor: proposalActor,
        });
      } else {
        const patch: PlannerGoalPatch = {};
        for (const field of GOAL_EDIT_FIELDS) {
          if (!(field in was)) {
            throw new ValidationError("The old words were not kept.");
          }
        }
        patch.title = asString(was.title) ?? "";
        patch.lines = Array.isArray(was.lines)
          ? (was.lines as PlannerGoalLine[])
          : [];
        patch.note = asString(was.note) ?? null;
        patch.pillar = (asString(was.pillar) ?? null) as PlannerPillar | null;
        await plannerUpdateGoal(db, {
          userId: user.id,
          goalId,
          actor: proposalActor,
          patch,
          restore: true,
        });
      }
      await settle();
      break;
    }
    default:
      throw new ValidationError("This proposal cannot be put back.");
  }
  const after = await plannerAgentFindAction(db, {
    userId: user.id,
    id: row.id,
  });
  if (!after) throw new NotFoundError("Proposal not found.");
  return plannerAgentActionToDto(after);
}
