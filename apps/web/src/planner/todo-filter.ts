import {
  type PlannerBoardCard,
  type PlannerHorizon,
  plannerNextPeriodStart,
  plannerPeriodStart,
} from "@flaremo/contracts";

// The To Do filter chips (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5), as plain data.
//
// The chips ask "what is planned for the current day, week or month?", not "which
// plans were made at this level":
//
//   Today       day plans dated today
//   This week   day plans dated Monday to Sunday of the current week, and this
//               week's week plan
//   This month  day plans dated in the current month, week plans that start in it,
//               and this month's plan
//   All         everything
//
// One rule gives all three: a plan counts for a chip when it is at that chip's
// level or finer (a day plan can sit in a week, a week plan cannot sit in a day)
// and its period *starts* inside the chip's current period. Plans for later
// periods (Tomorrow once the week has turned, Next week, Next month) therefore
// show under All and under the chips their dates fall in, and nowhere else.
//
// A week plan belongs to the month its Monday is in. So when a week spans two
// months (Mon 26 Oct to Sun 1 Nov), its week plan shows under This week on every
// day of it, and under This month while the month is October; on Sunday 1 Nov the
// month is November and the plan is under This week only. Likewise This week
// shows a day plan dated 1 Nov while the month is October, and This month does
// not.
//
// The counts on the chips use the same matchers as the filter, so a chip never
// promises a different number of cards than it shows. `today` is the page's own
// local day, a valid `YYYY-MM-DD` key; the maths is the shared period helpers',
// so it uses UTC dates and Monday weeks everywhere.

/** The To Do filter: everything, or what is planned in the current day, week or month. */
export type PlannerHorizonFilter = "all" | PlannerHorizon;

export const plannerHorizonFilters: readonly PlannerHorizonFilter[] = [
  "all",
  "day",
  "week",
  "month",
];

type PlanFields = Pick<PlannerBoardCard, "horizon" | "period_start">;

/** How coarse a plan is: a day sits inside a week, a week inside a month. */
const LEVEL: Readonly<Record<string, number | undefined>> = {
  day: 0,
  week: 1,
  month: 2,
};

/**
 * The days a chip covers: `from` is the first day of the current day, week or
 * month, and `to` the first day after it (so a day `d` is inside when
 * `from <= d < to`). The week runs Monday to Sunday.
 */
export function plannerFilterPeriod(
  filter: PlannerHorizon,
  today: string,
): { from: string; to: string } {
  return {
    from: plannerPeriodStart(filter, today),
    to: plannerNextPeriodStart(filter, today),
  };
}

/** The test for one chip, with its period worked out once. */
function matcher(
  filter: PlannerHorizonFilter,
  today: string,
): (plan: PlanFields) => boolean {
  if (filter === "all") return () => true;
  const { from, to } = plannerFilterPeriod(filter, today);
  const level = LEVEL[filter] ?? 0;
  return ({ horizon, period_start: start }) => {
    // No plan, or a horizon this build does not know, is in no period.
    if (horizon === null || start === null) return false;
    const rank = LEVEL[horizon];
    return rank !== undefined && rank <= level && start >= from && start < to;
  };
}

/** Whether a plan is inside the current period of a chip. Every plan is inside All. */
export function plannerPlanInFilter(
  plan: PlanFields,
  filter: PlannerHorizonFilter,
  today: string,
): boolean {
  return matcher(filter, today)(plan);
}

/**
 * To Do narrowed by a chip, in the order it was given. The other columns are
 * never filtered. Always a new array.
 */
export function plannerFilterTodo<T extends PlanFields>(
  cards: readonly T[],
  filter: PlannerHorizonFilter,
  today: string,
): T[] {
  return cards.filter(matcher(filter, today));
}

/** How many To Do cards each chip shows, by the same rule as `plannerFilterTodo`. */
export function plannerTodoCounts(
  cards: readonly PlanFields[],
  today: string,
): Record<PlannerHorizonFilter, number> {
  const inDay = matcher("day", today);
  const inWeek = matcher("week", today);
  const inMonth = matcher("month", today);
  const counts: Record<PlannerHorizonFilter, number> = {
    all: cards.length,
    day: 0,
    week: 0,
    month: 0,
  };
  for (const card of cards) {
    if (inDay(card)) counts.day += 1;
    if (inWeek(card)) counts.week += 1;
    if (inMonth(card)) counts.month += 1;
  }
  return counts;
}
