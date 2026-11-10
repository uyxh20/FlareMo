import { createDb } from "@flaremo/db";
import { runSearchCatchup } from "@flaremo/domain/src/fork/search-catchup";
import { createEmbeddingProvider, createVectorIndex } from "../embedding";
import type { FlareMoEnv } from "../env";

/**
 * Cron for the search catch-up (fork-owned; packages/domain/src/fork/
 * search-catchup.ts). It must match an entry in wrangler.jsonc.example's
 * triggers.crons; the dev config keeps it too.
 */
export const FORK_SEARCH_CATCHUP_CRON = "*/10 * * * *";

/**
 * The scheduled handler's fork hook: runs one small catch-up batch and claims
 * the event, so the daily maintenance never runs on this cron. Never throws.
 */
export async function forkSearchCatchupScheduled(
  controller: { cron: string },
  env: FlareMoEnv,
): Promise<boolean> {
  if (controller.cron !== FORK_SEARCH_CATCHUP_CRON) return false;
  try {
    const result = await runSearchCatchup(createDb(env.DB), {
      provider: createEmbeddingProvider(env),
      memosIndex: createVectorIndex(env, "memo"),
      memoriesIndex: createVectorIndex(env, "memory"),
    });
    if (result.indexed || result.failed) {
      console.log(JSON.stringify({ message: "Search catch-up", result }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Search catch-up failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }
  return true;
}
