import {
  PLANNER_AGENT_SKIP_REASON,
  type PlannerAgentActionDto,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { plannerAgentAction } from "@flaremo/db/src/schema/planner";
import { and, eq } from "drizzle-orm";
import { plannerAgentActionToDto, plannerAgentFindAction } from "./agent-store";
import { plannerAgentFromDiary } from "./diary-todos";
import { plannerRecordEvents } from "./flywheel";

// Skips on a card (fork-owned add-on, docs/fork-general-agent.md and
// docs/fork-flywheel.md, learning log step 2). When the owner accepts the
// ticked rows of a card and leaves some unticked, the unticked rows are
// dismissed with the reason `skipped`: the rest of the card was right, this
// row was not. A dismiss of the whole card stays a plain dismiss. The row
// keeps the reason (`change.settled_reason`), the scorecard counts it
// (`proposals_skipped`), and the log gets one `proposal.skipped` line with the
// row's kind, never its words.

/**
 * Marks a dismissed action as skipped and logs it. Called right after the
 * dismiss settled it; a row that is no longer dismissed is left alone.
 */
export async function plannerAgentMarkSkipped(
  db: FlareMoDb,
  input: { userId: string; action: PlannerAgentActionDto; now?: Date },
): Promise<PlannerAgentActionDto> {
  const { action } = input;
  if (action.state !== "dismissed") return action;
  await db
    .update(plannerAgentAction)
    .set({
      change: { ...action.change, settled_reason: PLANNER_AGENT_SKIP_REASON },
    })
    .where(
      and(
        eq(plannerAgentAction.userId, input.userId),
        eq(plannerAgentAction.id, action.id),
        eq(plannerAgentAction.state, "dismissed"),
      ),
    )
    .run();
  await plannerRecordEvents(
    db,
    [
      {
        userId: input.userId,
        kind: "proposal.skipped",
        subject: "proposal",
        subjectId: action.id,
        origin: "proposal",
        proposalId: action.id,
        data: {
          action_kind: action.kind,
          field: action.field,
          from_diary: plannerAgentFromDiary(action.change),
          starter:
            typeof action.change.starter === "string"
              ? action.change.starter
              : null,
        },
      },
    ],
    input.now,
  );
  const row = await plannerAgentFindAction(db, {
    userId: input.userId,
    id: action.id,
  });
  return row ? plannerAgentActionToDto(row) : action;
}
