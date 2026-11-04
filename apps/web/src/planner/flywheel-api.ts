import type { PlannerFlywheelResponse } from "@flaremo/contracts";
import { apiRequest } from "@/api/client";

// The flywheel over HTTP (fork-owned add-on, docs/fork-flywheel.md): the
// routes listed in packages/contracts/src/planner-flywheel.ts. `week` is the
// Monday of the week the review looks back on; every route answers with that
// week's scorecard card.

const flywheelPath = (week: string, rest = "") =>
  `/api/app/planner/flywheel/${encodeURIComponent(week)}${rest}`;

/** The scorecard card for the reviewed week. */
export function plannerFetchFlywheel(week: string, today: string) {
  return apiRequest<PlannerFlywheelResponse>(
    `${flywheelPath(week)}?${new URLSearchParams({ today })}`,
  );
}

/** The owner's note to the agent for the week, or null to pass. */
export function plannerSaveTuningNoteRequest(
  week: string,
  note: string | null,
) {
  return apiRequest<PlannerFlywheelResponse>(flywheelPath(week, "/note"), {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

/** Asks the model for a change to the agent's standing instructions. */
export function plannerProposeTuningRequest(week: string, today: string) {
  return apiRequest<PlannerFlywheelResponse>(
    flywheelPath(week, "/tuning/propose"),
    { method: "POST", body: JSON.stringify({ today }) },
  );
}

/** Accepts (with edits) or dismisses a proposal, or keeps or rolls back a version. */
export function plannerSettleTuningRequest(
  week: string,
  id: string,
  decision: "accept" | "dismiss" | "keep" | "roll_back",
  instructions?: string,
) {
  return apiRequest<PlannerFlywheelResponse>(
    flywheelPath(week, `/tuning/${encodeURIComponent(id)}`),
    {
      method: "POST",
      body: JSON.stringify(
        instructions === undefined ? { decision } : { decision, instructions },
      ),
    },
  );
}
