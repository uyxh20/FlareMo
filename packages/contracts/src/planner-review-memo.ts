// The weekly summary memo (fork-owned add-on, docs/planning-cockpit-goals-review.md):
// the shape the owner's past weekly summaries share, so a summary written by the
// weekly review sits next to them unchanged. The Worker uses these pieces to ask a
// model for the memo and to read Next Steps and the key question back out of a
// past summary; the web app uses the same template when no model can write it.
// Like planner-goals.ts, planner.ts re-exports this file, so it never imports
// planner.ts.

import { FORK_PRODUCT_NAME } from "./fork-brand";
import {
  type PlannerGoalResult,
  type PlannerPillar,
  type PlannerVerdictKind,
  plannerAddDays,
  plannerIsoWeekOf,
  plannerPillars,
  plannerReviewPrompts,
  plannerScoreFloors,
} from "./planner-goals";

/** Each objective's full name, as goal cards and the memo headings say it. */
export const plannerPillarNames: Record<PlannerPillar, string> = {
  of: "Objective Function",
  work: "Work",
  ai: "AI Chops",
  health: "Health",
};

/** Each objective's short name, for narrow screens and task labels. */
export const plannerPillarShortNames: Record<PlannerPillar, string> = {
  of: "Objective",
  work: "Work",
  ai: "AI Chops",
  health: "Health",
};

/** The memo's heading for each objective, numbered as in the past summaries. */
export const plannerMemoPillarHeadings: Record<PlannerPillar, string> = {
  of: "### I. Objective Function",
  work: "### II. Work",
  ai: "### III. AI Chops",
  health: "### IV. Health & Fitness",
};

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

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function partsOf(day: string) {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month: month - 1, date };
}

/** The ISO week number of a week, as "W41". */
export function plannerWeekCode(weekStart: string): string {
  return `W${plannerIsoWeekOf(weekStart).week}`;
}

/** A week's days as the memo title writes them: "October 5 - October 11, 2026". */
export function plannerMemoRange(weekStart: string): string {
  const first = partsOf(weekStart);
  const last = partsOf(plannerAddDays(weekStart, 6));
  return `${MONTHS[first.month]} ${first.date} - ${MONTHS[last.month]} ${last.date}, ${last.year}`;
}

/** The memo's first line: "# Week 41: October 5 - October 11, 2026". */
export function plannerMemoTitle(weekStart: string): string {
  return `# Week ${plannerIsoWeekOf(weekStart).week}: ${plannerMemoRange(weekStart)}`;
}

