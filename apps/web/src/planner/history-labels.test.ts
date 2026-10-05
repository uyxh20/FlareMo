import type { PlannerEventDto } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import { plannerDescribeHistory } from "./history-labels";
import { plannerStringsFor } from "./strings";

const en = plannerStringsFor("en-US");
const zh = plannerStringsFor("zh-CN");

let nextId = 0;

/** Local time on 7 October 2026, so the day an event "happened" is the same in any zone. */
const at = (seconds: number, day = 7, hour = 9) =>
  new Date(2026, 9, day, hour, 0, seconds).toISOString();

function event(
  type: string,
  data: Record<string, unknown>,
  options: {
    at?: string;
    source?: PlannerEventDto["source"];
    actor?: PlannerEventDto["actor_type"];
    name?: string | null;
    id?: number;
  } = {},
): PlannerEventDto {
  nextId += 1;
  const id = options.id ?? nextId;
  return {
    id,
    task_id: "tasks/t",
    task_title: "A task",
    type,
    data,
    source:
      options.source ??
      ([
        "planned",
        "replanned",
        "unplanned",
        "carried_over",
        "dropped",
        "undropped",
      ].includes(type)
        ? "planner"
        : "activity"),
    actor_type: options.actor === undefined ? "user" : options.actor,
    actor_name: options.name ?? null,
    occurred_at: options.at ?? at(id),
    created_at: options.at ?? at(id),
  };
}

const point = (
  horizon: "day" | "week" | "month" | null,
  start: string | null,
) => ({
  horizon,
  period_start: start,
});
const NONE = point(null, null);

const labels = (events: PlannerEventDto[], strings = en) =>
  plannerDescribeHistory(events, strings).map((entry) => entry.label);

