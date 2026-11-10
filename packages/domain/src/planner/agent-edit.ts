import {
  healthBreathVariants,
  healthParseDay,
  healthTrainingVariants,
  type PlannerAgentEdit,
  type PlannerAgentEditKey,
  plannerAddDays,
  plannerAgentEditableKeys,
  plannerAgentEditSchema,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import {
  type PlannerAgentActionRow,
  plannerGoal,
} from "@flaremo/db/src/schema/planner";
import { and, eq, isNull } from "drizzle-orm";
import { ValidationError } from "../errors";
import { plannerBoardDoneDaysMax, plannerReadBoard } from "./board";
import { plannerReadWeekGoals, plannerRequireWeeklyGoal } from "./goals";

// What the owner changed on a card before Accept (fork-owned add-on,
// docs/fork-general-agent.md, "Edit before Accept"). The edit is a flat object
// of the values the card shows as fields; this file checks each one the way the
// agent's own tool checked the proposal, and lays it over the proposal's
// `change`. The accept then writes the merged change through the owner's usual
// code path, and keeps the agent's version beside it (`change.proposed`,
// `change.edited`) so the learning log can tell what the agent got wrong. The
// stale check still reads the original `was`, which the merge keeps.

export type PlannerAgentEditResult = {
  /** The proposal's change with the owner's values laid over it. */
  change: Record<string, unknown>;
  /** The keys that differ from the proposal, as the agent had them. */
  proposed: Record<string, unknown>;
  /** The same keys as the owner set them. */
  edited: Record<string, unknown>;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function refuse(message: string): never {
  throw new ValidationError(message);
}

/** Sets a key on a change, or removes it for null. */
function put(change: Record<string, unknown>, key: string, value: unknown) {
  if (value === null || value === undefined) delete change[key];
  else change[key] = value;
}

/** The weekly goal's title for the card, or a refusal when it is no weekly goal. */
async function weeklyGoalTitle(
  db: FlareMoDb,
  userId: string,
  goalId: string,
): Promise<string | null> {
  try {
    await plannerRequireWeeklyGoal(db, userId, goalId);
  } catch {
    return refuse("That goal is not one of your weekly goals.");
  }
  const goal = await db
    .select({ title: plannerGoal.title })
    .from(plannerGoal)
    .where(and(eq(plannerGoal.userId, userId), eq(plannerGoal.id, goalId)))
    .get();
  return goal?.title ?? null;
}

/** What the proposal holds for one editable key, in the form `edit` sends it. */
function proposedValue(
  row: PlannerAgentActionRow,
  key: PlannerAgentEditKey,
): unknown {
  const { change } = row;
  if (key === "spot") return "anchor";
  if (key === "column" && row.kind === "task_new") {
    return change.column ?? "backlog";
  }
  return change[key] ?? null;
}

/**
 * Checks `edit` against the action and returns the change to write, or null
 * when nothing differs from the proposal. Throws a ValidationError (shown on
 * the card's row) for a key the card does not offer or a value the owner's own
 * code would refuse.
 */
export async function plannerAgentApplyEdit(
  db: FlareMoDb,
  input: {
    userId: string;
    row: PlannerAgentActionRow;
    edit: unknown;
    today: string;
  },
): Promise<PlannerAgentEditResult | null> {
  const { userId, row, today } = input;
  const parsed = plannerAgentEditSchema.safeParse(input.edit);
  if (!parsed.success) return refuse("One of the edited values is not valid.");
  const edit: PlannerAgentEdit = parsed.data;
  const allowed = plannerAgentEditableKeys(row);
  const given = (Object.keys(edit) as PlannerAgentEditKey[]).filter(
    (key) => edit[key] !== undefined,
  );
  for (const key of given) {
    if (!allowed.includes(key)) {
      return refuse("That value cannot be changed on this card.");
    }
  }
  // A value that equals the proposal is not an edit.
  const changed = given.filter(
    (key) => !same(edit[key], proposedValue(row, key)),
  );
  if (changed.length === 0) return null;

  const change: Record<string, unknown> = { ...row.change };
  switch (row.kind) {
    case "task_new": {
      if (edit.title !== undefined) put(change, "title", edit.title);
      if (edit.column !== undefined) put(change, "column", edit.column);
      if (edit.due_at !== undefined) put(change, "due_at", edit.due_at);
      if (edit.goal_id !== undefined) {
        put(change, "goal_id", edit.goal_id);
        delete change.goal_title;
        if (edit.goal_id) {
          put(
            change,
            "goal_title",
            await weeklyGoalTitle(db, userId, edit.goal_id),
          );
        }
      }
      break;
    }
    case "task_change": {
      const field = row.field;
      if (field === "place") {
        await editPlace(db, { userId, row, edit, change, today });
        break;
      }
      if (!field) return refuse("This proposal names no task field.");
      const value = edit[field as PlannerAgentEditKey];
      if (field === "due_at" && value === null) {
        return refuse("A due date change needs a day.");
      }
      if (field === "goal_id") {
        delete change.goal_title;
        if (typeof value === "string") {
          put(change, "goal_title", await weeklyGoalTitle(db, userId, value));
        }
        change.goal_id = value ?? null;
        break;
      }
      put(change, field, value);
      break;
    }
    case "health_change":
      await editHealth(db, { userId, row, edit, change });
      break;
    case "goal_change":
      await editGoal(db, { userId, row, edit, change, today });
      break;
    default:
      return refuse("This card cannot be edited.");
  }

  const proposed: Record<string, unknown> = {};
  const edited: Record<string, unknown> = {};
  for (const key of changed) {
    proposed[key] = proposedValue(row, key);
    edited[key] = edit[key];
  }
  // A health kind switch also moves variant and minutes: record the pair.
  if (row.kind === "health_change" && changed.includes("kind")) {
    for (const key of ["variant", "minutes"] as const) {
      if (!(key in edited)) {
        proposed[key] = proposedValue(row, key);
        edited[key] = change[key] ?? null;
      }
    }
  }
  return { change, proposed, edited };
}

/** A place: the column, and top, bottom or the agent's anchor in it. */
async function editPlace(
  db: FlareMoDb,
  input: {
    userId: string;
    row: PlannerAgentActionRow;
    edit: PlannerAgentEdit;
    change: Record<string, unknown>;
    today: string;
  },
) {
  const { row, edit, change } = input;
  const original = asString(row.change.column);
  const column = edit.column ?? original;
  if (!column) return refuse("This proposal names no column.");
  const spot = edit.spot ?? (column === original ? "anchor" : "top");
  if (spot === "anchor" && column !== original) {
    return refuse("The agent's spot is in another column. Pick top or bottom.");
  }
  const board = await plannerReadBoard(db, {
    userId: input.userId,
    today: input.today,
    doneDays: plannerBoardDoneDaysMax,
  });
  const cards = (
    board.columns as Record<string, Array<{ id: string; title: string }>>
  )[column];
  if (!cards) return refuse("That column is not on the board.");
  const others = cards.filter((card) => card.id !== row.taskId);
  delete change.before_id;
  delete change.after_id;
  delete change.anchor_title;
  change.column = column;
  if (spot === "anchor") {
    const key = row.change.before_id !== undefined ? "before_id" : "after_id";
    const anchor = others.find((card) => card.id === row.change[key]);
    if (!anchor) return refuse("The task it was to sit next to is gone.");
    change[key] = anchor.id;
    change.anchor_title = anchor.title;
    return;
  }
  // An empty column has nothing to sit beside: a plain move into it.
  const anchor = spot === "top" ? others[0] : others[others.length - 1];
  if (!anchor) return;
  change[spot === "top" ? "before_id" : "after_id"] = anchor.id;
  change.anchor_title = anchor.title;
}

const variantsOf = (kind: string): readonly string[] | null =>
  kind === "training"
    ? healthTrainingVariants
    : kind === "breath"
      ? healthBreathVariants
      : null;

/** A health row to add or fix: kind, variant, minutes and day. */
async function editHealth(
  db: FlareMoDb,
  input: {
    userId: string;
    row: PlannerAgentActionRow;
    edit: PlannerAgentEdit;
    change: Record<string, unknown>;
  },
) {
  const { row, edit, change } = input;
  if (row.change.action === "fix") {
    const kind = asString(row.change.row_kind) ?? "";
    if (edit.variant !== undefined) {
      const allowed = variantsOf(kind);
      if (
        typeof edit.variant !== "string" ||
        !allowed?.includes(edit.variant)
      ) {
        refuse(`variant must be one of: ${(allowed ?? []).join(", ")}.`);
      }
      put(change, "variant", edit.variant);
    }
    if (edit.minutes !== undefined) {
      if (edit.minutes === null) refuse("Minutes must be a number of minutes.");
      put(change, "minutes", edit.minutes);
    }
    return;
  }
  const kind = edit.kind ?? asString(row.change.kind) ?? "";
  if (edit.kind !== undefined) put(change, "kind", edit.kind);
  if (edit.day !== undefined) {
    if (!healthParseDay(edit.day)) refuse("day must be a real date.");
    put(change, "day", edit.day);
  }
  if (kind === "night_out") {
    if (
      (typeof edit.variant === "string" && edit.variant) ||
      typeof edit.minutes === "number"
    ) {
      refuse("A night out has no variant or minutes.");
    }
    delete change.variant;
    delete change.minutes;
  } else {
    delete change.home_at;
    if (edit.variant !== undefined) {
      if (
        typeof edit.variant === "string" &&
        !variantsOf(kind)?.includes(edit.variant)
      ) {
        refuse(
          `variant must be one of: ${(variantsOf(kind) ?? []).join(", ")}.`,
        );
      }
      put(change, "variant", edit.variant);
    } else if (
      edit.kind !== undefined &&
      typeof change.variant === "string" &&
      !variantsOf(kind)?.includes(change.variant)
    ) {
      // The old variant belongs to the old kind.
      delete change.variant;
    }
    if (edit.minutes !== undefined) put(change, "minutes", edit.minutes);
  }
  const day = asString(change.day) ?? "";
  change.label = `${day} ${kind.replace("_", " ")}`;
  const twins = await db
    .select({ variant: healthEntry.variant })
    .from(healthEntry)
    .where(
      and(
        eq(healthEntry.userId, input.userId),
        eq(healthEntry.day, day),
        eq(healthEntry.kind, kind as "training"),
        isNull(healthEntry.deletedAt),
        eq(healthEntry.dismissed, false),
      ),
    )
    .all();
  const variant = asString(change.variant) ?? null;
  if (twins.some((twin) => twin.variant === variant)) {
    refuse(`${day} already has that ${kind.replace("_", " ")} row.`);
  }
}

/** A weekly goal's objective, and the week of a new one. */
async function editGoal(
  db: FlareMoDb,
  input: {
    userId: string;
    row: PlannerAgentActionRow;
    edit: PlannerAgentEdit;
    change: Record<string, unknown>;
    today: string;
  },
) {
  const { row, edit, change } = input;
  if (edit.pillar !== undefined) change.pillar = edit.pillar;
  if (row.change.action !== "add") return;
  const week = edit.period_start ?? asString(change.period_start) ?? "";
  if (edit.period_start !== undefined) {
    const current = plannerWeekStartOf(input.today);
    if (week < current) {
      refuse(
        `That week is past (this week starts ${current}): a goal can be added to this week or a later one.`,
      );
    }
    if (week > plannerAddDays(current, 182)) {
      refuse("That week is too far ahead: use one within about six months.");
    }
    change.period_start = week;
    change.week = week;
  }
  // The same twin check as the tool's: one title once per objective and week.
  const title = (asString(change.title) ?? "").trim().toLowerCase();
  const goals = await plannerReadWeekGoals(db, {
    userId: input.userId,
    weekStart: week,
  });
  if (
    goals.some(
      (goal) =>
        goal.pillar === change.pillar &&
        goal.title.trim().toLowerCase() === title,
    )
  ) {
    refuse(
      `The week of ${week} already has a goal with that title under that objective.`,
    );
  }
}
