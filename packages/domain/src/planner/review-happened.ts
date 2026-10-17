import {
  type PlannerHappened,
  type PlannerPillar,
  plannerPillars,
} from "@flaremo/contracts";
import {
  type PlannerRawRow,
  plannerVerifyQuote,
} from "./period-review-context";
import type { PlannerReviewContext } from "./review-context";
import {
  PLANNER_WEEK_HAPPENED_MAX,
  type PlannerOpeningDraft,
  plannerExtractJson,
  plannerParseOpening,
} from "./review-prompts";

// What happened, with receipts (fork-owned add-on, docs/planning-cockpit-
// goals-review.md and docs/planning-cockpit-period-review.md): the opening
// of the weekly review and of the month and quarter chapters names what
// happened in up to a few claims, each resting on words copied from the
// owner's own rows. The server checks every quote word for word against the
// rows the model read and drops the claims it cannot find, counted. The
// weekly review's rows come from its context (the diary entries, the health
// rows and the task notes the prompt showed the model); the period's are read
// whole in period-review-context.ts.

/** The opening of the weekly review, with what happened. */
export type PlannerWeekOpening = PlannerOpeningDraft & {
  happened: PlannerHappened[];
  dropped: number;
};

/**
 * The claims of a parsed opening whose quote was found word for word in
 * `raw`, at most `max`; the others are dropped and counted. A repeated claim
 * is kept once.
 */
export function plannerParseHappened(
  parsed: Record<string, unknown>,
  raw: readonly PlannerRawRow[],
  max: number,
): { happened: PlannerHappened[]; dropped: number } {
  const list = Array.isArray(parsed.happened) ? parsed.happened : [];
  const happened: PlannerHappened[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of list.slice(0, max * 2)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const claim =
      typeof entry.claim === "string"
        ? entry.claim.replace(/\s+/g, " ").trim().slice(0, 300)
        : "";
    const words =
      typeof entry.quote === "string"
        ? entry.quote.replace(/\s+/g, " ").trim().slice(0, 600)
        : "";
    if (!claim) continue;
    const check = words
      ? plannerVerifyQuote(words, raw)
      : { verified: false, source: null };
    if (!check.verified || !check.source) {
      dropped += 1;
      continue;
    }
    if (seen.has(claim.toLowerCase())) continue;
    seen.add(claim.toLowerCase());
    if (happened.length >= max) continue;
    const pillar = plannerPillars.find((value) => value === entry.pillar);
    happened.push({
      pillar: (pillar ?? null) as PlannerPillar | null,
      claim,
      quote: words,
      source: check.source.source,
      source_id: check.source.id,
      source_day: check.source.day,
    });
  }
  return { happened, dropped };
}

/**
 * The week's rows a receipt can rest on, as the opening prompt showed them:
 * each diary entry, each health row's note, and each task's title, notes and
 * comments. A diary entry is named by when it was written; a task by its
 * title, which is what the review knows it by.
 */
export function plannerWeekRawRows(
  context: PlannerReviewContext,
): PlannerRawRow[] {
  const raw: PlannerRawRow[] = [];
  for (const entry of context.diary) {
    raw.push({
      source: "memo",
      id: entry.at,
      day: entry.at.slice(0, 10),
      text: entry.text,
    });
  }
  for (const entry of context.health?.entries ?? []) {
    if (entry.feel?.trim()) {
      raw.push({
        source: "health",
        id: `${entry.kind}:${entry.day}`,
        day: entry.day,
        text: entry.feel,
      });
    }
  }
  const named = new Set<string>();
  for (const task of context.taskDetails) {
    named.add(task.title);
    const day = task.history.at(-1)?.at.slice(0, 10) ?? context.weekStart;
    raw.push({ source: "task_event", id: task.title, day, text: task.title });
    if (task.notes?.trim()) {
      raw.push({ source: "task_event", id: task.title, day, text: task.notes });
    }
    for (const comment of task.comments) {
      raw.push({
        source: "task_event",
        id: task.title,
        day: comment.at.slice(0, 10),
        text: comment.text,
      });
    }
  }
  for (const title of context.tasks.done) {
    if (named.has(title)) continue;
    raw.push({
      source: "task_event",
      id: title,
      day: context.weekStart,
      text: title,
    });
  }
  return raw;
}

/**
 * The weekly opening as the page reads it: the drafts, and the claims whose
 * words were found in the week's rows.
 */
export function plannerParseWeekOpening(
  raw: string,
  context: PlannerReviewContext,
): PlannerWeekOpening {
  return {
    ...plannerParseOpening(raw),
    ...plannerParseHappened(
      plannerExtractJson(raw) ?? {},
      plannerWeekRawRows(context),
      PLANNER_WEEK_HAPPENED_MAX,
    ),
  };
}
