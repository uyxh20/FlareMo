// The cockpit's columns, by status like the Notion board it replaces
// (docs/planning-cockpit-implementation-plan.md, sections 0 and 4):
//
//   Backlog  status `todo` with no plan (no row, or a NULL horizon)
//   To Do    status `todo` with a plan
//   Doing    status `in_progress`
//   Done     status `done`
//
// Two more buckets sit beside them: `dropped` (a plan with `dropped_at` set,
// whatever the status, and it wins over the status) and `other` (any status
// upstream's enum does not list). Board grouping and column moves read the same
// rule, so they cannot disagree.

/** The four columns a card can be moved to. */
export const plannerColumns = ["backlog", "todo", "doing", "done"] as const;

export type PlannerColumn = (typeof plannerColumns)[number];

/** A column, or one of the two buckets that are not move targets. */
export type PlannerBoardColumnKey = PlannerColumn | "other" | "dropped";

export function plannerIsColumn(value: unknown): value is PlannerColumn {
  return (
    typeof value === "string" &&
    (plannerColumns as readonly string[]).includes(value)
  );
}

/**
 * Whether a plan row counts as a plan. A row with a NULL horizon is the
 * backlog, exactly like no row; a horizon without a period start is damaged
 * and counts the same way.
 */
export function plannerHasPlan(
  plan:
    | { horizon: string | null; periodStart: string | null }
    | null
    | undefined,
): boolean {
  return plan?.horizon != null && plan.periodStart != null;
}

/** Which column or bucket a task is in, from its status and plan. */
export function plannerColumnFor(input: {
  status: string;
  horizon: string | null;
  periodStart: string | null;
  droppedAt: string | null;
}): PlannerBoardColumnKey {
  if (input.droppedAt !== null) return "dropped";
  switch (input.status) {
    case "todo":
      return plannerHasPlan(input) ? "todo" : "backlog";
    case "in_progress":
      return "doing";
    case "done":
      return "done";
    default:
      return "other";
  }
}
