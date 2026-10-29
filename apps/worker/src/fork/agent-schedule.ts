import type { FlareMoDb } from "@flaremo/db";
import type { FlareMoEnv } from "../env";

// The general agent's scheduled work (fork-owned, docs/fork-general-agent.md),
// reached from two one-line hook-ins: index.ts's scheduled handler hands this
// file the Sunday cron, and scheduled-tasks.ts calls the nightly sweep. Both
// load the agent's client only when they run, so the Worker's startup and the
// nightly maintenance stay as they were without the agent.

/**
 * Sunday at 10:00 and 11:00 UTC: one of the two is noon in Copenhagen, summer
 * or winter, and the prep runs on that one (routes/planner-agent-schedule.ts).
 */
export const FORK_AGENT_SUNDAY_CRON = "0 10,11 * * SUN";

/**
 * Runs the agent's own cron and returns true, or returns false for any other
 * cron, which the nightly maintenance handles as before. Never throws.
 */
export async function forkAgentScheduled(
  controller: { cron: string; scheduledTime: number },
  env: FlareMoEnv,
): Promise<boolean> {
  if (controller.cron !== FORK_AGENT_SUNDAY_CRON) return false;
  try {
    const { plannerAgentSundayPrep } = await import(
      "../routes/planner-agent-schedule"
    );
    const result = await plannerAgentSundayPrep(env, controller.scheduledTime);
    console.log(
      JSON.stringify({ message: "General agent Sunday prep", result }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "General agent Sunday prep failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }
  return true;
}

/**
 * The nightly maintenance's call: ends agent sessions no step has touched for
 * twelve hours, and expires proposed actions nobody acted on in seven days.
 * Never throws.
 */
export async function forkAgentNightly(
  env: FlareMoEnv,
  db: FlareMoDb,
  now: Date,
): Promise<void> {
  try {
    const { plannerAgent, plannerSweepAgentRuns } = await import(
      "../routes/planner-agent"
    );
    const { plannerAgentExpireActions } = await import(
      "@flaremo/domain/src/planner"
    );
    const ended = await plannerSweepAgentRuns(plannerAgent(env), db, now);
    const expired = await plannerAgentExpireActions(db, now);
    if (ended > 0 || expired > 0) {
      console.log(
        JSON.stringify({ message: "General agent sweep", ended, expired }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "General agent sweep failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }
}

/**
 * Nightly dreaming is off where the general agent runs: the agent proposes
 * memories from the reviews instead. The conflict patrol still runs.
 */
export function forkAgentReplacesDreaming(env: FlareMoEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() && env.FLAREMO_AGENT?.trim());
}
