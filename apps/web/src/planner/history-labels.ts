import type { PlannerEventDto } from "@flaremo/contracts";
import {
  type PlannerPlanPoint,
  plannerDueLabel,
  plannerLocalDayOf,
  plannerPlanLabel,
} from "./dates";
import type { PlannerStrings } from "./strings";

// Turns the archive's raw events into the lines of a task's timeline (fork-owned
// add-on, docs/planning-cockpit-implementation-plan.md, sections 4 and 5):
// "Created", "Planned for this week", "Re-planned to Wed 8", "Moved to Doing",
// "Completed", "Reopened", "Carried over to today", "Dropped (due date cleared)".
//
// The archive stores upstream's own words (`status_changed` with the new status)
// next to the planner's (`planned`, `carried_over`). Two things a reader wants are
// not in any one event, so the events are read oldest first with a little state:
// what the status was before (a change away from done is "Reopened", not "Moved
// to To Do") and whether the task had a plan (a move back to `todo` lands in To Do
// with a plan and in Backlog without).

export type PlannerHistoryEntry = {
  id: number;
  /** The archive's event type, e.g. `status_changed`. */
  type: string;
  label: string;
  /** A second, quieter line, or null. */
  detail: string | null;
  /**
   * "You" or "Agent" (with the agent's name when it has one), "Automatic" for a
   * carry-over, and null when the archive names nobody.
   */
  actor: string | null;
  /** When it happened, an ISO instant. */
  occurredAt: string;
};

