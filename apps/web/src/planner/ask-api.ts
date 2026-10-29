import type {
  PlannerAgentActionResponse,
  PlannerAskResponse,
  PlannerOkResponse,
} from "@flaremo/contracts";
import { apiRequest } from "@/api/client";

// Ask my diary over HTTP (fork-owned add-on, docs/fork-general-agent.md): the
// routes in apps/worker/src/routes/planner-agent-api.ts. Kept apart from
// goals-api.ts because the sidebar's button loads with every page. A task's
// own chat (the task panel's agent drawer) uses the same routes with `task`.

const ASK = "/api/app/planner/ask";
const ACTIONS = "/api/app/planner/agent/actions";

/**
 * A conversation, or the latest one (of the task's own chats when `task` is
 * given, else of the global chat); asks the agent's session once if waiting.
 */
export function plannerFetchAsk(
  today: string,
  conversation: string | null,
  task: string | null = null,
) {
  const query = new URLSearchParams({
    today,
    ...(conversation ? { conversation } : {}),
    ...(task ? { task } : {}),
  });
  return apiRequest<PlannerAskResponse>(`${ASK}?${query}`);
}

/**
 * Asks a question; without a conversation it starts a new one, held from
 * `task` when given.
 */
export function plannerAskRequest(input: {
  today: string;
  conversation?: string;
  task?: string;
  text: string;
}) {
  return apiRequest<PlannerAskResponse>(ASK, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Accepts a proposed action (the accept is what writes it) or dismisses it. */
export function plannerSettleActionRequest(
  id: string,
  input: { state: "accepted" | "dismissed"; today: string },
) {
  return apiRequest<PlannerAgentActionResponse>(
    `${ACTIONS}/${encodeURIComponent(id)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** Puts a conversation down: its agent session ends. */
export function plannerEndAskRequest(conversation: string) {
  return apiRequest<PlannerOkResponse>(
    `${ASK}/${encodeURIComponent(conversation)}/end`,
    { method: "POST", body: "{}" },
  );
}
