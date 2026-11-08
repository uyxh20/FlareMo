import {
  type PlannerGoalDto,
  type PlannerPillar,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerIsoYearMondays,
  plannerMonthStartOf,
  plannerPillarNames,
  plannerPillars,
  plannerQuarterStartOf,
  plannerWeekCode,
  plannerWeekMonthOf,
} from "@flaremo/contracts";
import type { PlannerReviewContext } from "./review-context";

// The goal cascade as a ladder (fork-owned, docs/fork-general-agent.md, "The
// cascade ladder"). The weekly review's context shows the north star and the
// year, quarter and month goals as four flat lines. With the ladder on, the
// same goals are shown per objective, top down to the week's own goal, with
// what the app can count for the model: points struck of points set, and the
// weeks left in the month, the quarter and the year once this week is over.
// The memo and the scores step then get rules that ask the review to judge
// the week against the ladder. The Worker turns it on with
// FLAREMO_REVIEW_CASCADE=ladder; "flat" (the default) changes nothing.

export type PlannerCascadeStyle = "flat" | "ladder";

/** The style a Worker var names; anything but "ladder" is flat. */
export function plannerCascadeStyleOf(
  value: string | undefined | null,
): PlannerCascadeStyle {
  return value?.trim().toLowerCase() === "ladder" ? "ladder" : "flat";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The ISO weeks of a period, as Mondays: a week belongs to the month of its
 * Thursday (the Goals page's rule), so no week is in two months.
 */
function weeksOfPeriod(
  periodStart: string,
  level: "month" | "quarter" | "year",
): string[] {
  const year = Number(periodStart.slice(0, 4));
  const month0 = Number(periodStart.slice(5, 7)) - 1;
  return plannerIsoYearMondays(year)
    .concat(plannerIsoYearMondays(year + 1).slice(0, 2))
    .filter((monday) => {
      const anchor = plannerWeekMonthOf(monday);
      if (anchor.year !== year) return false;
      if (level === "year") return true;
      if (level === "quarter") {
        return Math.floor(anchor.month / 3) === Math.floor(month0 / 3);
      }
      return anchor.month === month0;
    });
}

/** Weeks of a period after `weekStart`, and the period's weeks in all. */
export function plannerCascadeWeeksLeft(
  weekStart: string,
  level: "month" | "quarter" | "year",
): { left: number; total: number } {
  const thursday = plannerAddDays(weekStart, 3);
  const periodStart =
    level === "month"
      ? plannerMonthStartOf(thursday)
      : level === "quarter"
        ? plannerQuarterStartOf(thursday)
        : `${thursday.slice(0, 4)}-01-01`;
  const weeks = weeksOfPeriod(periodStart, level);
  return {
    left: weeks.filter((monday) => monday > weekStart).length,
    total: weeks.length,
  };
}

/** "2 of 3 points struck", or "no points set". */
function pointsCount(goal: PlannerGoalDto): string {
  const total = goal.lines.length;
  if (total === 0) return "no points set";
  const struck = goal.lines.filter((line) => line.struck).length;
  return `${struck} of ${total} point${total === 1 ? "" : "s"} struck`;
}

function goalLine(goal: PlannerGoalDto, counted: boolean): string {
  const lines = goal.lines
    .map(
      (line) =>
        `${line.struck ? "[struck] " : ""}${line.text}${line.note ? ` (${line.note})` : ""}`,
    )
    .join("; ");
  const body = [goal.title, lines].filter(Boolean).join(": ");
  const state =
    goal.status === "contested"
      ? ` [contested${goal.note ? `: ${goal.note}` : ""}]`
      : goal.status === "draft"
        ? " [draft, not confirmed]"
        : goal.status === "closed"
          ? " [closed]"
          : "";
  const result = goal.result ? ` [result: ${goal.result}]` : "";
  return `${body}${state}${result}${counted ? ` — ${pointsCount(goal)}` : ""}`;
}

/**
 * The cascade as lines for the context: the time left, then one block per
 * objective from the year goal down to the week's goal, then the north star
 * and any theme lines (goals with no objective).
 */
export function plannerCascadeLadderLines(
  context: PlannerReviewContext,
): string[] {
  const thursday = plannerAddDays(context.weekStart, 3);
  const { year, month } = plannerWeekMonthOf(context.weekStart);
  const quarter = Math.floor(month / 3) + 1;
  const iso = plannerIsoWeekOf(thursday);
  const monthLeft = plannerCascadeWeeksLeft(context.weekStart, "month");
  const quarterLeft = plannerCascadeWeeksLeft(context.weekStart, "quarter");
  const yearLeft = plannerCascadeWeeksLeft(context.weekStart, "year");
  const left = (count: { left: number; total: number }) =>
    `${count.left} of ${count.total} weeks left after this one`;
  const lines = [
    `Goal cascade for ${plannerWeekCode(context.weekStart)}, by objective, top down. Points in [struck] are done; the counts and the weeks left are the app's, not estimates. Judge the week by what it moved on the month goal's open points, and through it on the quarter and the year. The struck counts lag: ${context.ownerName} strikes points late or not at all, so "0 of n struck" is a question to check against the diary, never a verdict on its own. A goal is losing when the record shows no work toward its open points, not when its count is low.`,
    `Time: week ${iso.week} of ${iso.year}. ${MONTHS[month]}: ${left(monthLeft)}. Q${quarter} ${year}: ${left(quarterLeft)}. ${year}: ${left(yearLeft)}.`,
  ];
  const byPillar = (goals: readonly PlannerGoalDto[], pillar: PlannerPillar) =>
    goals.filter((goal) => goal.pillar === pillar);
  for (const pillar of plannerPillars) {
    lines.push(`- ${plannerPillarNames[pillar]}`);
    const levels: Array<[string, readonly PlannerGoalDto[], boolean]> = [
      [`Year ${year}`, byPillar(context.yearGoals, pillar), true],
      [`Q${quarter} ${year}`, byPillar(context.quarterGoals, pillar), true],
      [MONTHS[month] ?? "Month", byPillar(context.monthGoals, pillar), true],
      [
        `${plannerWeekCode(context.weekStart)} goal`,
        byPillar(context.weekGoals, pillar),
        false,
      ],
    ];
    for (const [label, goals, counted] of levels) {
      if (goals.length === 0) {
        lines.push(`  · ${label}: none set`);
        continue;
      }
      for (const goal of goals) {
        lines.push(`  · ${label}: ${goalLine(goal, counted)}`);
      }
    }
  }
  lines.push(
    `North star: ${context.northStar ? goalLine(context.northStar, false) : "not written"}`,
  );
  const themes = [
    ...context.yearGoals,
    ...context.quarterGoals,
    ...context.monthGoals,
  ].filter((goal) => goal.pillar === null);
  for (const goal of themes) {
    lines.push(`Theme (${goal.level}): ${goalLine(goal, false)}`);
  }
  return lines;
}

/** The two bullets the ladder adds to each objective's memo section. */
export const plannerCascadeMemoBullets = [
  "- **Serves:** (text)",
  "- **Moved:** (text)",
] as const;

/**
 * The memo rules the ladder adds: what the two bullets hold and how critical
 * to be. `name` is the owner's name as the prompts use it.
 */
export function plannerCascadeMemoRules(name: string): string[] {
  return [
    `- **Serves:** the month goal of that objective (the quarter's when the month has none), its open points, and the weeks left, from the cascade. One line. Write "No month or quarter goal." when there is none.`,
    `- **Moved:** one word first, then one sentence of evidence: "Advanced" when this week struck or clearly progressed an open point of that goal; "Maintained" when the work served the goal without moving a point; "Drifted" when the week's work in this objective went elsewhere, or when the week's own goal for it was missed or a tracked target was broken (a missed weekly goal is never "Maintained"); "Idle" when nothing in this objective happened. Then the gap in plain words: which goal is losing, how many weeks are left, and whether the week's effort went where the cascade points. Only from the record: a "losing" or "behind" call needs a diary fact behind it, not a point count; when the record is thin, say so instead of guessing.`,
    `- In Pattern and Risk, name the month or quarter goal most behind its time left, with its count of open points.`,
    `- Be direct about the gap between the plan and the week. No praise, no softening; also no criticism the record does not support.`,
  ];
}

/**
 * The scores step's extra instruction: the trajectory and the key question
 * tie to the cascade, and Achievement weighs the month goal's open points.
 */
export function plannerCascadeCloseRules(name: string): string {
  return `The cascade: ${name}'s week sits under a month goal, a quarter goal and a year goal per objective (the context shows them with their open points and the weeks left). When you judge Achievement, also weigh whether the week moved the month goal's open points, not only whether the week's own goals were met; say so in the Achievement basis. The Risk names the month or quarter goal most behind its time left, with its open points. Each candidate key question and each verdict names a month or quarter goal the next week must move.`;
}
