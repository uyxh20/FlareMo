import {
  type PlannerBoardColumnKey,
  plannerCardColumn,
  plannerHasPlan as plannerCardHasPlan,
  plannerColumns,
  plannerIsColumn,
} from "@flaremo/contracts";

// The cockpit's columns (docs/planning-cockpit-implementation-plan.md, sections 0
// and 4). The rule itself lives in @flaremo/contracts (planner-board.ts), shared
// with the web board; these are its readers for plan rows, whose fields are
// camelCase.

export { type PlannerBoardColumnKey, plannerColumns, plannerIsColumn };

export type PlannerColumn = (typeof plannerColumns)[number];

/** Whether a plan row counts as a plan (see `plannerHasPlan` in the contracts). */
export function plannerHasPlan(
  plan:
    | { horizon: string | null; periodStart: string | null }
    | null
    | undefined,
): boolean {
  return plannerCardHasPlan({
    horizon: plan?.horizon ?? null,
    period_start: plan?.periodStart ?? null,
  });
}

/** Which column or bucket a task is in, from its status and plan. */
export function plannerColumnFor(input: {
  status: string;
  horizon: string | null;
  periodStart: string | null;
  droppedAt: string | null;
}): PlannerBoardColumnKey {
  return plannerCardColumn({
    status: input.status,
    horizon: input.horizon,
    period_start: input.periodStart,
    dropped_at: input.droppedAt,
  });
}