/** How soon after a drop the system's own due-date clearing counts as part of it. */
const DROP_CLEARING_WINDOW_MS = 10_000;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{horizon, period_start}` as the plan events store it; anything else is "no plan". */
function readPlanPoint(value: unknown): PlannerPlanPoint {
  if (!isRecord(value)) return { horizon: null, period_start: null };
  const horizon = value.horizon;
  const start = asString(value.period_start);
  return (horizon === "day" || horizon === "week" || horizon === "month") &&
    start !== null
    ? { horizon, period_start: start }
    : { horizon: null, period_start: null };
}

function humanize(type: string): string {
  const spaced = type.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function actorLabel(
  event: PlannerEventDto,
  strings: PlannerStrings,
): string | null {
  // A carry-over is stored with the actor of the request that ran the rollover
  // (whoever opened the cockpit), but nobody chose it: the rollover moved the
  // plan on its own. Crediting it to "You" would claim an edit the person never
  // made, so it reads "Automatic" whatever the stored actor is.
  if (event.type === "carried_over") return strings.history.automatic;
  if (event.actor_type === "user") return strings.history.you;
  if (event.actor_type === "agent") {
    return event.actor_name
      ? strings.history.agentNamed(event.actor_name)
      : strings.history.agent;
  }
  return null;
}

/**
 * What an upstream edit changed, as short phrases: a new title, a due date set or
 * cleared, a priority, a project, notes. Keys that are not worth a line (sort
 * order, the source memo, a status change's own fields) are left out.
 */
function describeChanges(
  data: Record<string, unknown>,
  today: string,
  strings: PlannerStrings,
): string | null {
  const parts: string[] = [];
  const title = asString(data.title);
  if (title !== null) parts.push(strings.history.detail.renamed(title));
  if ("due_at" in data) {
    const due = asString(data.due_at);
    parts.push(
      due === null
        ? strings.history.detail.dueCleared
        : strings.history.detail.due(plannerDueLabel(due, today, strings)),
    );
  }
  const priority = asString(data.priority);
  if (priority !== null) {
    const label = (strings.priority as Record<string, string>)[priority];
    parts.push(strings.history.detail.priority(label ?? priority));
  }
  if ("project_id" in data) {
    parts.push(
      data.project_id === null
        ? strings.history.detail.projectCleared
        : strings.history.detail.project,
    );
  }
  if ("notes" in data) parts.push(strings.history.detail.notes);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The changes of a status change other than the status itself and `completed_at`. */
function otherChanges(data: Record<string, unknown>) {
  const { status: _status, completed_at: _completedAt, ...rest } = data;
  return rest;
}

/**
 * The timeline for one task, newest first. The input may come in any order: it is
 * sorted by time (then archive id) before it is read. An event whose only effect
 * was clearing the due date right after a drop is folded into the drop's own line.
 */
export function plannerDescribeHistory(
  events: readonly PlannerEventDto[],
  strings: PlannerStrings,
): PlannerHistoryEntry[] {
  const chronological = [...events].sort((left, right) =>
    left.occurred_at < right.occurred_at
      ? -1
      : left.occurred_at > right.occurred_at
        ? 1
        : left.id - right.id,
  );

  let status: string | null = null;
  let hasPlan = false;
  let lastDrop: { at: number; hadDueDate: boolean } | null = null;
  const entries: PlannerHistoryEntry[] = [];

  for (const event of chronological) {
    const { data } = event;
    const at = Date.parse(event.occurred_at);
    // A plan is worded against the day it was made, so "this week" keeps meaning
    // the week it was planned in.
    const day = plannerLocalDayOf(event.occurred_at);
    const wording = (point: PlannerPlanPoint) =>
      plannerPlanLabel(point, day, strings, "phrase")?.label ?? null;
    let label: string;
    let detail: string | null = null;

    switch (event.type) {
      case "created":
        status = asString(data.status) ?? "todo";
        label = strings.history.created;
        break;

      case "updated": {
        const onlyDueCleared =
          Object.keys(data).length === 1 &&
          "due_at" in data &&
          data.due_at === null;
        if (
          onlyDueCleared &&
          lastDrop?.hadDueDate &&
          at - lastDrop.at <= DROP_CLEARING_WINDOW_MS
        ) {
          continue;
        }
        label = strings.history.edited;
        detail = describeChanges(data, day, strings);
        break;
      }

      case "status_changed": {
        const next = asString(data.status);
        const previous = status;
        if (next === "done") {
          label = strings.history.completed;
        } else if (previous === "done" && next !== null) {
          label = strings.history.reopened;
          if (next === "in_progress") {
            detail = strings.history.detail.nowIn(strings.column.doing);
          }
        } else if (next === "in_progress") {
          label = strings.history.movedTo(strings.column.doing);
        } else if (next === "todo") {
          label = strings.history.movedTo(
            hasPlan ? strings.column.todo : strings.column.backlog,
          );
        } else {
          label = strings.history.statusChanged(next ?? "?");
        }
        if (next !== null) status = next;
        detail = detail ?? describeChanges(otherChanges(data), day, strings);
        break;
      }

      case "planned":
      case "replanned":
      case "carried_over":
      case "unplanned": {
        const from = readPlanPoint(data.from);
        const to = readPlanPoint(data.to);
        const target = wording(to);
        if (event.type === "planned") {
          label = strings.history.planned(target ?? "?");
        } else if (event.type === "replanned") {
          label = strings.history.replanned(target ?? "?");
        } else if (event.type === "carried_over") {
          label = strings.history.carriedOver(target ?? "?");
        } else {
          label = strings.history.unplanned;
        }
        // The label is worded against the day of the event ("this week"); the
        // exact period under it keeps an old line from being misread.
        const exact = plannerPlanLabel(to, day, strings, "phrase")?.title;
        const was = wording(from);
        const parts = [
          exact ?? null,
          event.type !== "planned" && was !== null
            ? strings.history.detail.was(was)
            : null,
        ].filter((part): part is string => part !== null);
        detail = parts.length > 0 ? parts.join(" · ") : null;
        hasPlan = to.horizon !== null;
        break;
      }

      case "dropped": {
        const previousDue = asString(data.previous_due_at);
        label =
          previousDue === null
            ? strings.history.dropped
            : strings.history.droppedClearedDue;
        if (previousDue !== null) {
          detail = strings.history.detail.wasDue(
            plannerDueLabel(previousDue, day, strings),
          );
        }
        lastDrop = { at, hadDueDate: previousDue !== null };
        break;
      }

      case "undropped":
        label = strings.history.undropped;
        break;
      case "deleted":
        label = strings.history.deleted;
        break;
      case "restored":
        label = strings.history.restored;
        break;
      case "purged":
        label = strings.history.purged;
        break;

      default:
        label = strings.history.unknown(humanize(event.type));
    }

    entries.push({
      id: event.id,
      type: event.type,
      label,
      detail,
      actor: actorLabel(event, strings),
      occurredAt: event.occurred_at,
    });
  }

  return entries.reverse();
}
