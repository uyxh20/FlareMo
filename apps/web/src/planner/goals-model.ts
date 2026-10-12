import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerGoalDto,
  type PlannerPillar,
  type PlannerWeekDto,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerIsoYearMondays,
  plannerOnTarget,
  plannerPillars,
  plannerWeekMonthOf,
} from "@flaremo/contracts";
import type { PlannerGoalsStrings } from "./goals-strings";

// What the goal cards, the Goals page and the weekly review compute from the
// server's answers (fork-owned add-on, docs/planning-cockpit-goals-review.md):
// plain functions over the DTOs, so each can be tested without rendering. Weeks
// are named by their Monday (`YYYY-MM-DD`) everywhere; the week number shown is
// the ISO one.

/** "5 – 11 Oct": the days of the week starting on `monday`. */
export function plannerWeekRange(
  monday: string,
  strings: PlannerGoalsStrings,
): string {
  const sunday = plannerAddDays(monday, 6);
  const part = (day: string) => ({
    month: Number(day.slice(5, 7)) - 1,
    day: Number(day.slice(8, 10)),
  });
  return strings.range(part(monday), part(sunday));
}

/** The ISO week number of a week. */
export function plannerWeekNumber(monday: string): number {
  return plannerIsoWeekOf(monday).week;
}

