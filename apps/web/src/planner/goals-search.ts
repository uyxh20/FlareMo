// The searches of the Goals page and the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md). Like cockpit-search.ts they live here,
// not in router-tree.tsx, so the lines that hook them into the router are all this
// feature adds to that upstream file. No imports: the router loads this module
// with the app's first chunk.
//
//   /goals                           the current ISO year
//   /goals?year=2026                 a year: north star, weeks, year goals
//   /goals?year=2026&q=4             a quarter: its months and quarter goals
//   /goals?year=2026&q=4&m=10        a month (1 to 12) inside its quarter
//   /goals?week=2026-10-05           one week, by its Monday
//
//   /weekly-review                   wherever the review stands
//   /weekly-review?part=back         Look back
//   /weekly-review?part=forward&step=2

export type PlannerGoalsSearch = {
  year?: number;
  q?: number;
  m?: number;
  week?: string;
};

export type PlannerReviewSearch = {
  part?: "back" | "forward";
  step?: number;
};

const whole = (value: unknown, min: number, max: number) => {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : undefined;
};

/**
 * The Goals page's place. A month must sit inside its quarter and a week must be
 * a Monday written `YYYY-MM-DD`; anything else is dropped, so a bad address shows
 * the level above it instead of an error. Every key is always returned, even as
 * undefined: the router lays each route's search over the raw query, so a key
 * left out would let an unchecked value (`?week=40`) through.
 */
export function plannerGoalsSearch(
  search: Record<string, unknown>,
): PlannerGoalsSearch {
  const week =
    typeof search.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.week)
      ? search.week
      : undefined;
  if (week) {
    const date = new Date(`${week}T00:00:00Z`);
    if (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === week &&
      date.getUTCDay() === 1
    ) {
      return { year: undefined, q: undefined, m: undefined, week };
    }
  }
  const year = whole(search.year, 1970, 9999);
  const q = whole(search.q, 1, 4);
  const m = whole(search.m, 1, 12);
  return {
    year,
    q,
    m:
      q !== undefined && m !== undefined && Math.ceil(m / 3) === q
        ? m
        : undefined,
    week: undefined,
  };
}

/** The review's part and Look forward's step (1 to 4). */
export function plannerReviewSearch(
  search: Record<string, unknown>,
): PlannerReviewSearch {
  const part =
    search.part === "back" || search.part === "forward"
      ? search.part
      : undefined;
  return {
    part,
    step: part === "forward" ? whole(search.step, 1, 4) : undefined,
  };
}
