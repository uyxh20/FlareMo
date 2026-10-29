import {
  type CreateMemoInput,
  type PlannerAgentActionDto,
  plannerAgentActionFields,
  plannerColumns,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { NotFoundError, ValidationError } from "../errors";
import { createMemo } from "../memos-write";
import type { QuotaScope } from "../quotas";
import {
  PLANNER_AGENT_ACTION_ACTOR_PREFIX,
  plannerAgentActionToDto,
  plannerAgentFindAction,
  plannerAgentLandAction,
  plannerAgentReopenAction,
  plannerAgentSettleAction,
} from "./agent-store";
import type { PlannerColumn } from "./columns";
import type { PlannerActor } from "./shared";
import { plannerAddTask, plannerChangeTask } from "./task-change";
import { plannerReadTaskDetail } from "./task-detail";

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
  try {
    switch (row.kind) {
      case "task_change": {
        const field = plannerAgentActionFields.find(
          (name) => name === row.field,
        );
        if (!row.taskId || !field) {
          throw new ValidationError("This proposal names no task field.");
        }
        const value = row.change[field];
        if (
          field === "title" ||
          field === "notes" ||
          field === "priority" ||
          field === "due_at"
        ) {
          const { task } = await plannerReadTaskDetail(db, {
            userId: user.id,
            taskId: row.taskId,
          });
          before = { [field]: task[field] };
        }
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
            column: field === "column" ? column(value) : undefined,
          },
        });
        landedId = row.taskId;
        break;
      }
      case "task_new": {
        const title = asString(row.change.title)?.trim();
        if (!title) throw new ValidationError("This proposal has no title.");
        const target = column(row.change.column);
        const created = await plannerAddTask(db, {
          user,
          actor,
          title,
          notes: asString(row.change.notes),
          priority: priority(row.change.priority),
          dueAt: asString(row.change.due_at),
          column: target,
          // A card in To Do is always planned: one proposed there is planned
          // for today, as the panel does for a task dragged in.
          plan: target === "todo" ? { horizon: "day", day: input.today } : null,
          today: input.today,
        });
        landedId = created.task.id;
        break;
      }
      case "entry_new": {
        const content = asString(row.change.content)?.trim();
        if (!content) throw new ValidationError("This proposal has no text.");
        const entry: CreateMemoInput = {
          content,
          visibility: "private",
          source: PLANNER_AGENT_ENTRY_SOURCE,
        };
        const memo = await createMemo(db, user, entry, input.quota);
        landedId = memo.id;
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
  });
  const after = await plannerAgentFindAction(db, {
    userId: user.id,
    id: row.id,
  });
  if (!after) throw new NotFoundError("Proposal not found.");
  return plannerAgentActionToDto(after);
}