/** "Sunday 2026-10-11": the day a review ran, as the memo's sources line says it. */
export function plannerMemoDayLabel(day: string): string {
  const { year, month, date } = partsOf(day);
  const weekday = new Date(Date.UTC(year, month, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day}`;
}

/**
 * The hidden marker at the end of a summary that ties it to the week's diary
 * entries. The memo view hides HTML comments, so a visible line goes with it.
 */
export function plannerDiaryMarker(weekStart: string): string {
  return `<!-- flaremo:diary ${weekStart}..${plannerAddDays(weekStart, 6)} -->`;
}

/** The visible line above the diary marker. */
export function plannerDiaryLine(weekStart: string): string {
  const first = partsOf(weekStart);
  const last = partsOf(plannerAddDays(weekStart, 6));
  const from =
    first.month === last.month
      ? `${first.date}`
      : `${first.date} ${MONTHS[first.month]}`;
  return `Diary entries from ${from} to ${last.date} ${MONTHS[last.month]} ${last.year}.`;
}

/** One decimal, as the scores table writes a score: 4 is "4.0". */
export function plannerFormatScore(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** The Gap row's basis: which floors the two scores meet. */
export function plannerGapBasis(scores: { auth: number; ach: number }): string {
  const lowAuth = scores.auth < plannerScoreFloors.auth;
  const lowAch = scores.ach < plannerScoreFloors.ach;
  if (lowAuth && lowAch) return "Both scores are below their floors.";
  if (lowAuth) {
    return `Authenticity is below the ${plannerFormatScore(plannerScoreFloors.auth)} floor.`;
  }
  if (lowAch) {
    return `Achievement is below the ${plannerFormatScore(plannerScoreFloors.ach)} floor.`;
  }
  return "Both scores meet the yearly floors.";
}

const VERDICT_NAMES: Record<PlannerVerdictKind, string> = {
  continue: "Continue",
  pivot: "Pivot",
  pause: "Pause",
};

/**
 * The memo's verdict line: the verdict's first sentence in bold, the rest after
 * it, and a note when the owner chose another verdict than the one recommended.
 */
export function plannerVerdictLine(
  verdict: { kind: PlannerVerdictKind; text: string } | null,
  recommended: PlannerVerdictKind | null,
): string {
  if (!verdict) return "**Verdict:** —";
  const text = verdict.text.trim();
  const end = text.search(/[.!?](\s|$)/);
  const head = end >= 0 ? text.slice(0, end + 1) : text;
  const rest = end >= 0 ? text.slice(end + 1).trim() : "";
  const over =
    recommended && verdict.kind !== recommended
      ? ` The user chose ${VERDICT_NAMES[verdict.kind]} over the assistant's recommended ${VERDICT_NAMES[recommended]}.`
      : "";
  return `**Verdict: ${head}**${rest ? ` ${rest}` : ""}${over}`;
}

/** The key question line, with the next week's code. */
export function plannerKeyQuestionLine(
  weekStart: string,
  question: string | null,
): string {
  return `**Key question for ${plannerWeekCode(plannerAddDays(weekStart, 7))}'s review:** ${question?.trim() || "—"}`;
}

/** Answers joined into one paragraph, each ending with a full stop. */
export function plannerJoinAnswers(answers: readonly string[]): string {
  return answers
    .map((answer) => answer.trim())
    .filter(Boolean)
    .map((answer) => (/[.!?…]$/.test(answer) ? answer : `${answer}.`))
    .join(" ");
}

const cell = (value: string) =>
  value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** The scores table under Objective Function, exactly as the past summaries have it. */
export function plannerScoresTable(input: {
  weekStart: string;
  scores: { auth: number; ach: number };
  authBasis: string;
  achBasis: string;
}): string {
  const { scores } = input;
  const gap = Math.abs(scores.auth - scores.ach);
  return [
    `- **Scores (${plannerWeekCode(input.weekStart)}, user-calibrated):**`,
    "",
    "| Measure | Score | Basis |",
    "|---|---:|---|",
    `| Authenticity | ${plannerFormatScore(scores.auth)}/5 | ${cell(input.authBasis) || "None stated."} |`,
    `| Achievement | ${plannerFormatScore(scores.ach)}/5 | ${cell(input.achBasis) || "None stated."} |`,
    `| Gap | ${plannerFormatScore(gap)} | ${plannerGapBasis(scores)} |`,
  ].join("\n");
}

const RESULT_WORDS: Record<PlannerGoalResult, string> = {
  met: "Met",
  partial: "Partly met",
  missed: "Missed",
};

/** Everything the template needs, all of it recorded by the review. */
export type PlannerSummaryMemoInput = {
  weekStart: string;
  /** The day the review ran, YYYY-MM-DD. */
  reviewedOn: string;
  recap: string;
  lastQuestion: string | null;
  lastAnswer: readonly string[];
  /** The week's own goals with the result the review recorded. */
  goals: ReadonlyArray<{
    pillar: PlannerPillar | null;
    title: string;
    result: PlannerGoalResult | null;
  }>;
  /** One list per prompt, in order; empty for a skipped prompt. */
  answers: ReadonlyArray<readonly string[]>;
  scores: { auth: number; ach: number };
  authBasis: string;
  achBasis: string;
  trajectory: { pattern: string; risk: string; opportunity: string };
  question: string | null;
  verdict: { kind: PlannerVerdictKind; text: string } | null;
  recommended: PlannerVerdictKind | null;
};

/**
 * The summary memo filled only with what the review recorded, in the past
 * summaries' format. The page uses it when no model can write the memo.
 */
export function plannerComposeSummaryMemo(
  input: PlannerSummaryMemoInput,
): string {
  const none = "None stated.";
  const code = plannerWeekCode(input.weekStart);
  const has = (index: number) => (input.answers[index]?.length ?? 0) > 0;
  const answer = (index: number) =>
    has(index) ? plannerJoinAnswers(input.answers[index] ?? []) : "Skipped.";
  const lastAnswer = input.lastAnswer.length
    ? plannerJoinAnswers(input.lastAnswer)
    : null;
  const goalLine = (pillar: PlannerPillar | null) =>
    input.goals
      .filter((goal) => goal.pillar === pillar)
      .map(
        (goal) =>
          `${goal.title.trim().replace(/[.!?]$/, "")}: ${goal.result ? RESULT_WORDS[goal.result] : "not recorded"}.`,
      )
      .join(" ");

  const lines: string[] = [plannerMemoTitle(input.weekStart), ""];
  lines.push(
    "## Review status and sources",
    "",
    `Created in the ${FORK_PRODUCT_NAME} weekly review on ${plannerMemoDayLabel(input.reviewedOn)}. ${
      input.goals.length
        ? `${code} had ${input.goals.length} weekly goal${input.goals.length === 1 ? "" : "s"}.`
        : `No ${code} goals were set in advance.`
    } Assembled from the review answers without a model summary pass.`,
    "",
  );
  lines.push("## Executive Summary", "", input.recap.trim() || none, "");
  lines.push("## 1. High-Level Summary", "");
  const highlights = [
    has(0) ? `Impact: ${answer(0)}` : "",
    has(4) ? `The one big thing: ${answer(4)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (highlights) lines.push(highlights, "");
  if (input.lastQuestion) {
    lines.push(
      `**Last week's key question:** *${input.lastQuestion.trim()}* ${lastAnswer ?? "Not answered."}`,
      "",
    );
  }
  lines.push(
    "## 2. Guided Reflection Prompts",
    "",
    ...plannerReviewPrompts.map(
      (prompt, index) => `- **${prompt.label}:** ${answer(index)}`,
    ),
    "",
  );
  lines.push("## 3. Goal Progress Update", "");
  for (const pillar of plannerPillars) {
    lines.push(plannerMemoPillarHeadings[pillar]);
    if (pillar === "of") {
      lines.push(
        plannerScoresTable({
          weekStart: input.weekStart,
          scores: input.scores,
          authBasis: input.authBasis,
          achBasis: input.achBasis,
        }),
        "",
      );
    }
    const evidence = [
      goalLine(pillar),
      pillar === "of" && input.lastQuestion && lastAnswer
        ? `${input.lastQuestion.trim()} ${lastAnswer}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `- **Evidence:** ${evidence || none}`,
      `- **Learnings:** ${pillar === "of" && has(1) ? answer(1) : none}`,
      `- **Blockers:** ${pillar === "of" && has(3) ? answer(3) : none}`,
      "- **Next Steps:** See Trajectory.",
      "",
    );
  }
  const unassigned = goalLine(null);
  if (unassigned)
    lines.splice(lines.length - 1, 0, `- **Other goals:** ${unassigned}`);
  lines.push(
    `## Trajectory into ${plannerWeekCode(plannerAddDays(input.weekStart, 7))}`,
    "",
    `**Pattern.** ${input.trajectory.pattern.trim() || none}`,
    "",
    `**Risk.** ${input.trajectory.risk.trim() || none}`,
    "",
    `**Opportunity.** ${input.trajectory.opportunity.trim() || none}`,
    "",
    plannerKeyQuestionLine(input.weekStart, input.question),
    "",
    plannerVerdictLine(input.verdict, input.recommended),
    "",
  );
  lines.push(
    "## 4. Raw Logs for this Week",
    "",
    plannerDiaryLine(input.weekStart),
    "",
    plannerDiaryMarker(input.weekStart),
  );
  return lines.join("\n");
}

const EMPTY_STEP = /^(see trajectory|none stated|none|n\/a|—|-|skipped)\.?$/i;

/**
 * Next Steps per objective, read from a summary memo's Goal Progress Update. The
 * plan for the next week starts from them. A missing or empty bullet ("See
 * Trajectory.", "None stated.") is left out.
 */
export function plannerMemoNextSteps(
  markdown: string,
): Partial<Record<PlannerPillar, string>> {
  const out: Partial<Record<PlannerPillar, string>> = {};
  for (const part of String(markdown ?? "").split(/^(?=###\s)/m)) {
    const heading = part.split("\n")[0] ?? "";
    if (!/^###\s/.test(heading)) continue;
    const pillar: PlannerPillar | null = /Objective Function/i.test(heading)
      ? "of"
      : /\bWork\b/i.test(heading)
        ? "work"
        : /AI Chops/i.test(heading)
          ? "ai"
          : /Health/i.test(heading)
            ? "health"
            : null;
    if (!pillar || out[pillar]) continue;
    const match = /^\s*[-*]\s+\*\*Next Steps:?\*\*:?\s*(.+)$/im.exec(part);
    if (!match?.[1]) continue;
    const value = match[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (value && !EMPTY_STEP.test(value)) out[pillar] = value.slice(0, 300);
  }
  return out;
}

/**
 * The key question a summary memo leaves for the next review, from its "Key
 * question for W42's review:" line, or null.
 */
export function plannerMemoKeyQuestion(markdown: string): string | null {
  const match =
    /\*\*Key question for W\d+(?:'s)?(?: review)?:?\*\*:?\s*(.+)$/im.exec(
      String(markdown ?? ""),
    );
  const value = match?.[1]
    ?.replace(/\*\*/g, "")
    .replace(/^[*_"“']+|[*_"”']+$/g, "")
    .trim();
  return value && value !== "—" ? value.slice(0, 500) : null;
}

/** The ISO week and year a summary memo is about, from its title, or null. */
export function plannerMemoWeekOf(
  markdown: string,
): { year: number; week: number } | null {
  const firstLine =
    String(markdown ?? "")
      .split("\n")
      .find((line) => line.trim()) ?? "";
  const match = /^#\s*Week\s+(\d{1,2})\b(.*)$/i.exec(firstLine.trim());
  if (!match?.[1]) return null;
  const years = [...(match[2] ?? "").matchAll(/\b(\d{4})\b/g)].map((found) =>
    Number(found[1]),
  );
  const year = years.at(-1);
  if (!year) return null;
  return { year, week: Number(match[1]) };
}
