import type { PlannerAskResponse, PlannerOkResponse } from "@flaremo/contracts";
import { apiRequest } from "@/api/client";

// Ask my diary over HTTP (fork-owned add-on, docs/fork-general-agent.md): the
// routes in apps/worker/src/routes/planner-agent-api.ts. Kept apart from
// goals-api.ts because the sidebar's button loads with every page.

const ASK = "/api/app/planner/ask";

/** A conversation, or the latest one; asks the agent's session once if waiting. */
export function plannerFetchAsk(today: string, conversation: string | null) {
  const query = new URLSearchParams({
    today,
    ...(conversation ? { conversation } : {}),
  });
  return apiRequest<PlannerAskResponse>(`${ASK}?${query}`);
}

/** Asks a question; without a conversation it starts a new one. */
export function plannerAskRequest(input: {
  today: string;
  conversation?: string;
  text: string;
}) {
  return apiRequest<PlannerAskResponse>(ASK, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Puts a conversation down: its agent session ends. */
export function plannerEndAskRequest(conversation: string) {
  return apiRequest<PlannerOkResponse>(
    `${ASK}/${encodeURIComponent(conversation)}/end`,
    { method: "POST", body: "{}" },
  );
}
