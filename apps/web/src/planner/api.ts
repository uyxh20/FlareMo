import {
  type PlannerAttachmentDto,
  type PlannerAttachmentResponse,
  type PlannerAttachmentSettingsResponse,
  type PlannerBoardResponse,
  type PlannerCommentResponse,
  type PlannerCreateTaskInput,
  type PlannerCreateTaskResponse,
  type PlannerDeleteAttachmentResponse,
  type PlannerDeleteCommentResponse,
  type PlannerRevertEventResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  type PlannerTaskPlanResponse,
  type PlannerUpdateTaskInput,
  plannerAttachmentNameHeader,
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

export function plannerCreateTaskRequest(input: PlannerCreateTaskInput) {
  return apiRequest<PlannerCreateTaskResponse>(`${PLANNER_API}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * The biggest body the cockpit sends with `keepalive`. That option makes the
 * browser finish a request even if the page goes away (a tab closing), but
 * browsers cap the bodies of all such requests in flight at 64 KB for a page and
 * refuse one that goes over. Half of the cap leaves room for headers and for a
 * second request in flight; a bigger body goes as an ordinary request, which is
 * still sent when the page is only hidden.
 */
export const plannerKeepaliveMaxBytes = 32 * 1024;

/** Whether a request body is small enough, in bytes, to send with `keepalive`. */
export function plannerFitsKeepalive(body: string): boolean {
  return new TextEncoder().encode(body).length <= plannerKeepaliveMaxBytes;
}

/**
 * Column moves, plans, drops and task fields in one request. `column` and
 * `plan` together are a 400: a column move sets the plan itself.
 *
 * `keepalive` is for a save made as the page is hidden or closed (the notes'
 * autosave): the browser then finishes the request even if the page goes. It is
 * passed on only when the body fits (see `plannerKeepaliveMaxBytes`).
 */
export function plannerUpdateTaskRequest(
  taskId: string,
  input: PlannerUpdateTaskInput,
  options: { keepalive?: boolean } = {},
) {
  const body = JSON.stringify(input);
  return apiRequest<PlannerTaskPlanResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}`,
    {
      method: "PATCH",
      body,
      ...(options.keepalive && plannerFitsKeepalive(body)
        ? { keepalive: true }
        : {}),
    },
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

/**
 * Reverts one History line: the inverse change is made as a new change, and
 * the archive gets a `reverted` line. A 400 says why a line cannot be put back.
 */
export function plannerRevertEventRequest(
  taskId: string,
  eventId: number,
  today: string,
) {
  return apiRequest<PlannerRevertEventResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}/history/${eventId}/revert`,
    { method: "POST", body: JSON.stringify({ today }) },
  );
}

/**
 * Puts a file on a task (docs/fork-task-attachments.md): the file is the body,
 * its name travels percent-encoded in a header. 413 when it is over 10 MB, 400
 * when the task already holds 10 files.
 */
export function plannerUploadAttachmentRequest(taskId: string, file: File) {
  return apiRequest<PlannerAttachmentResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        [plannerAttachmentNameHeader]: encodeURIComponent(file.name),
      },
      body: file,
    },
  );
}

/** Takes a file off its task. It is deleted for good a week later. */
export function plannerDeleteAttachmentRequest(attachmentId: string) {
  return apiRequest<PlannerDeleteAttachmentResponse>(
    `${PLANNER_API}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
}

/** Reads a file into a proposed comment once more; 409 while a read is under way. */
export function plannerReadAttachmentRequest(attachmentId: string) {
  return apiRequest<PlannerAttachmentResponse>(
    `${PLANNER_API}/attachments/${encodeURIComponent(attachmentId)}/read`,
    { method: "POST" },
  );
}

/** The task's "Store only, don't read these files" switch, as `files_read`. */
export function plannerSetAttachmentSettingsRequest(
  taskId: string,
  filesRead: boolean,
) {
  return apiRequest<PlannerAttachmentSettingsResponse>(
    `${PLANNER_API}/tasks/${taskSegment(taskId)}/attachments/settings`,
    { method: "PATCH", body: JSON.stringify({ files_read: filesRead }) },
  );
}

/** Whether a file shows as a picture in the panel. */
export function plannerAttachmentIsImage(attachment: PlannerAttachmentDto) {
  return (attachment.content_type ?? "").startsWith("image/");
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
