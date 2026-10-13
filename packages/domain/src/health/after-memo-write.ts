import type { FlareMoDb } from "@flaremo/db";

// The one function the memo write path calls (fork-owned add-on,
// docs/fork-health-tracker.md). packages/domain/src/memos-write.ts has a single
// line per write that names the saved memo here.
//
// Two promises, both load-bearing:
//   - a health failure never fails a memo save: every error is caught and logged;
//   - the parser and the sync are imported on first use, so the memo write path
//     carries only this small file, not the tracker.

let warnedMissingTables = false;

/** The message of an error and of everything it wraps (Drizzle hides D1's reason in `cause`). */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" | ");
}

/**
 * Reads the just-saved memo (create or update) for health entries. Never
 * throws. A database without the health tables (the migration has not been
 * applied yet) is logged once per isolate, not on every save.
 */
export async function forkHealthSyncMemo(
  db: FlareMoDb,
  memoId: string,
): Promise<void> {
  try {
    const { healthSyncMemoById } = await import("./sync");
    await healthSyncMemoById(db, memoId);
  } catch (error) {
    const message = messageChain(error);
    if (/no such table/i.test(message)) {
      if (!warnedMissingTables) {
        warnedMissingTables = true;
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "Health tracker tables are missing; apply migration 9010",
          }),
        );
      }
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Health sync of a saved memo failed",
          memoId,
          error: message,
        }),
      );
    }
  }
}
