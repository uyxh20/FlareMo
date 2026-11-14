import {
  type HealthEntryDto,
  type HealthPatchEntryInput,
  healthBreathVariants,
  healthDefaultBreathMinutes,
  healthIsBuiltinKind,
  healthKinds,
  healthNightUnitsFor,
  healthParseDay,
  healthTrainingVariants,
  healthWellnessVariants,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { healthEntry } from "@flaremo/db/src/schema/fork-health";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import {
  type HealthEntryRow,
  healthSnapshot,
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

/** The live row of this owner with this id, or null: what a fix compares to. */
export async function healthFindEntry(
  db: FlareMoDb,
  input: { userId: string; entryId: string },
): Promise<HealthEntryRow | null> {
  return readOwned(db, input.userId, input.entryId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
}

/**
 * The owner (or the owner's accepted proposal) adds a row the diary missed: a
 * session or a night with no memo behind it. The row is `source: "manual"`,
 * `memo_id` null and `edited`, so no re-read of the diary matches, changes or
 * removes it (the unique index on memo_id + kind only covers memo rows). A
 * night with a home time gets its units and bender flag from it; without one it
 * waits for the time, like a night the diary read.
 */
export async function healthCreateEntry(
  db: FlareMoDb,
  input: {
    userId: string;
    day: string;
    kind: string;
    variant?: string | null;
    minutes?: number | null;
    homeAt?: string | null;
    now?: Date;
  },
): Promise<HealthEntryDto> {
  const { kind } = input;
  if (!healthIsBuiltinKind(kind)) {
    throw new ValidationError(
      `kind must be one of: ${healthKinds.join(", ")}.`,
    );
  }
  if (!healthParseDay(input.day)) {
    throw new ValidationError("day must be a real YYYY-MM-DD date.");
  }
  const variant = input.variant ?? null;
  const allowed: readonly string[] | null =
    kind === "training"
      ? healthTrainingVariants
      : kind === "breath"
        ? healthBreathVariants
        : kind === "wellness"
          ? healthWellnessVariants
          : null;
  if (variant !== null && !allowed) {
    throw new ValidationError("A night out has no variant.");
  }
  if (variant !== null && allowed && !allowed.includes(variant)) {
    throw new ValidationError(`variant must be one of: ${allowed.join(", ")}.`);
  }
  if (input.minutes != null && kind === "night_out") {
    throw new ValidationError("A night out has no minutes.");
  }
  if (input.homeAt != null && kind !== "night_out") {
    throw new ValidationError("Only a night out has a home time.");
  }
  const counted = input.homeAt ? healthNightUnitsFor(input.homeAt) : null;
  if (input.homeAt && !counted) {
    throw new ValidationError("home_at must be HH:MM.");
  }
  const at = (input.now ?? new Date()).toISOString();
  const after: HealthEntryRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    kind,
    day: input.day,
    variant,
    minutes:
      kind === "night_out"
        ? null
        : (input.minutes ??
          (kind === "breath" ? healthDefaultBreathMinutes : null)),
    homeAt: counted ? (input.homeAt ?? null) : null,
    units: counted ? counted.units : null,
    bender: counted?.bender ?? false,
    needsCheck: kind === "night_out" && !counted,
    feel: null,
    source: "manual",
    memoId: null,
    dismissed: false,
    edited: true,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  await db.batch(
    healthWriteStatements(
      db,
      { action: "create", after },
      at,
    ) as unknown as BatchItems,
  );
  return healthToDto(after);
}

/**
 * Puts a row back as it was before a change of the diary agent's, as a new
 * `restore` event (or a `delete` event when `before` is null: the row was made
 * by the agent, and is soft-deleted, never removed). Refused when the row is
 * not as that change left it (`accepted`, a snapshot as `healthSnapshot` writes
 * it), so a later fix of the owner's is not overwritten unseen. The restored
 * values include `edited`, so a row the diary had read goes back to being read
 * again by the nightly sync.
 */
export async function healthRevertEntry(
  db: FlareMoDb,
  input: {
    userId: string;
    entryId: string;
    before: Record<string, unknown> | null;
    accepted: Record<string, unknown>;
    now?: Date;
  },
): Promise<HealthEntryDto> {
  const row = await readOwned(db, input.userId, input.entryId).catch(
    (error: unknown) => {
      if (error instanceof NotFoundError) {
        throw new ValidationError(
          "The health row is gone, so this cannot be put back.",
        );
      }
      throw error;
    },
  );
  if (healthSnapshot(row) !== JSON.stringify(input.accepted)) {
    throw new ValidationError(
      "The health row changed since, so this cannot be put back.",
    );
  }
  const at = (input.now ?? new Date()).toISOString();
  const { before } = input;
  if (before === null) {
    const after: HealthEntryRow = { ...row, deletedAt: at, updatedAt: at };
    await db.batch(
      healthWriteStatements(
        db,
        { action: "delete", before: row, after },
        at,
      ) as unknown as BatchItems,
    );
    return healthToDto(after);
  }
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  const num = (value: unknown) => (typeof value === "number" ? value : null);
  const after: HealthEntryRow = {
    ...row,
    day: str(before.day) ?? row.day,
    variant: str(before.variant),
    minutes: num(before.minutes),
    homeAt: str(before.homeAt),
    units: num(before.units),
    bender: before.bender === true,
    needsCheck: before.needsCheck === true,
    feel: str(before.feel),
    dismissed: before.dismissed === true,
    edited: before.edited === true,
    deletedAt: str(before.deletedAt),
    updatedAt: at,
  };
  await db.batch(
    healthWriteStatements(
      db,
      { action: "restore", before: row, after },
      at,
    ) as unknown as BatchItems,
  );
  return healthToDto(after);
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
          : before.kind === "wellness"
            ? healthWellnessVariants
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
