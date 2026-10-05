import {
  type PlannerHorizon,
  type PlannerPlanInput,
  plannerNextPeriodStart,
  plannerPeriodStart,
} from "@flaremo/contracts";
import type { PlannerPlanPoint } from "./dates";

// The plans the cockpit offers, as the `{horizon, day}` the API takes (fork-owned
// add-on, docs/planning-cockpit-implementation-plan.md, sections 4 and 5). Every
// target is computed from the local `today` with the shared period helpers, so
// "next week" means the same Monday here as on the server.

/** The named choices of the Plan menu, in menu order. "Pick a day" and "Clear" are separate. */
export const plannerPlanOptionKeys = [
  "today",
  "tomorrow",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "nextMonth",
] as const;

export type PlannerPlanOptionKey = (typeof plannerPlanOptionKeys)[number];

/** The plan a named choice stands for, counted from the local day `today`. */
export function plannerPlanTarget(
  option: PlannerPlanOptionKey,
  today: string,
): PlannerPlanInput {
  switch (option) {
    case "today":
      return { horizon: "day", day: today };
    case "tomorrow":
      return { horizon: "day", day: plannerNextPeriodStart("day", today) };
    case "thisWeek":
      return { horizon: "week", day: plannerPeriodStart("week", today) };
    case "nextWeek":
      return {
        horizon: "week",
        day: plannerNextPeriodStart("week", plannerPeriodStart("week", today)),
      };
    case "thisMonth":
      return { horizon: "month", day: plannerPeriodStart("month", today) };
    case "nextMonth":
      return {
        horizon: "month",
        day: plannerNextPeriodStart(
          "month",
          plannerPeriodStart("month", today),
        ),
      };
  }
}

/** "Pick a day…": a plan for exactly that day. */
export function plannerPlanForDay(day: string): PlannerPlanInput {
  return { horizon: "day", day };
}

/**
 * Which named choice a task's current plan is, or null for a plan none of them
 * names (a day further out, a month beyond next) and for no plan. The menu marks
 * it as the current one.
 */
export function plannerPlanOptionOf(
  plan: PlannerPlanPoint,
  today: string,
): PlannerPlanOptionKey | null {
  if (plan.horizon === null || plan.period_start === null) return null;
  for (const key of plannerPlanOptionKeys) {
    const target = plannerPlanTarget(key, today);
    if (
      target.horizon === plan.horizon &&
      plannerPeriodStart(target.horizon, target.day) === plan.period_start
    ) {
      return key;
    }
  }
  return null;
}

/** Quick add's plan choice: the backlog, or a day, week or month. */
export type PlannerQuickAddChoice = "backlog" | PlannerHorizon;

export const plannerQuickAddChoices: readonly PlannerQuickAddChoice[] = [
  "backlog",
  "day",
  "week",
  "month",
];

/** The plan a quick-add choice makes, counted from `today`; null for the backlog. */
export function plannerQuickAddPlan(
  choice: PlannerQuickAddChoice,
  today: string,
): PlannerPlanInput | null {
  if (choice === "backlog") return null;
  return { horizon: choice, day: plannerPeriodStart(choice, today) };
}
