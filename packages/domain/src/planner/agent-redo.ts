import type { PlannerAgentActionDto } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { plannerAgentAction } from "@flaremo/db/src/schema/planner";
import { and, eq, sql } from "drizzle-orm";
import { plannerAgentActionToDto, plannerAgentFindAction } from "./agent-store";
import { plannerRecordEvents } from "./flywheel";

// The one-line redo (fork-owned add-on, docs/fork-general-agent.md, "Redo"):
// the owner tells the agent what to change about a card, the card's open rows
// are dismissed with the reason `redo` (kept, never deleted, so the flywheel
// sees them), and the agent gets a new turn in the same conversation with the
// note and the dismissed rows, so it redraws them as a new card.

/** The reason a redo leaves on the rows it dismissed (`change.settled_reason`). */
export const PLANNER_AGENT_REDO_REASON = "redo";

/** Keys of `change` the agent needs no copy of: the record's old values and bookkeeping. */
const LEFT_OUT = new Set([
  "was",
  "before",
  "proposed",
  "edited",
  "settled_reason",
  "starter",
  "preview",
  "related_preview",
  "column_ranks",
  "written_ranks",
]);

/** A value cut short, so a long text does not swamp the turn. */
function compact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 12).map(compact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, each]) => [
        key,
        compact(each),
      ]),
    );
  }
  return value;
}

/**
 * Dismisses the open rows among `ids` that belong to the conversation, marking
 * each with the redo reason. Returns the rows it dismissed, in the order given;
 * a row already settled, or of another conversation, is left alone.
 */
export async function plannerAgentRedoDismiss(
  db: FlareMoDb,
  input: {
    userId: string;
    conversationId: string;
    ids: readonly string[];
    now?: Date;
  },
): Promise<PlannerAgentActionDto[]> {
  const settledAt = (input.now ?? new Date()).toISOString();
  const out: PlannerAgentActionDto[] = [];
  for (const id of new Set(input.ids)) {
    const row = await plannerAgentFindAction(db, { userId: input.userId, id });
    if (
      !row ||
      row.conversationId !== input.conversationId ||
      row.state !== "open"
    ) {
      continue;
    }
    const result = await db
      .update(plannerAgentAction)
      .set({
        state: "dismissed",
        settledAt,
        shownAt: sql`coalesce(${plannerAgentAction.shownAt}, ${settledAt})`,
        change: { ...row.change, settled_reason: PLANNER_AGENT_REDO_REASON },
      })
      .where(
        and(
          eq(plannerAgentAction.userId, input.userId),
          eq(plannerAgentAction.id, id),
          eq(plannerAgentAction.state, "open"),
        ),
      );
    if (result.meta?.changes !== 1) continue;
    const after = await plannerAgentFindAction(db, {
      userId: input.userId,
      id,
    });
    if (after) out.push(plannerAgentActionToDto(after));
  }
  return out;
}

/**
 * Opens again rows a redo dismissed, when the new turn could not be sent: the
 * card is as it was, and the owner can try again.
 */
export async function plannerAgentRedoRestore(
  db: FlareMoDb,
  input: { userId: string; actions: readonly PlannerAgentActionDto[] },
): Promise<void> {
  for (const action of input.actions) {
    const { settled_reason: _reason, ...change } = action.change;
    await db
      .update(plannerAgentAction)
      .set({ state: "open", settledAt: null, change })
      .where(
        and(
          eq(plannerAgentAction.userId, input.userId),
          eq(plannerAgentAction.id, action.id),
          eq(plannerAgentAction.state, "dismissed"),
        ),
      )
      .run();
  }
}

/**
 * The new turn the agent gets: the owner's note and a compact list of the
 * dismissed proposals (id, kind, field, values), so it redraws them.
 */
export function plannerAgentRedoQuestion(input: {
  ownerName: string;
  note: string;
  actions: readonly PlannerAgentActionDto[];
}): string {
  const lines = input.actions.map((action) => {
    const values = Object.fromEntries(
      Object.entries(action.change)
        .filter(([key]) => !LEFT_OUT.has(key))
        .map(([key, value]) => [key, compact(value)]),
    );
    return `- ${action.id} ${action.kind}${action.field ? ` (${action.field})` : ""}${action.task_id ? ` task ${action.task_id}` : ""}${action.entry_id ? ` entry ${action.entry_id}` : ""}: ${JSON.stringify(values)}`;
  });
  return [
    `Redo. ${input.ownerName} sent back your last card with this note: "${input.note}"`,
    `These ${input.actions.length} proposals are dismissed (id, kind, values):`,
    ...lines,
    `Propose them again as the note asks, as one new card: change what the note says, leave out what it drops, and keep the rest as it was. The same rules apply (flag goals and entries, never write their words). Answer in one short sentence.`,
  ].join("\n");
}

/** The flywheel's line for a redo: counts and kinds only, never words. */
export async function plannerAgentRecordRedo(
  db: FlareMoDb,
  input: {
    userId: string;
    conversationId: string;
    actions: readonly PlannerAgentActionDto[];
    now?: Date;
  },
): Promise<void> {
  await plannerRecordEvents(
    db,
    [
      {
        userId: input.userId,
        kind: "proposal.redo",
        subject: "proposal",
        subjectId: input.conversationId,
        origin: "proposal",
        data: {
          count: input.actions.length,
          kinds: [...new Set(input.actions.map((action) => action.kind))]
            .sort()
            .join(","),
        },
      },
    ],
    input.now,
  );
}
