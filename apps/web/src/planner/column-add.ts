import {
  type PlannerColumn,
  type PlannerPlanInput,
  plannerTodoMarker,
} from "@flaremo/contracts";

// What a column's "+" button creates (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 13 and 13.x): the column
// the task is created in, and the plan it gets. Without periods (v1.2) the only
// plan a new task can need is the To Do marker: a To Do task without one would
// read as Backlog. Backlog takes no plan, and Doing and Done keep none.

export type PlannerColumnAddTarget = {
  column: PlannerColumn;
  plan: PlannerPlanInput | null;
};

export function plannerColumnAddTarget(
  column: PlannerColumn,
  today: string,
): PlannerColumnAddTarget {
  return {
    column,
    plan: column === "todo" ? plannerTodoMarker(today) : null,
  };
}
