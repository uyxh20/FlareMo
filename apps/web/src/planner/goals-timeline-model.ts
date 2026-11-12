import {
  type PlannerGoalDto,
  type PlannerPillar,
  plannerPillars,
} from "@flaremo/contracts";
import type {
  PlannerMapGoals,
  PlannerMapWeek,
  PlannerYearMapData,
} from "./year-map-model";

// The Goals page's timeline (fork-owned add-on, goals-timeline.tsx): the Year
// map turned on its side. Months run left to right; each objective is a row
// with its quarter goals above its month goals. It reads the same
// PlannerYearMapData as the grid, so the two views can never disagree. Plain
// functions, so the layout and the remembered view can be tested unrendered.

export type PlannerGoalsView = "timeline" | "grid";

/** The view the Goals page opens on. */
export const PLANNER_GOALS_DEFAULT_VIEW: PlannerGoalsView = "timeline";

const VIEW_KEY = "schizo-diary.goals.view";

/** The view picked last time on this device; the timeline when none was. */
export function plannerReadGoalsView(
  storage: () => Pick<Storage, "getItem"> = () => localStorage,
): PlannerGoalsView {
  try {
    const value = storage().getItem(VIEW_KEY);
    return value === "grid" || value === "timeline"
      ? value
      : PLANNER_GOALS_DEFAULT_VIEW;
  } catch {
    return PLANNER_GOALS_DEFAULT_VIEW;
  }
}

export function plannerWriteGoalsView(
  view: PlannerGoalsView,
  storage: () => Pick<Storage, "setItem"> = () => localStorage,
) {
  try {
    storage().setItem(VIEW_KEY, view);
  } catch {
    // Private window or blocked storage: the choice lasts until a reload.
  }
}

export type PlannerTimelineMonth = {
  month: number;
  start: string;
  current: boolean;
  goals: PlannerGoalDto[];
  weeks: Array<{ week: PlannerMapWeek; goals: PlannerGoalDto[] }>;
};

/** One row of the timeline: an objective, or `null` for goals with none. */
export type PlannerTimelineRow = {
  pillar: PlannerPillar | null;
  year: PlannerGoalDto[];
  quarters: Array<{ quarter: number; start: string; goals: PlannerGoalDto[] }>;
  months: PlannerTimelineMonth[];
};

function pick(
  goals: PlannerMapGoals,
  pillar: PlannerPillar | null,
  theme: PlannerGoalDto | null = null,
): PlannerGoalDto[] {
  if (pillar) return goals.byPillar[pillar];
  return theme ? [theme, ...goals.loose] : goals.loose;
}

function rowOf(
  map: PlannerYearMapData,
  pillar: PlannerPillar | null,
): PlannerTimelineRow {
  return {
    pillar,
    year: pick(map.goals, pillar, map.theme),
    quarters: map.quarters.map((quarter) => ({
      quarter: quarter.quarter,
      start: quarter.start,
      goals: pick(quarter.goals, pillar, quarter.theme),
    })),
    months: map.quarters.flatMap((quarter) =>
      quarter.months.map((month) => ({
        month: month.month,
        start: month.start,
        current: month.current,
        goals: pick(month.goals, pillar),
        weeks: month.weeks.map((week) => ({
          week,
          goals: pick(week.goals, pillar),
        })),
      })),
    ),
  };
}

function rowIsEmpty(row: PlannerTimelineRow): boolean {
  return (
    row.year.length === 0 &&
    row.quarters.every((quarter) => quarter.goals.length === 0) &&
    row.months.every(
      (month) =>
        month.goals.length === 0 &&
        month.weeks.every((week) => week.goals.length === 0),
    )
  );
}

/**
 * The timeline's rows: one per objective, then one for goals with no
 * objective when there are any. Following an objective leaves only its row.
 */
export function plannerTimelineRows(
  map: PlannerYearMapData,
  follow: PlannerPillar | null,
): PlannerTimelineRow[] {
  if (follow) return [rowOf(map, follow)];
  const rows = plannerPillars.map((pillar) => rowOf(map, pillar));
  const loose = rowOf(map, null);
  return rowIsEmpty(loose) ? rows : [...rows, loose];
}

/** The month the timeline scrolls to: the current one, else January. */
export function plannerTimelineStartMonth(map: PlannerYearMapData): number {
  for (const quarter of map.quarters) {
    for (const month of quarter.months) {
      if (month.current) return month.month;
    }
  }
  return 0;
}
