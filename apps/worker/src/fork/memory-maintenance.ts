import type { FlareMoDb } from "@flaremo/db";
import { runMemoryLedgerMaintenance } from "@flaremo/domain/src/memory";
import type { FlareMoEnv } from "../env";
import { runMemoryConflictPatrol, runMemoryDreaming } from "../memory-dreaming";

// Fork-owned (docs/fork-customizations.md). Upstream removed the memory layer
// in v0.27; this fork keeps it (the weekly review and Ask read and propose
// memories). This is the nightly part upstream's scheduled maintenance used to
// run inline: ledger upkeep (stale conjectures retire, expired rows leave the
// index), then dreaming and the conflict patrol. scheduled-tasks.ts runs it as
// one maintenance step, before the embedding outbox.

export async function forkMemoryLedgerStep(
  env: FlareMoEnv,
  db: FlareMoDb,
  scheduledTime: number,
  options: { skipDreaming: boolean },
): Promise<void> {
  const now = new Date(scheduledTime);
  await runMemoryLedgerMaintenance(db, now);
  // The general agent proposes memories itself where it runs.
  if (options.skipDreaming) return;
  try {
    const dreaming = await runMemoryDreaming(env, now);
    if (dreaming.proposals > 0) {
      console.log(
        JSON.stringify({ message: "memory dreaming proposals", ...dreaming }),
      );
    }
    const patrol = await runMemoryConflictPatrol(env, now);
    if (patrol.proposals > 0) {
      console.log(
        JSON.stringify({
          message: "memory conflict patrol proposals",
          ...patrol,
        }),
      );
    }
  } catch (error) {
    // Dreaming must never take the whole maintenance window down.
    console.error(
      JSON.stringify({
        message: "memory dreaming failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
