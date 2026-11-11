// The morning page's contracts (fork-owned add-on, docs/fork-customizations.md,
// "Morning page"). The page itself draws its two panels from the cockpit's
// board; these routes only keep the day's idea line and whether the page was
// dismissed. Re-exported from planner.ts; it never imports planner.ts back.
//
//   GET    /morning?today                 PlannerMorningResponse (never calls a model)
//   POST   /morning/line                  PlannerMorningResponse (today's line, written if missing)
//   POST   /morning/dismiss               PlannerMorningResponse ("Start the day")
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import { plannerIsValidDayKey } from "./planner-periods";

const day = z
  .string()
  .refine(plannerIsValidDayKey, "Expected a real YYYY-MM-DD date.");

/** Off-plan, or the model's call. The goal-linked direction was dropped (10 Nov). */
export const plannerMorningDirections = ["away", "free"] as const;
export type PlannerMorningDirection = (typeof plannerMorningDirections)[number];

/**
 * The day's direction: off-plan on an even day of the year, the model's call
 * on an odd one, so the two alternate day to day.
 */
export function plannerMorningDirectionFor(
  today: string,
): PlannerMorningDirection {
  const date = new Date(`${today}T00:00:00Z`);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.round((date.getTime() - start) / 86_400_000) + 1;
  return dayOfYear % 2 === 0 ? "away" : "free";
}

export const plannerMorningQuerySchema = z.object({ today: day });

export const plannerMorningLineInputSchema = z.strictObject({
  today: day,
  /** Set by "Another": replace this line with a new one. */
  replace: z.string().min(1).max(64).optional(),
});

export const plannerMorningDismissSchema = z.strictObject({
  today: day,
  /** The line on screen when the owner pressed "Start the day". */
  line_id: z.string().min(1).max(64).nullable().optional(),
});

export const plannerMorningLineSchema = z.object({
  id: z.string(),
  text: z.string(),
  direction: z.enum(plannerMorningDirections),
});
export type PlannerMorningLine = z.infer<typeof plannerMorningLineSchema>;

export const plannerMorningResponseSchema = z.object({
  day,
  /** True once "Start the day" was pressed for `day`. */
  dismissed: z.boolean(),
  /** The day's line, or null when none is written yet or the model declined. */
  line: plannerMorningLineSchema.nullable(),
  /** Whether a model is set up to write a line; false hides the slot. */
  can_write: z.boolean(),
});
export type PlannerMorningResponse = z.infer<
  typeof plannerMorningResponseSchema
>;
