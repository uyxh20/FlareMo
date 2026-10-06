// The cockpit route's search (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): `/cockpit?task=<id>`
// names the task whose panel is open, so the panel can be linked to and the back
// button closes it (see use-task-param.ts). It lives here, not in router-tree.tsx,
// so the one line that hooks it into the router is all this feature adds to that
// upstream file. No imports: the router loads it with the app's first chunk.

/** The search the cockpit route understands; anything else in the address is dropped. */
export type PlannerCockpitSearch = { task?: string };

/**
 * `task` as a string, or absent. A number is accepted because the router parses
 * `?task=123` into one; a task id is never a number, so it simply will not match
 * a task and the panel says the task is not there.
 */
export function plannerCockpitSearch(
  search: Record<string, unknown>,
): PlannerCockpitSearch {
  return {
    task:
      typeof search.task === "string" || typeof search.task === "number"
        ? String(search.task)
        : undefined,
  };
}
