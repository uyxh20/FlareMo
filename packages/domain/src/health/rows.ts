import type { HealthEntryDto } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { eq } from "drizzle-orm";
import {
  type HealthEntryRow,
  healthEntry,
  healthEntryEvent,
} from "@flaremo/db/src/schema/fork-health";

// Row helpers shared by the health tracker's domain modules (fork-owned add-on,
// docs/fork-health-tracker.md): the wire shape of a row, the snapshot an event
// stores, and the one place that builds a row's write together with its event.
// Every write to health_entry goes through `healthWriteStatements`, so an event
// can never be forgotten (the append-only history is the point of the table).

export type { HealthEntryRow };

export function healthToDto(row: HealthEntryRow): HealthEntryDto {
  return {
    id: row.id,
    kind: row.kind,
    day: row.day,
    variant: row.variant,
    minutes: row.minutes,
    home_at: row.homeAt,
    units: row.units,
    bender: row.bender,
    needs_check: row.needsCheck,
    feel: row.feel,
    source: row.source,
    memo_id: row.memoId,
    edited: row.edited,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** What an event keeps of a row: everything the owner or the reader can change. */
export function healthSnapshot(row: HealthEntryRow): string {
  return JSON.stringify({
    kind: row.kind,
    day: row.day,
    variant: row.variant,
    minutes: row.minutes,
    homeAt: row.homeAt,
    units: row.units,
    bender: row.bender,
    needsCheck: row.needsCheck,
    feel: row.feel,
    dismissed: row.dismissed,
    edited: row.edited,
    deletedAt: row.deletedAt,
  });
}

export type HealthEventAction =
  | "create"
  | "update"
  | "dismiss"
  | "delete"
  | "restore";

/** One change to a row: a new row, or `before` becoming `after`. */
export type HealthWrite =
  | { action: "create"; after: HealthEntryRow }
  | {
      action: Exclude<HealthEventAction, "create">;
      before: HealthEntryRow;
      after: HealthEntryRow;
    };

/**
 * The statements for one change: the row write and its event. They belong in
 * the same D1 batch. A create is a plain insert (the unique index on
 * memo_id + kind makes a racing duplicate fail the whole batch, event
 * included); the others update by id and owner.
 */
export function healthWriteStatements(
  db: FlareMoDb,
  write: HealthWrite,
  at: string,
) {
  const after = write.after;
  const rowStatement =
    write.action === "create"
      ? db.insert(healthEntry).values(after)
      : db
          .update(healthEntry)
          .set({
            day: after.day,
            variant: after.variant,
            minutes: after.minutes,
            homeAt: after.homeAt,
            units: after.units,
            bender: after.bender,
            needsCheck: after.needsCheck,
            feel: after.feel,
            dismissed: after.dismissed,
            edited: after.edited,
            updatedAt: after.updatedAt,
            deletedAt: after.deletedAt,
          })
          .where(eq(healthEntry.id, after.id));
  const eventStatement = db.insert(healthEntryEvent).values({
    id: crypto.randomUUID(),
    entryId: after.id,
    userId: after.userId,
    action: write.action,
    beforeJson: write.action === "create" ? null : healthSnapshot(write.before),
    afterJson: healthSnapshot(after),
    at,
  });
  return [rowStatement, eventStatement];
}
