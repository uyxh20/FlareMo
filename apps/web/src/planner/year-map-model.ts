import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerGoalDto,
  type PlannerGoalLevel,
  type PlannerGoalsYearResponse,
  type PlannerPillar,
  type PlannerWeekDto,
  plannerPillars,
} from "@flaremo/contracts";
import {
  plannerGoalsOf,
  plannerLiveCards,
  plannerMonthStart,
  plannerQuarterMonths,
  plannerQuarterStart,
  plannerWeekNumber,
  plannerWeeksByMonday,
  plannerYearMonths,
} from "./goals-model";

// The Year map on the Goals page (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the whole year on one page, the four
// objectives as columns and time running down, north star -> year -> quarter ->
// month -> week. Goals of different levels have no parent link in the data; a
// row of the map lines them up by objective and period, which is all that ties
// a weekly goal to its month and quarter. Plain functions over the server's
// answers, so the layout can be tested without rendering.

/** A quarter or month goal holds five points at most: the map's progress bar. */
export const PLANNER_MAP_POINTS = 5;

/** A period's goals, split by objective; `loose` holds the ones with none. */
export type PlannerMapGoals = {
  byPillar: Record<PlannerPillar, PlannerGoalDto[]>;
  loose: PlannerGoalDto[];
};

/** How a week reads on the map. `none`: over, and no weekly goal was set. */
export type PlannerMapWeekKind = "past" | "none" | "now" | "future";

export type PlannerMapWeek = {
  monday: string;
  number: number;
  kind: PlannerMapWeekKind;
  record: PlannerWeekDto | undefined;
  goals: PlannerMapGoals;
};

export type PlannerMapMonth = {
  month: number;
  start: string;
  current: boolean;
  goals: PlannerMapGoals;
  weeks: PlannerMapWeek[];
};

export type PlannerMapQuarter = {
  quarter: number;
  start: string;
  /** The quarter's theme line: its first goal with no objective. */
  theme: PlannerGoalDto | null;
  goals: PlannerMapGoals;
  months: PlannerMapMonth[];
};

export type PlannerYearMapData = {
  year: number;
  start: string;
  northStar: PlannerGoalDto | null;
  /** The year's theme line, like a quarter's. */
  theme: PlannerGoalDto | null;
  goals: PlannerMapGoals;
  quarters: PlannerMapQuarter[];
};

function emptyByPillar(): Record<PlannerPillar, PlannerGoalDto[]> {
  return Object.fromEntries(
    plannerPillars.map((pillar) => [pillar, [] as PlannerGoalDto[]]),
  ) as Record<PlannerPillar, PlannerGoalDto[]>;
}

/** One period's goals by objective, in display order. */
export function plannerMapGoals(
  goals: readonly PlannerGoalDto[],
  level: PlannerGoalLevel,
  periodStart: string,
): PlannerMapGoals {
  const byPillar = emptyByPillar();
  const loose: PlannerGoalDto[] = [];
  for (const goal of plannerGoalsOf(goals, level, periodStart)) {
    if (goal.pillar) byPillar[goal.pillar].push(goal);
    else loose.push(goal);
  }
  return { byPillar, loose };
}

/** Whether a period has no goal at all. */
export function plannerMapIsEmpty(goals: PlannerMapGoals): boolean {
  return (
    goals.loose.length === 0 &&
    plannerPillars.every((pillar) => goals.byPillar[pillar].length === 0)
  );
}

/** A year or quarter: the first loose goal becomes its theme line. */
function withTheme(goals: PlannerMapGoals): {
  theme: PlannerGoalDto | null;
  goals: PlannerMapGoals;
} {
  const [theme = null, ...rest] = goals.loose;
  return { theme, goals: { byPillar: goals.byPillar, loose: rest } };
}

export function plannerMapWeekKind(
  monday: string,
  currentWeek: string,
  goals: PlannerMapGoals,
): PlannerMapWeekKind {
  if (monday === currentWeek) return "now";
  if (monday > currentWeek) return "future";
  return plannerMapIsEmpty(goals) ? "none" : "past";
}

