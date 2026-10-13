import {
  type HealthEntryDto,
  type HealthPatchEntryInput,
  type HealthSetTargetsInput,
  healthBreathVariants,
  healthNightUnitsFor,
  healthTrainingVariants,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { healthEntry, healthTarget } from "@flaremo/db/src/schema/fork-health";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import {
  type HealthEntryRow,
  healthToDto,
  healthWriteStatements,
} from "./rows";

// The owner's hand on the health tracker (fork-owned add-on,
// docs/fork-health-tracker.md): fixing a row, removing a label, setting a
// target. A fix marks the row `edited`, which a re-read of the diary respects; a
// dismissal marks it `dismissed`, which a re-read never undoes. Both write their
// event in the same batch. Nothing is ever hard-deleted.

type BatchItems = Parameters<FlareMoDb["batch"]>[0];

async function readOwned(
  db: FlareMoDb,
  userId: string,
  entryId: string,
): Promise<HealthEntryRow> {
  const row = await db
    .select()
    .from(healthEntry)
    .where(
      and(
        eq(healthEntry.id, entryId),
        eq(healthEntry.userId, userId),
        isNull(healthEntry.deletedAt),
      ),
    )
    .get();
  if (!row) throw new NotFoundError("Health entry not found");
  return row;
}

/**
 * The owner fixes a row. `home_at` recomputes the units and the bender flag
 * from the time; clearing it asks again unless the night is a bender anyway.
 * `variant` must belong to the row's kind. The row becomes `edited`, and a night
 * that now has a home time stops needing a check.
 */
export async function healthPatchEntry(
  db: FlareMoDb,
  input: {
    userId: string;
    entryId: string;
    patch: HealthPatchEntryInput;
    now?: Date;
  },
): Promise<HealthEntryDto> {
  const before = await readOwned(db, input.userId, input.entryId);
  const { patch } = input;
  const at = (input.now ?? new Date()).toISOString();
  const after: HealthEntryRow = {
    ...before,
    edited: true,
    updatedAt: at,
  };

  if (patch.variant !== undefined) {
    const allowed: readonly string[] | null =
      before.kind === "training"
        ? healthTrainingVariants
        : before.kind === "breath"
          ? healthBreathVariants
          : null;
    if (!allowed) {
      throw new ValidationError("A night out has no variant.");
    }
    if (patch.variant !== null && !allowed.includes(patch.variant)) {
      throw new ValidationError(
        `variant must be one of: ${allowed.join(", ")}.`,
      );
    }
    after.variant = patch.variant;
  }
  if (patch.minutes !== undefined) {
    if (before.kind === "night_out") {
      throw new ValidationError("A night out has no minutes.");
    }
    after.minutes = patch.minutes;
  }
  if (patch.day !== undefined) after.day = patch.day;
  if (patch.home_at !== undefined) {
    if (before.kind !== "night_out") {
      throw new ValidationError("Only a night out has a home time.");
    }
    if (patch.home_at === null) {
      after.homeAt = null;
      after.units = before.bender ? 1 : null;
      after.needsCheck = !before.bender;
    } else {
      const counted = healthNightUnitsFor(patch.home_at);
      if (!counted) throw new ValidationError("home_at must be HH:MM.");
      after.homeAt = patch.home_at;
      after.units = counted.units;
      after.bender = counted.bender;
      after.needsCheck = false;
    }
  }

  const statements = healthWriteStatements(
    db,
    { action: "update", before, after },
    at,
  );
  await db.batch(statements as unknown as BatchItems);
  return healthToDto(after);
}

/**
 * The × on a label: the row stops counting and a re-read of the diary leaves it
 * dismissed. Dismissing twice is harmless.
 */
export async function healthDismissEntry(
  db: FlareMoDb,
  input: { userId: string; entryId: string; now?: Date },
): Promise<HealthEntryDto> {
  const before = await readOwned(db, input.userId, input.entryId);
  if (before.dismissed) return healthToDto(before);
  const at = (input.now ?? new Date()).toISOString();
  const after: HealthEntryRow = { ...before, dismissed: true, updatedAt: at };
  await db.batch(
    healthWriteStatements(
      db,
      { action: "dismiss", before, after },
      at,
    ) as unknown as BatchItems,
  );
  return healthToDto(after);
}

/** Saves the owner's targets; a target left out keeps its value or default. */
export async function healthSetTargets(
  db: FlareMoDb,
  input: { userId: string } & HealthSetTargetsInput & { now?: Date },
): Promise<void> {
  const at = (input.now ?? new Date()).toISOString();
  const statements = input.targets.map((target) =>
    db
      .insert(healthTarget)
      .values({
        userId: input.userId,
        kind: target.kind,
        period: target.period,
        amount: target.amount,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [healthTarget.userId, healthTarget.kind, healthTarget.period],
        set: { amount: target.amount, updatedAt: at },
      }),
  );
  await db.batch(statements as unknown as BatchItems);
}