/** One decimal, as scores are written: 4 is "4.0". */
export function plannerScoreText(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** Two decimals, as averages are written. */
export function plannerAverageText(value: number): string {
  return (Math.round(value * 100 + 1e-9) / 100).toFixed(2);
}

export type PlannerWeekStats = {
  /** Weeks counted: those that have started and ended before the current one. */
  total: number;
  scored: number;
  auth: number | null;
  ach: number | null;
  /** Scored weeks that met both floors. */
  onTarget: number;
};

/**
 * Averages over the given weeks, counting only weeks before `currentWeek`: the
 * week in progress has no scores yet and never pulls an average down.
 */
export function plannerWeekStats(
  mondays: readonly string[],
  records: ReadonlyMap<string, PlannerWeekDto>,
  currentWeek: string,
): PlannerWeekStats {
  const past = mondays.filter((monday) => monday < currentWeek);
  const scored = past
    .map((monday) => records.get(monday))
    .filter(
      (week): week is PlannerWeekDto & { auth: number; ach: number } =>
        week !== undefined && week.auth !== null && week.ach !== null,
    );
  const average = (pick: (week: { auth: number; ach: number }) => number) =>
    scored.length
      ? scored.reduce((sum, week) => sum + pick(week), 0) / scored.length
      : null;
  return {
    total: past.length,
    scored: scored.length,
    auth: average((week) => week.auth),
    ach: average((week) => week.ach),
    onTarget: scored.filter((week) => plannerOnTarget(week)).length,
  };
}

/** How a week's cell in the heatmap is drawn. */
export type PlannerCellKind = "on" | "below" | "none" | "now" | "future";

export function plannerCellKind(
  monday: string,
  currentWeek: string,
  record: PlannerWeekDto | undefined,
): PlannerCellKind {
  if (monday === currentWeek) return "now";
  if (monday > currentWeek) return "future";
  if (!record || record.auth === null || record.ach === null) return "none";
  return plannerOnTarget(record) ? "on" : "below";
}

/**
 * The weeks of each month of an ISO year. A week belongs to its Thursday's
 * month, and an ISO year is the year of its weeks' Thursdays, so every week of
 * the year lands in exactly one of its twelve months.
 */
export function plannerYearMonths(year: number): string[][] {
  const months: string[][] = Array.from({ length: 12 }, () => []);
  for (const monday of plannerIsoYearMondays(year)) {
    months[plannerWeekMonthOf(monday).month]?.push(monday);
  }
  return months;
}

/** The ISO year, month (0 to 11) and quarter (1 to 4) a week is shown under. */
export function plannerWeekPlace(monday: string): {
  year: number;
  month: number;
  quarter: number;
} {
  const { year, month } = plannerWeekMonthOf(monday);
  return { year, month, quarter: Math.floor(month / 3) + 1 };
}

/** The records of a year by Monday. */
export function plannerWeeksByMonday(
  weeks: readonly PlannerWeekDto[],
): Map<string, PlannerWeekDto> {
  return new Map(weeks.map((week) => [week.week_start, week]));
}

/**
 * A goal's lines read as chips when every one is short and plain (24 characters
 * at most, no note, not struck): "Grade A title · Own budget · A crew".
 */
export function plannerLinesAsChips(goal: Pick<PlannerGoalDto, "lines">) {
  return (
    goal.lines.length > 0 &&
    goal.lines.every(
      (line) => line.text.length <= 24 && !line.note && !line.struck,
    )
  );
}

/** The badge a goal wears on the Goals page, or null. */
export function plannerGoalBadge(
  goal: Pick<PlannerGoalDto, "status" | "result">,
):
  | { kind: "contested" | "draft" | "closed" }
  | { kind: "result"; result: NonNullable<PlannerGoalDto["result"]> }
  | null {
  if (goal.status === "contested") return { kind: "contested" };
  if (goal.status === "draft") return { kind: "draft" };
  if (goal.result) return { kind: "result", result: goal.result };
  if (goal.status === "closed") return { kind: "closed" };
  return null;
}

/** Goals of one level and period, by objective in display order, then their own order. */
export function plannerGoalsOf(
  goals: readonly PlannerGoalDto[],
  level: PlannerGoalDto["level"],
  periodStart: string | null,
): PlannerGoalDto[] {
  const order = (pillar: PlannerPillar | null) =>
    pillar === null ? plannerPillars.length : plannerPillars.indexOf(pillar);
  return goals
    .filter(
      (goal) =>
        goal.level === level &&
        (periodStart === null || goal.period_start === periodStart),
    )
    .sort(
      (left, right) =>
        order(left.pillar) - order(right.pillar) ||
        left.sort_order - right.sort_order ||
        left.created_at.localeCompare(right.created_at),
    );
}

/** A slot of the goal cards row: one goal, or an objective with none this week. */
export type PlannerGoalSlot =
  | { kind: "goal"; goal: PlannerGoalDto; pillar: PlannerPillar | null }
  | { kind: "empty"; pillar: PlannerPillar };

/**
 * The cockpit's goal cards: every weekly goal by objective, and a dashed empty
 * slot for each objective with none. Goals with no objective come last.
 */
export function plannerGoalSlots(
  goals: readonly PlannerGoalDto[],
): PlannerGoalSlot[] {
  const sorted = plannerGoalsOf(goals, "week", null);
  const slots: PlannerGoalSlot[] = [];
  for (const pillar of plannerPillars) {
    const mine = sorted.filter((goal) => goal.pillar === pillar);
    if (mine.length === 0) slots.push({ kind: "empty", pillar });
    for (const goal of mine) slots.push({ kind: "goal", goal, pillar });
  }
  for (const goal of sorted.filter((item) => item.pillar === null)) {
    slots.push({ kind: "goal", goal, pillar: null });
  }
  return slots;
}

/** The board's live cards (not Other, not dropped), in column order. */
export function plannerLiveCards(
  board: Pick<PlannerBoardResponse, "columns">,
): Array<{
  card: PlannerBoardCard;
  column: "backlog" | "todo" | "doing" | "done";
}> {
  const columns = ["backlog", "todo", "doing", "done"] as const;
  return columns.flatMap((column) =>
    board.columns[column].map((card) => ({ card, column })),
  );
}

/** A weekly goal's tasks on the board: how many, and how many are done. */
export function plannerGoalProgress(
  goalId: string,
  board: Pick<PlannerBoardResponse, "columns">,
): { done: number; total: number } {
  const mine = plannerLiveCards(board).filter(
    (entry) => entry.card.goal_id === goalId,
  );
  return {
    total: mine.length,
    done: mine.filter((entry) => entry.column === "done").length,
  };
}

/** The goal a card belongs to, if it is one of `goals` (the week the cards show). */
export function plannerCardGoal(
  card: Pick<PlannerBoardCard, "goal_id">,
  goals: ReadonlyMap<string, PlannerGoalDto>,
): PlannerGoalDto | null {
  return card.goal_id ? (goals.get(card.goal_id) ?? null) : null;
}

/** A goal's text in one line: its title, or its points joined. */
export function plannerGoalText(
  goal: Pick<PlannerGoalDto, "title" | "lines">,
): string {
  return goal.title.trim() || goal.lines.map((line) => line.text).join(" · ");
}

/** The ISO year `today` falls in. */
export function plannerIsoYearOf(today: string): number {
  return plannerIsoWeekOf(today).year;
}

/** The first day of a calendar month; `month` is 0 to 11. */
export function plannerMonthStart(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The first day of a quarter, 1 to 4. */
export function plannerQuarterStart(year: number, quarter: number): string {
  return plannerMonthStart(year, (quarter - 1) * 3);
}

/** The three months (0 to 11) of a quarter. */
export function plannerQuarterMonths(quarter: number): number[] {
  return [0, 1, 2].map((index) => (quarter - 1) * 3 + index);
}

/**
 * A period's goals as the Goals page shows them: its theme line (the first goal
 * with no objective) and the rest, by objective.
 */
export function plannerPeriodGoals(
  goals: readonly PlannerGoalDto[],
  level: PlannerGoalDto["level"],
  periodStart: string,
): { theme: PlannerGoalDto | null; goals: PlannerGoalDto[] } {
  const all = plannerGoalsOf(goals, level, periodStart);
  const theme = all.find((goal) => goal.pillar === null) ?? null;
  return { theme, goals: all.filter((goal) => goal !== theme) };
}

/** How many weekly goals each week has, by Monday. */
export function plannerWeekGoalCounts(
  goals: readonly PlannerGoalDto[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const goal of goals) {
    if (goal.level !== "week" || !goal.period_start) continue;
    counts.set(goal.period_start, (counts.get(goal.period_start) ?? 0) + 1);
  }
  return counts;
}

/** Whether a week has both scores. */
export function plannerIsScored(
  week: Pick<PlannerWeekDto, "auth" | "ach"> | undefined,
): week is Pick<PlannerWeekDto, "auth" | "ach"> & {
  auth: number;
  ach: number;
} {
  return week !== undefined && week.auth !== null && week.ach !== null;
}

/**
 * What a week's cell says on hover, line by line: the week and its days, then
 * its scores (or why it has none), then how many goals it had.
 */
export function plannerCellLines(
  monday: string,
  currentWeek: string,
  record: PlannerWeekDto | undefined,
  goalCount: number,
  strings: PlannerGoalsStrings,
): string[] {
  const head = `${strings.weekCode(plannerWeekNumber(monday))} · ${plannerWeekRange(monday, strings)}`;
  if (monday === currentWeek) return [head, strings.goals.thisWeek];
  if (monday > currentWeek) return [head, strings.goals.notYet];
  return [
    head,
    plannerIsScored(record)
      ? strings.goals.scores(
          plannerScoreText(record.auth),
          plannerScoreText(record.ach),
        )
      : strings.goals.notScored,
    goalCount ? strings.goals.goalCount(goalCount) : strings.goals.noGoalsSet,
  ];
}