/** The whole map of an ISO year. */
export function plannerYearMap(
  data: Pick<
    PlannerGoalsYearResponse,
    "north_star" | "goals" | "weeks" | "current_week"
  >,
  year: number,
): PlannerYearMapData {
  const records = plannerWeeksByMonday(data.weeks);
  const yearMonths = plannerYearMonths(year);
  const start = plannerMonthStart(year, 0);
  const currentMonth = yearMonths.findIndex((mondays) =>
    mondays.includes(data.current_week),
  );
  const quarters = [1, 2, 3, 4].map((quarter): PlannerMapQuarter => {
    const quarterStart = plannerQuarterStart(year, quarter);
    return {
      quarter,
      start: quarterStart,
      ...withTheme(plannerMapGoals(data.goals, "quarter", quarterStart)),
      months: plannerQuarterMonths(quarter).map((month) => ({
        month,
        start: plannerMonthStart(year, month),
        current: month === currentMonth,
        goals: plannerMapGoals(
          data.goals,
          "month",
          plannerMonthStart(year, month),
        ),
        weeks: (yearMonths[month] ?? []).map((monday) => {
          const goals = plannerMapGoals(data.goals, "week", monday);
          return {
            monday,
            number: plannerWeekNumber(monday),
            kind: plannerMapWeekKind(monday, data.current_week, goals),
            record: records.get(monday),
            goals,
          };
        }),
      })),
    };
  });
  return {
    year,
    start,
    northStar: data.north_star,
    ...withTheme(plannerMapGoals(data.goals, "year", start)),
    quarters,
  };
}

/** The weeks open when the map is first drawn: the current one, if it is in the year. */
export function plannerMapInitialWeeks(map: PlannerYearMapData): Set<string> {
  const open = new Set<string>();
  for (const quarter of map.quarters) {
    for (const month of quarter.months) {
      for (const week of month.weeks) {
        if (week.kind === "now") open.add(week.monday);
      }
    }
  }
  return open;
}

/**
 * What a month label does: open every week of the month, or close them all
 * when every one is already open.
 */
export function plannerToggleMonthWeeks(
  open: ReadonlySet<string>,
  mondays: readonly string[],
): Set<string> {
  const next = new Set(open);
  const all = mondays.length > 0 && mondays.every((day) => next.has(day));
  for (const day of mondays) {
    if (all) next.delete(day);
    else next.add(day);
  }
  return next;
}

/** The small mark at the end of a goal on the map, or null. */
export type PlannerMapMark =
  | { kind: "met" | "partial" | "missed" | "contested" | "draft" | "closed" }
  | { kind: "tasks"; done: number; total: number };

export function plannerMapMark(
  goal: Pick<PlannerGoalDto, "status" | "result">,
  tasks?: { done: number; total: number },
): PlannerMapMark | null {
  if (goal.status === "contested") return { kind: "contested" };
  if (goal.status === "draft") return { kind: "draft" };
  if (goal.result) return { kind: goal.result };
  if (tasks && tasks.total > 0) return { kind: "tasks", ...tasks };
  if (goal.status === "closed") return { kind: "closed" };
  return null;
}

export type PlannerGoalTask = {
  card: PlannerBoardCard;
  column: "backlog" | "todo" | "doing" | "done";
};

/** A weekly goal's tasks on the board, Doing first, then To Do, Backlog, Done. */
export function plannerGoalTasks(
  goalId: string,
  board: Pick<PlannerBoardResponse, "columns"> | undefined,
): PlannerGoalTask[] {
  if (!board) return [];
  const order = { doing: 0, todo: 1, backlog: 2, done: 3 } as const;
  return plannerLiveCards(board)
    .filter((entry) => entry.card.goal_id === goalId)
    .sort((left, right) => order[left.column] - order[right.column]);
}

/** The goals above a weekly goal, for its pop-up: same objective, its year, quarter and month. */
export function plannerMapPath(
  map: PlannerYearMapData,
  goal: Pick<PlannerGoalDto, "pillar" | "period_start">,
): Array<{
  level: "year" | "quarter" | "month";
  quarter: number;
  month: number;
  goals: PlannerGoalDto[];
}> {
  if (!goal.period_start) return [];
  for (const quarter of map.quarters) {
    for (const month of quarter.months) {
      if (!month.weeks.some((week) => week.monday === goal.period_start)) {
        continue;
      }
      const pick = (goals: PlannerMapGoals) =>
        goal.pillar ? goals.byPillar[goal.pillar] : [];
      const base = { quarter: quarter.quarter, month: month.month };
      return [
        { level: "year", ...base, goals: pick(map.goals) },
        { level: "quarter", ...base, goals: pick(quarter.goals) },
        { level: "month", ...base, goals: pick(month.goals) },
      ];
    }
  }
  return [];
}

/**
 * A goal as a part of a split row: its heading, and its points as chips. A
 * goal with no title leads with its first point.
 */
export function plannerGoalParts(
  goal: Pick<PlannerGoalDto, "title" | "lines">,
): {
  head: string;
  points: Array<{ text: string; struck: boolean }>;
} {
  const points = goal.lines
    .filter((line) => line.text.trim())
    .map((line) => ({ text: line.text.trim(), struck: line.struck ?? false }));
  const title = goal.title.trim();
  if (title) return { head: title, points };
  const [first, ...rest] = points;
  return { head: first?.text ?? "", points: rest };
}
