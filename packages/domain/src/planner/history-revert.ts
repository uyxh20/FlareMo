import {
  type PlannerEventDto,
  type PlannerHorizon,
  plannerEventRevertible,
  plannerPeriodStart,
  plannerRevertibleEditKeys,
  type UpdateTaskInput,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { plannerTaskEvent } from "@flaremo/db/src/schema/planner";
import { and, eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import { updateTask } from "../tasks";
import {
  plannerAgentActionOfActor,
  plannerAgentFindAction,
  plannerAgentSettleAction,
} from "./agent-store";
import { plannerDeleteComment } from "./comments";
import { plannerSetTaskGoal } from "./goals";
import { plannerEventToDto, plannerReadTaskHistory } from "./history-read";
import {
  type PlannerTaskPlanResult,
  plannerDropTask,
  plannerReadTaskPlan,
  plannerSetEffort,
  plannerSetPlan,
  plannerSetStartDate,
  plannerUndropTask,
} from "./plans";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// Reverting one History event (fork-owned add-on,
// docs/fork-general-agent.md, "Revert"). The owner picks a line in a task's
// History and the inverse change is applied as a new change, through the same
// setters the panel uses, so it lands in the archive like any edit: the
// archive is never rewritten (its rows only grow). A `reverted` event follows
// it, naming the event put back, so the archive also says that it was a
// revert and not a fresh edit.
//
// What "the inverse" is comes from the archive itself. Planner events carry
// `from`; a status change's previous status is the latest earlier `created` or
// `status_changed`; an upstream edit's previous value is the latest earlier
// event that set that field (upstream logs only the new values), or, for an
// accepted proposal, what the proposal recorded before its write. A value the
// archive never held cannot be put back, and the revert says so. A comment is
// deleted. `plannerEventRevertible` in the contracts says which events
// qualify, and the timeline shows Revert on those.

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type PlanPoint = { horizon: PlannerHorizon | null; periodStart: string | null };

function planPoint(value: unknown): PlanPoint {
  if (!isRecord(value)) return { horizon: null, periodStart: null };
  const horizon = value.horizon;
  const start = asString(value.period_start);
  return (horizon === "day" || horizon === "week" || horizon === "month") &&
    start !== null
    ? { horizon, periodStart: start }
    : { horizon: null, periodStart: null };
}

/** Events of the task before `event`, newest first. */
function before(
  events: readonly PlannerEventDto[],
  event: PlannerEventDto,
): PlannerEventDto[] {
  return events.filter(
    (other) =>
      other.occurred_at < event.occurred_at ||
      (other.occurred_at === event.occurred_at && other.id < event.id),
  );
}

/** The value a field had before `event`: what the latest earlier event set it to. */
function previousValue(
  earlier: readonly PlannerEventDto[],
  key: string,
): { known: boolean; value: unknown } {
  for (const event of earlier) {
    if (
      (event.type === "updated" ||
        event.type === "created" ||
        event.type === "status_changed") &&
      key in event.data
    ) {
      return { known: true, value: event.data[key] };
    }
  }
  return { known: false, value: null };
}

/**
 * Reverts one of a task's archived events and returns the task as it is
 * afterwards, with the event reverted. A 404 for an event that is not this
 * task's or the caller's, a 400 for one that cannot be reverted.
 */
export async function plannerRevertEvent(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    eventId: number;
    today: string;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult & { reverted: PlannerEventDto }> {
  const { user, actor } = input;
  const today = plannerRequireDay(input.today, "today");
  const taskId = plannerNormalizeTaskId(input.taskId);
  const row = await db
    .select()
    .from(plannerTaskEvent)
    .where(
      and(
        eq(plannerTaskEvent.userId, user.id),
        eq(plannerTaskEvent.taskId, taskId),
        eq(plannerTaskEvent.id, input.eventId),
      ),
    )
    .get();
  if (!row) throw new NotFoundError("History event not found.");
  const event = plannerEventToDto(row);
  if (!plannerEventRevertible(event)) {
    throw new ValidationError("This change cannot be reverted.");
  }
  const task = await plannerLoadLiveTask(db, user.id, taskId);
  const earlier = before(
    await plannerReadTaskHistory(db, { userId: user.id, taskId, limit: 2000 }),
    event,
  );
  const { data } = event;
  // An agent-drafted change: its proposal kept what the field held before.
  const actionId = plannerAgentActionOfActor(event.actor_name);
  const action = actionId
    ? await plannerAgentFindAction(db, { userId: user.id, id: actionId })
    : null;
  const recorded = action?.before ?? null;
  const previous = (key: string) =>
    recorded && key in recorded
      ? { known: true, value: recorded[key] }
      : previousValue(earlier, key);

  switch (event.type) {
    case "effort_changed":
      await plannerSetEffort(db, {
        user,
        actor,
        taskId,
        effort: asNumber(data.from),
      });
      break;
    case "start_date_changed":
      await plannerSetStartDate(db, {
        user,
        actor,
        taskId,
        startDate: asString(data.from),
      });
      break;
    case "goal_changed":
      await plannerSetTaskGoal(db, {
        user,
        actor,
        taskId,
        goalId: asString(data.from),
      });
      break;
    case "planned":
    case "replanned":
    case "unplanned": {
      const from = planPoint(data.from);
      // A period that has passed cannot be planned for again: the same
      // horizon from today is the nearest thing to it.
      const day =
        from.horizon && from.periodStart
          ? from.periodStart < plannerPeriodStart(from.horizon, today)
            ? today
            : from.periodStart
          : null;
      await plannerSetPlan(db, {
        user,
        actor,
        taskId,
        plan: from.horizon && day ? { horizon: from.horizon, day } : null,
        today,
      });
      break;
    }
    case "dropped":
      await plannerUndropTask(db, { user, actor, taskId });
      break;
    case "undropped":
      await plannerDropTask(db, { user, actor, taskId });
      break;
    case "status_changed": {
      const was = asString(previous("status").value);
      const status =
        was === "todo" || was === "in_progress" || was === "done"
          ? was
          : "todo";
      await updateTask(db, user, actor, taskId, { status });
      break;
    }
    case "updated": {
      const fields: UpdateTaskInput = {};
      for (const key of plannerRevertibleEditKeys) {
        if (!(key in data)) continue;
        const was = previous(key);
        if (!was.known) {
          throw new ValidationError(
            "What this field held before is not in the archive, so this change cannot be reverted.",
          );
        }
        switch (key) {
          case "title":
            fields.title = asString(was.value) ?? task.title;
            break;
          case "notes":
            fields.notes = asString(was.value);
            break;
          case "priority": {
            const priority = asString(was.value);
            fields.priority =
              priority === "low" || priority === "medium" || priority === "high"
                ? priority
                : "none";
            break;
          }
          case "due_at":
            fields.due_at = asString(was.value);
            break;
          case "project_id":
            fields.project_id = asString(was.value);
            break;
        }
      }
      if (Object.keys(fields).length === 0) {
        throw new ValidationError("This change cannot be reverted.");
      }
      await updateTask(db, user, actor, taskId, fields);
      break;
    }
    case "commented": {
      const commentId = asString(data.comment_id);
      if (!commentId) throw new ValidationError("This comment is gone.");
      await plannerDeleteComment(db, { user, actor, commentId });
      break;
    }
    default:
      throw new ValidationError("This change cannot be reverted.");
  }

  const nowIso = plannerNow(input.now).toISOString();
  await plannerRunBatch(db, [
    plannerEventStatement(db, {
      userId: user.id,
      taskId,
      taskTitle: task.title,
      type: "reverted",
      data: { event_id: event.id, type: event.type },
      actor,
      occurredAt: nowIso,
    }),
  ]);
  // An agent-drafted change that is put back: its proposal reads as reverted.
  if (actionId) {
    await plannerAgentSettleAction(db, {
      userId: user.id,
      id: actionId,
      state: "reverted",
    });
  }
  return {
    ...(await plannerReadTaskPlan(db, { user, taskId })),
    reverted: event,
  };
}
