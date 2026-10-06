import type { PlannerColumn, PlannerPlanInput } from "@flaremo/contracts";
import { plannerQuickAddPlan } from "./plan-targets";
import type { PlannerHorizonFilter } from "./todo-filter";

// What a column's "+" button creates (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): the column the task
// is created in, and the plan it gets. The plan follows the To Do filter chip,
// because a person adding a task while looking at "This week" means this week.
//
//   Backlog   never a plan: the backlog is where unplanned tasks wait
//   To Do     a plan is required, so the chip decides: Today, This week or This
//             month; with All there is no period to follow, so Today
//   Doing     the chip's period when a chip is on (Today, This week, This month),
//   Done      and no plan under All, because "planned for" has no answer then
//
// Doing and Done keep a plan only as history, so a missing one is never a
// problem; To Do without one would read as Backlog, which is why it never lacks.
// The periods come from `plannerQuickAddPlan`, so "this week" is the same Monday
// as on the server.

export type PlannerColumnAddTarget = {
  column: PlannerColumn;
  plan: PlannerPlanInput | null;
};

export function plannerColumnAddTarget(
  column: PlannerColumn,
  filter: PlannerHorizonFilter,
  today: string,
): PlannerColumnAddTarget {
  switch (column) {
    case "backlog":
      return { column, plan: null };
    case "todo":
      return {
        column,
        plan: plannerQuickAddPlan(filter === "all" ? "day" : filter, today),
      };
    case "doing":
    case "done":
      return {
        column,
        plan: filter === "all" ? null : plannerQuickAddPlan(filter, today),
      };
  }
}