describe("plannerDescribeHistory", () => {
  it("tells a whole life in order, newest first", () => {
    const events = [
      event("created", { status: "todo", title: "Launch" }),
      event("planned", { from: NONE, to: point("week", "2026-10-05") }),
      event("replanned", {
        from: point("week", "2026-10-05"),
        to: point("day", "2026-10-08"),
      }),
      event("replanned", {
        from: point("day", "2026-10-08"),
        to: point("day", "2026-10-07"),
      }),
      event("updated", { priority: "high", due_at: "2026-10-09" }),
      event("status_changed", { status: "in_progress", completed_at: null }),
      event("status_changed", { status: "done", completed_at: at(30) }),
      event("status_changed", { status: "todo", completed_at: null }),
    ];
    expect(labels(events)).toEqual([
      "Reopened",
      "Completed",
      "Moved to Doing",
      "Edited",
      "Re-planned to today",
      "Re-planned to tomorrow",
      "Planned for this week",
      "Created",
    ]);
  });

  it("reads events in time order whatever order they arrive in", () => {
    const events = [
      event("created", { status: "todo" }, { at: at(1) }),
      event(
        "planned",
        { from: NONE, to: point("day", "2026-10-07") },
        { at: at(2) },
      ),
      event("status_changed", { status: "done" }, { at: at(3) }),
    ];
    const shuffled = [events[2], events[0], events[1]];
    expect(labels(shuffled)).toEqual([
      "Completed",
      "Planned for today",
      "Created",
    ]);
  });

  it("breaks a tie in time by the archive id", () => {
    const same = at(5);
    const events = [
      event("status_changed", { status: "done" }, { at: same, id: 902 }),
      event("created", { status: "todo" }, { at: same, id: 901 }),
    ];
    expect(labels(events)).toEqual(["Completed", "Created"]);
  });

  it("words each plan against the day it was made, so old events keep their meaning", () => {
    const events = [
      event(
        "planned",
        { from: NONE, to: point("week", "2026-09-28") },
        { at: at(1, 1) },
      ),
      event(
        "replanned",
        { from: point("week", "2026-09-28"), to: point("day", "2026-10-04") },
        { at: at(2, 1) },
      ),
    ];
    // Both happened on 1 October, in the week of 28 September.
    expect(labels(events)).toEqual([
      "Re-planned to Sun 4",
      "Planned for this week",
    ]);
  });

  it("keeps the old plan as a quiet second line", () => {
    const entries = plannerDescribeHistory(
      [
        event("planned", { from: NONE, to: point("week", "2026-10-05") }),
        event("replanned", {
          from: point("week", "2026-10-05"),
          to: point("day", "2026-10-08"),
        }),
        event("unplanned", { from: point("day", "2026-10-08"), to: NONE }),
      ],
      en,
    );
    expect(entries.map((entry) => [entry.label, entry.detail])).toEqual([
      ["Unplanned", "Was tomorrow"],
      ["Re-planned to tomorrow", "Was this week"],
      ["Planned for this week", null],
    ]);
  });

  it("calls a carry-over what it is", () => {
    const [entry] = plannerDescribeHistory(
      [
        event("carried_over", {
          from: point("day", "2026-10-06"),
          to: point("day", "2026-10-07"),
        }),
      ],
      en,
    );
    expect(entry).toMatchObject({
      label: "Carried over to today",
      detail: "Was yesterday",
      type: "carried_over",
    });
  });

  it("names a month plan by its month", () => {
    expect(
      labels([
        event("planned", { from: NONE, to: point("month", "2026-11-01") }),
      ]),
    ).toEqual(["Planned for Nov"]);
  });

  it("tells a move back to todo from the plan the task had", () => {
    const events = [
      event("created", { status: "todo" }),
      event("status_changed", { status: "in_progress" }),
      // No plan yet: it goes back to Backlog.
      event("status_changed", { status: "todo" }),
      event("planned", { from: NONE, to: point("week", "2026-10-05") }),
      event("status_changed", { status: "in_progress" }),
      // Planned: it goes back to To Do.
      event("status_changed", { status: "todo" }),
      event("unplanned", { from: point("week", "2026-10-05"), to: NONE }),
      event("status_changed", { status: "in_progress" }),
      event("status_changed", { status: "todo" }),
    ];
    expect(labels(events)).toEqual([
      "Moved to Backlog",
      "Moved to Doing",
      "Unplanned",
      "Moved to To Do",
      "Moved to Doing",
      "Planned for this week",
      "Moved to Backlog",
      "Moved to Doing",
      "Created",
    ]);
  });

  it("calls a change away from done a reopening, and says where it went", () => {
    const entries = plannerDescribeHistory(
      [
        event("created", { status: "todo" }),
        event("status_changed", { status: "done" }),
        event("status_changed", { status: "in_progress" }),
        event("status_changed", { status: "done" }),
        event("status_changed", { status: "todo" }),
      ],
      en,
    );
    expect(entries.map((entry) => [entry.label, entry.detail])).toEqual([
      ["Reopened", null],
      ["Completed", null],
      ["Reopened", "Now in Doing"],
      ["Completed", null],
      ["Created", null],
    ]);
  });

  it("does not guess a reopening when the history starts after the task was done", () => {
    // No created event (purged or imported): the first change is just a move.
    expect(
      labels([event("status_changed", { status: "in_progress" })]),
    ).toEqual(["Moved to Doing"]);
  });

  it("starts from the status a task was created with", () => {
    expect(
      labels([
        event("created", { status: "done" }),
        event("status_changed", { status: "todo" }),
      ]),
    ).toEqual(["Reopened", "Created"]);
  });

  it("shows a drop with the due date it cleared, and folds in the clearing it caused", () => {
    const events = [
      event("dropped", { previous_due_at: "2026-10-09" }, { at: at(10) }),
      // Upstream's updateTask logs this right after the drop.
      event("updated", { due_at: null }, { at: at(10) }),
    ];
    const entries = plannerDescribeHistory(events, en);
    expect(entries.map((entry) => [entry.label, entry.detail])).toEqual([
      ["Dropped (due date cleared)", "Was due Oct 9"],
    ]);
  });

  it("keeps a later due-date change after a drop as its own edit", () => {
    const events = [
      event("dropped", { previous_due_at: "2026-10-09" }, { at: at(10) }),
      event("updated", { due_at: null }, { at: at(10 + 60) }),
    ];
    expect(labels(events)).toEqual(["Edited", "Dropped (due date cleared)"]);
  });

  it("does not fold an edit into a drop that had no due date to clear", () => {
    const events = [
      event("dropped", { previous_due_at: null }, { at: at(10) }),
      event("updated", { due_at: null }, { at: at(11) }),
    ];
    expect(labels(events)).toEqual(["Edited", "Dropped"]);
  });

  it("words an undrop, and the system events a sync detects", () => {
    expect(
      labels([
        event("deleted", {}, { source: "sync", actor: null }),
        event("restored", { detected: true }, { source: "sync", actor: null }),
        event("purged", {}, { source: "sync", actor: null }),
        event("undropped", {}),
      ]),
    ).toEqual(["Undropped", "Purged", "Restored", "Deleted"]);
  });

  it("describes what an edit changed", () => {
    const detail = (data: Record<string, unknown>) =>
      plannerDescribeHistory([event("updated", data)], en)[0]?.detail;
    expect(detail({ title: "New name" })).toBe("Renamed to “New name”");
    expect(detail({ due_at: "2026-10-17" })).toBe("Due Oct 17");
    expect(detail({ due_at: null })).toBe("Due date cleared");
    expect(detail({ priority: "high" })).toBe("Priority high");
    expect(detail({ project_id: "projects/p" })).toBe("Project changed");
    expect(detail({ project_id: null })).toBe("Removed from its project");
    expect(detail({ notes: "x" })).toBe("Notes edited");
    expect(detail({ title: "Renamed", due_at: "2026-10-17" })).toBe(
      "Renamed to “Renamed” · Due Oct 17",
    );
  });

  it("labels an edit with only unremarkable changes as plain Edited", () => {
    const [entry] = plannerDescribeHistory(
      [event("updated", { sort_order: 4 })],
      en,
    );
    expect(entry).toMatchObject({ label: "Edited", detail: null });
  });

  it("carries a status change's other edits as its detail", () => {
    const [entry] = plannerDescribeHistory(
      [
        event("created", { status: "todo" }),
        event("status_changed", {
          status: "in_progress",
          completed_at: null,
          priority: "high",
        }),
      ],
      en,
    );
    expect(entry).toMatchObject({
      label: "Moved to Doing",
      detail: "Priority high",
    });
  });

  it("says who did it", () => {
    const actor = (options: Parameters<typeof event>[2]) =>
      plannerDescribeHistory(
        [event("created", { status: "todo" }, options)],
        en,
      )[0]?.actor;
    expect(actor({ actor: "user" })).toBe("You");
    expect(actor({ actor: "agent" })).toBe("Agent");
    expect(actor({ actor: "agent", name: "pat:abcd1234" })).toBe(
      "Agent · pat:abcd1234",
    );
    expect(actor({ actor: null })).toBeNull();
  });

  it("keeps the time and the archive id on each line", () => {
    const [entry] = plannerDescribeHistory(
      [event("created", { status: "todo" }, { id: 42, at: at(7) })],
      en,
    );
    expect(entry).toMatchObject({ id: 42, occurredAt: at(7), type: "created" });
  });

  it("never throws on an event it does not know or data it cannot read", () => {
    expect(
      labels([
        event("some_new_event", {}),
        event("planned", { from: "nope", to: 7 }),
        event("status_changed", {}),
      ]),
    ).toEqual(["Status changed to ?", "Planned for ?", "Some new event"]);
  });

  it("reads the same history in Chinese", () => {
    const events = [
      event("created", { status: "todo" }),
      event("planned", { from: NONE, to: point("week", "2026-10-05") }),
      event("status_changed", { status: "in_progress" }),
      event("status_changed", { status: "done" }),
      event("carried_over", {
        from: point("day", "2026-10-06"),
        to: point("day", "2026-10-07"),
      }),
      event("dropped", { previous_due_at: "2026-10-09" }),
    ];
    expect(labels(events, zh)).toEqual([
      "放弃（已清除截止日期）",
      "顺延到今天",
      "完成",
      "移到进行中",
      "安排到本周",
      "创建",
    ]);
    expect(plannerDescribeHistory(events.slice(0, 1), zh)[0]?.actor).toBe("你");
  });
});
