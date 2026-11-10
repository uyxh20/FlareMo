import {
  healthBreathVariants,
  healthTrainingVariants,
  type PlannerAgentActionDto,
  type PlannerAgentEdit,
  type PlannerAgentEditKey,
  plannerAgentEditableKeys,
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

/** What the agent proposed for one key, in the form an edit holds it. */
export function plannerCardProposed(
  action: PlannerAgentActionDto,
  key: PlannerAgentEditKey,
): unknown {
  if (key === "spot") return "anchor";
  if (key === "column" && action.kind === "task_new") {
    return action.change.column ?? "backlog";
  }
  return action.change[key] ?? null;
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
    const value = edit[key];
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
