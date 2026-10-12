// Query keys for the planning cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5). Everything lives
// under ["planner", ...], so one prefix invalidates the whole cockpit.

export const plannerQueryKeys = {
  /** The prefix: invalidating it refreshes every cockpit query. */
  all: ["planner"] as const,
  /** Every cached board, whatever its day or filters, for optimistic patches. */
  boards: ["planner", "board"] as const,
  board: (today: string, includeDropped: boolean) =>
    ["planner", "board", today, includeDropped] as const,
  /** One task's archived timeline. */
  history: (taskId: string) => ["planner", "history", taskId] as const,
  /** The full upstream task (with notes), for the edit dialog. */
  task: (taskId: string) => ["planner", "task", taskId] as const,
  /** One task as the panel shows it: task, plan, goal path and comments. */
  detail: (taskId: string) => ["planner", "detail", taskId] as const,
  /** The goal tree, for the goal picker's paths. */
  tree: ["planner", "tree"] as const,
  /** Every cached Goals page year (docs/planning-cockpit-goals-review.md). */
  goals: ["planner", "goals"] as const,
  goalsYear: (year: number, today: string) =>
    ["planner", "goals", year, today] as const,
  /** The weekly review as the page reads it, for the day it is opened on. */
  review: (today: string) => ["planner", "review", today] as const,
  /** Whether a review is due, for the sidebar's dot. */
  reviewStatus: (today: string) => ["planner", "review-status", today] as const,
} as const;
