import { plannerEffortSchema } from "@flaremo/contracts";

// Reading and writing the effort field of the task panel (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13). The limits (0 to
// 999, at most one decimal) are the contract's own `plannerEffortSchema`, so the
// field refuses exactly what the server would answer 400 to, and never sends it.

export type PlannerEffortParse =
  | { ok: true; value: number | null }
  | { ok: false };

// Digits with an optional fraction: "3", "3.", "3.5", ".5". No sign, no
// exponent, no hex: `Number("0x10")` is 16 and `Number("1e2")` is 100, and a
// number box should not turn a slip into a value.
const EFFORT_TEXT = /^(?:\d+\.?\d*|\.\d+)$/;

/**
 * What the field's text means: blank clears the estimate, a number from 0 to 999
 * with at most one decimal sets it, anything else is not valid. A comma is read
 * as the decimal point, for a keyboard that types one.
 */
export function plannerParseEffort(text: string): PlannerEffortParse {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return { ok: true, value: null };
  if (!EFFORT_TEXT.test(trimmed)) return { ok: false };
  const parsed = plannerEffortSchema.safeParse(Number(trimmed));
  if (!parsed.success) return { ok: false };
  // Round to the tenth the schema already vouched for, so "3.50" is 3.5 and
  // 0.1 + 0.2 style noise never reaches the wire.
  return { ok: true, value: Math.round(parsed.data * 10) / 10 };
}

/** The text a number box shows for a stored effort: "" for none, "3", "3.5". */
export function plannerFormatEffort(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
