import {
  healthBreathVariants,
  healthTrainingVariants,
  type PlannerAgentActionDto,
  type PlannerAgentEdit,
  type PlannerAgentEditKey,
  plannerAgentEditableKeys,
  plannerAgentEditBaseline,
  plannerAgentNeedsWords,
} from "@flaremo/contracts";

// Edit before Accept, the card's side (fork-owned add-on,
// docs/fork-general-agent.md, "Edit before Accept"). A card's edit is the keys
// the owner changed: `{ due_at: "2026-11-09" }`. The keys an action takes come
// from the contracts' `plannerAgentEditableKeys`, the same list the Worker
// refuses others by. A value put back to what the agent proposed is dropped from
// the edit, so "Edited" shows only while something differs.

export type PlannerCardEdit = Partial<PlannerAgentEdit>;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The keys this action's card shows as fields. */
export function plannerCardEditableKeys(
  action: PlannerAgentActionDto,
): readonly PlannerAgentEditKey[] {
  return action.state === "open" ? plannerAgentEditableKeys(action) : [];
}

/**
 * What a field starts at for one key, in the form an edit holds it: the agent's
 * value, or for a flagged goal or entry the record's own words (never the
 * agent's), the same baseline the Worker compares against.
 */
export function plannerCardProposed(
  action: PlannerAgentActionDto,
  key: PlannerAgentEditKey,
): unknown {
  return plannerAgentEditBaseline(action, key);
}

/** A words field as the Worker takes it: trimmed, lines without blanks. */
function cleaned(key: PlannerAgentEditKey, value: unknown): unknown {
  if (key === "lines" && Array.isArray(value)) {
    return value
      .map((line) => (typeof line === "string" ? line.trim() : ""))
      .filter((line) => line.length > 0);
  }
  if ((key === "text" || key === "note") && typeof value === "string") {
    return value.trim();
  }
  if (key === "title" && typeof value === "string") {
    // An emptied title is no edit (the Worker takes a title of one letter or more).
    return value.trim() || undefined;
  }
  return value;
}

/**
 * Whether the row still waits on the owner's words: a flagged entry not yet
 * rewritten, a new goal without its title, a goal edit that changes nothing.
 * Accept skips such a row.
 */
export function plannerCardNeedsWords(
  action: PlannerAgentActionDto,
  edit: PlannerCardEdit | undefined,
): boolean {
  return (
    action.state === "open" &&
    plannerAgentNeedsWords(action, plannerCardEditBody(action, edit))
  );
}

/** The value a control shows: the owner's edit, else the proposal. */
export function plannerCardValue(
  action: PlannerAgentActionDto,
  edit: PlannerCardEdit,
  key: PlannerAgentEditKey,
): unknown {
  return key in edit && edit[key] !== undefined
    ? edit[key]
    : plannerCardProposed(action, key);
}

/** The edit with `key` set; a value equal to the proposal removes the key. */
export function plannerCardSet(
  action: PlannerAgentActionDto,
  edit: PlannerCardEdit,
  patch: PlannerCardEdit,
): PlannerCardEdit {
  const next: Record<string, unknown> = { ...edit };
  for (const [key, value] of Object.entries(patch)) {
    if (same(value, plannerCardProposed(action, key as PlannerAgentEditKey))) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  // Another column has no "agent's spot": fall back to the top of it.
  if (
    action.field === "place" &&
    next.column !== undefined &&
    next.spot === undefined
  ) {
    next.spot = "top";
  }
  return next as PlannerCardEdit;
}

/** The edit to send with Accept, or undefined when nothing differs. */
export function plannerCardEditBody(
  action: PlannerAgentActionDto,
  edit: PlannerCardEdit | undefined,
): PlannerCardEdit | undefined {
  if (!edit) return undefined;
  const allowed = plannerCardEditableKeys(action);
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = cleaned(key, edit[key]);
    if (value !== undefined && !same(value, plannerCardProposed(action, key))) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? (out as PlannerCardEdit) : undefined;
}

/** The kind and variant pairs a health row can be added as, in listing order. */
export const plannerHealthKinds: ReadonlyArray<{
  kind: "training" | "breath" | "night_out";
  variant: string | null;
}> = [
  ...healthTrainingVariants.map((variant) => ({
    kind: "training" as const,
    variant: variant as string,
  })),
  ...healthBreathVariants.map((variant) => ({
    kind: "breath" as const,
    variant: variant as string,
  })),
  { kind: "night_out", variant: null },
];
