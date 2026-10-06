import type {
  PlannerBoardResponse,
  PlannerCommentResponse,
  PlannerCreateTaskInput,
  PlannerCreateTaskResponse,
  PlannerDeleteCommentResponse,
  PlannerRolloverResponse,
  PlannerTaskDetailResponse,
  PlannerTaskHistoryResponse,
  PlannerTaskPlanResponse,
  PlannerTreeResponse,
  PlannerUpdateTaskInput,
} from "@flaremo/contracts";
import type { Task } from "@/api";
import { ApiError, apiRequest } from "@/api/client";
import { errorMessage } from "@/lib/error";
import { stripResourceName } from "@/lib/utils";

// The planning cockpit's HTTP client (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4 and 5): a thin typed
// layer over `apiRequest`, with the request and response types straight from
// @flaremo/contracts. It adds nothing of its own to the wire: the server owns
// every rule, and a response is trusted the way the rest of the web client
// trusts its DTOs.
//
// `today` is the client's local date (`YYYY-MM-DD`). The server accepts it only
// within one day of its own UTC date and answers 400 otherwise.

const PLANNER_API = "/api/app/planner";

// Task ids are namespaced ("tasks/<uuid>"). The path segment carries the bare id,
// URL-encoded, exactly like the upstream task client: an encoded slash would be
// one more thing for a proxy to normalise.
function taskSegment(taskId: string) {
  return encodeURIComponent(stripResourceName(taskId, "tasks"));
}

export function plannerFetchBoard(input: {
  today: string;
  includeDropped?: boolean;
  doneDays?: number;
}) {
  const query = new URLSearchParams({ today: input.today });
  if (input.includeDropped) query.set("include_dropped", "true");
  if (input.doneDays !== undefined) {
    query.set("done_days", String(input.doneDays));
  }
  return apiRequest<PlannerBoardResponse>(`${PLANNER_API}/board?${query}`);
}

/** Syncs the history, then carries unfinished plans into the current period. */
export function plannerRolloverRequest(today: string) {
  return apiRequest<PlannerRolloverResponse>(`${PLANNER_API}/rollover`, {
    method: "POST",
    body: JSON.stringify({ today }),
  });
}

export function plannerCreateTaskRequest(input: PlannerCreateTaskInput) {
  return apiRequest<PlannerCreateTaskResponse>(`${PLANNER_API}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Column moves, plans, drops and task fields in one request. `column` and
 * `plan` together are a 400: a column move sets the plan itself.
 */
export function plannerUpdateTaskRequest(
  taskId: string,
  input: PlannerUpdateTaskInput,
) {
  return apiRequest<PlannerTaskPlanResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

/**
 * Everything the task panel shows for one task: the whole task (notes included),
 * its plan with the effort estimate, its goal and the goal's path, and its
 * comments. A task that is gone is a 404.
 */
export function plannerFetchTaskDetail(taskId: string) {
  return apiRequest<PlannerTaskDetailResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}`,
  );
}

/** Newest first. The server syncs the archive before it answers. */
export function plannerFetchTaskHistory(taskId: string) {
  return apiRequest<PlannerTaskHistoryResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}/history`,
  );
}

/** The goal tree: every live project with its parent, for the goals' paths. */
export function plannerFetchTree() {
  return apiRequest<PlannerTreeResponse>(`${PLANNER_API}/tree`);
}

/** Adds a comment to a task. The server trims the text and keeps 1 to 5000 characters. */
export function plannerAddCommentRequest(taskId: string, body: string) {
  return apiRequest<PlannerCommentResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

// A comment id is a bare UUID, not namespaced like a task's.
export function plannerUpdateCommentRequest(commentId: string, body: string) {
  return apiRequest<PlannerCommentResponse>(
    `${PLANNER_API}/comments/${encodeURIComponent(commentId)}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
  );
}

/** A soft delete: the comment leaves the task, its row stays on the server. */
export function plannerDeleteCommentRequest(commentId: string) {
  return apiRequest<PlannerDeleteCommentResponse>(
    `${PLANNER_API}/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
  );
}

/**
 * The whole upstream task. A board card leaves `notes` out, so the edit dialog
 * (which saves every field it shows) must start from the real row or saving
 * would blank the notes.
 */
export function plannerFetchTask(taskId: string) {
  return apiRequest<{ task: Task }>(`/api/app/tasks/${taskSegment(taskId)}`);
}

/** The Worker throttles planner writes per user and answers 429. */
export function plannerIsRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/**
 * The text for a failed write's toast: a throttled request gets its own calm
 * wording (nothing is wrong, the edit is simply undone), anything else shows the
 * server's message or the caller's fallback.
 */
export function plannerErrorMessage(
  error: unknown,
  fallback: string,
  rateLimited: string,
): string {
  return plannerIsRateLimited(error)
    ? rateLimited
    : errorMessage(error, fallback);
}
