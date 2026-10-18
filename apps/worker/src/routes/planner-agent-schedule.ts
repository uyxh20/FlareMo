import { healthLocalMoment, plannerWeekCode } from "@flaremo/contracts";
import {
  getFlaremoUserByAuthUserId,
  getOwnerAuthUserId,
  isActiveTeamMember,
} from "@flaremo/domain";
import {
  PLANNER_DIARY_CHARS,
  plannerAgentFindOpenRun,
  plannerAgentOpeningMessage,
  plannerAgentWeekKey,
  plannerReadReviewContext,
  plannerReviewStatus,
} from "@flaremo/domain/src/planner";
import { getFlareMoDb } from "../context";
import type { FlareMoEnv } from "../env";
import { plannerAgent, plannerStartAgent } from "./planner-agent";

// The Sunday prep (fork-owned add-on, docs/fork-general-agent.md): at noon in
// Copenhagen the agent starts the owner's weekly review and answers its
// opening, so the review is ready when they open it. The opening route picks
// the session up (planner-goals-api.ts). Nothing happens when the look back is
// done already, a review session is open, or the month's cap is spent. Reached
// from fork/agent-schedule.ts.

export type PlannerSundayPrep =
  | "prepared"
  | "no agent"
  | "not noon"
  | "no owner"
  | "done already"
  | "open already";

export async function plannerAgentSundayPrep(
  env: FlareMoEnv,
  scheduledTime: number,
): Promise<PlannerSundayPrep> {
  const agent = plannerAgent(env);
  if (!agent) return "no agent";
  const now = new Date(scheduledTime);
  const local = healthLocalMoment(now);
  if (local.hour !== 12) return "not noon";
  const db = getFlareMoDb(env);
  const authUserId = await getOwnerAuthUserId(db);
  const user = authUserId
    ? await getFlaremoUserByAuthUserId(db, authUserId)
    : null;
  if (!authUserId || !user || !isActiveTeamMember(user)) return "no owner";
  const today = local.day;
  const status = await plannerReviewStatus(db, { userId: user.id, today });
  if (status.look_back_done) return "done already";
  const weekStart = status.review_week;
  const ownerKey = plannerAgentWeekKey(weekStart);
  if (await plannerAgentFindOpenRun(db, { userId: user.id, ownerKey })) {
    return "open already";
  }
  const review = await plannerReadReviewContext(db, {
    userId: user.id,
    ownerName: user.name,
    weekStart,
    today,
    diaryChars: PLANNER_DIARY_CHARS,
  });
  await plannerStartAgent(agent, {
    db,
    env,
    user,
    authUserId,
    job: "review",
    ownerKey,
    step: "opening",
    message: plannerAgentOpeningMessage(review),
    title: `Weekly review ${plannerWeekCode(weekStart)}`,
    startedBy: "schedule",
    now,
  });
  return "prepared";
}
