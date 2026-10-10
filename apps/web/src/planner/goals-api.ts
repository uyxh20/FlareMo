import type {
  PlannerAiCheckInput,
  PlannerAiCheckResponse,
  PlannerAiCloseInput,
  PlannerAiCloseResponse,
  PlannerAiCoachInput,
  PlannerAiMemoInput,
  PlannerAiOpeningResponse,
  PlannerAiStreamLine,
  PlannerCommitInput,
  PlannerCommitResponse,
  PlannerCreateGoalInput,
  PlannerGoalResponse,
  PlannerGoalsYearResponse,
  PlannerLookBackInput,
  PlannerLookBackResponse,
  PlannerOkResponse,
  PlannerReviewResponse,
  PlannerReviewStateResponse,
  PlannerReviewStatusResponse,
  PlannerUpdateGoalInput,
  PlannerUpdateWeekInput,
  PlannerWeekResponse,
} from "@flaremo/contracts";
import {
  ApiError,
  AUTHENTICATION_REQUIRED_EVENT,
  apiRequest,
} from "@/api/client";
import { plannerFitsKeepalive } from "./api";

// Goals, week records and the weekly review over HTTP (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the routes listed in
// packages/contracts/src/planner-goals.ts, typed straight from the contracts like
// the cockpit's own client (api.ts). The two streaming routes answer NDJSON, which
// `apiRequest` cannot read, so they have their own small reader here.
//
// `today` is the client's local date; `week` is always the Monday of the week the
// review looks back on, as the server named it in `review_week`.

const PLANNER_API = "/api/app/planner";

const reviewPath = (week: string, rest: string) =>
  `${PLANNER_API}/review/${encodeURIComponent(week)}/${rest}`;

/** Everything the Goals page draws for one ISO year. */
export function plannerFetchGoalsYear(input: { year: number; today: string }) {
  const query = new URLSearchParams({
    year: String(input.year),
    today: input.today,
  });
  return apiRequest<PlannerGoalsYearResponse>(`${PLANNER_API}/goals?${query}`);
}

/** A new goal; `id` (a UUID) makes a retried create harmless. */
export function plannerCreateGoalRequest(input: PlannerCreateGoalInput) {
  return apiRequest<PlannerGoalResponse>(`${PLANNER_API}/goals`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function plannerUpdateGoalRequest(
  goalId: string,
  input: PlannerUpdateGoalInput,
) {
  return apiRequest<PlannerGoalResponse>(
    `${PLANNER_API}/goals/${encodeURIComponent(goalId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

/** A soft delete: the goal leaves every page, its row stays on the server. */
export function plannerDeleteGoalRequest(goalId: string) {
  return apiRequest<PlannerOkResponse>(
    `${PLANNER_API}/goals/${encodeURIComponent(goalId)}`,
    { method: "DELETE" },
  );
}

/** One week's record: its scores, note, question or verdict. */
export function plannerUpdateWeekRequest(
  weekStart: string,
  input: PlannerUpdateWeekInput,
) {
  return apiRequest<PlannerWeekResponse>(
    `${PLANNER_API}/weeks/${encodeURIComponent(weekStart)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

/** The review `today` is due for, with its saved state and everything it reads. */
export function plannerFetchReview(input: { today: string }) {
  const query = new URLSearchParams({ today: input.today });
  return apiRequest<PlannerReviewResponse>(`${PLANNER_API}/review?${query}`);
}

/** Whether a review is due, for the sidebar's dot. */
export function plannerFetchReviewStatus(today: string) {
  const query = new URLSearchParams({ today });
  return apiRequest<PlannerReviewStatusResponse>(
    `${PLANNER_API}/review/status?${query}`,
  );
}

/**
 * The page's own record of the review in progress. `keepalive` is for the save
 * made as the page is hidden or closed, passed on only when the body fits.
 */
export function plannerSaveReviewStateRequest(
  week: string,
  state: Record<string, unknown>,
  options: { keepalive?: boolean } = {},
) {
  const body = JSON.stringify({ state });
  return apiRequest<PlannerReviewStateResponse>(reviewPath(week, "state"), {
    method: "PATCH",
    body,
    ...(options.keepalive && plannerFitsKeepalive(body)
      ? { keepalive: true }
      : {}),
  });
}

/** Look back is finished: scores, question, verdict, goal results and the memo. */
export function plannerLookBackRequest(
  week: string,
  input: PlannerLookBackInput,
) {
  return apiRequest<PlannerLookBackResponse>(reviewPath(week, "look-back"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Look forward is saved: the next week's goals, tasks and the check's flags. */
export function plannerLookForwardRequest(
  week: string,
  input: PlannerCommitInput,
) {
  return apiRequest<PlannerCommitResponse>(reviewPath(week, "look-forward"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function plannerAiOpeningRequest(week: string, today: string) {
  return apiRequest<PlannerAiOpeningResponse>(reviewPath(week, "ai/opening"), {
    method: "POST",
    body: JSON.stringify({ today }),
  });
}

export function plannerAiCloseRequest(
  week: string,
  input: PlannerAiCloseInput,
) {
  return apiRequest<PlannerAiCloseResponse>(reviewPath(week, "ai/close"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function plannerAiCheckRequest(
  week: string,
  input: PlannerAiCheckInput,
) {
  return apiRequest<PlannerAiCheckResponse>(reviewPath(week, "ai/check"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Why a JSON AI call failed. The server answers 503 when no model is configured
 * or the model call failed, and 429 when the page asked too often; either way the
 * page goes on with its own drafts.
 */
export function plannerAiFailure(
  error: unknown,
): "unavailable" | "limited" | "failed" {
  if (error instanceof ApiError && error.status === 503) return "unavailable";
  if (error instanceof ApiError && error.status === 429) return "limited";
  return "failed";
}

/** How a streamed answer ended, with all the text that arrived. */
export type PlannerStreamResult = {
  /**
   * `done`: the whole answer arrived. `limited`: throttled. `unavailable`: no
   * model. `failed`: the model or the connection broke off. `aborted`: the page
   * stopped it.
   */
  status: "done" | "limited" | "unavailable" | "failed" | "aborted";
  text: string;
  /** The coach's verdict on moving to the next prompt; only with `done`. */
  advance?: boolean;
};

function parseLine(line: string): PlannerAiStreamLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PlannerAiStreamLine)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads one NDJSON answer: `{"d"}` pieces, then `{"done"}` or `{"error"}`.
 * `onText` gets the whole text so far after each piece. Never throws: how the
 * answer ended is in the result, with whatever text had arrived.
 */
export async function plannerReadAiStream(
  path: string,
  input: unknown,
  options: { signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<PlannerStreamResult> {
  const ended = (
    status: PlannerStreamResult["status"],
    text: string,
  ): PlannerStreamResult => ({
    status: options.signal?.aborted ? "aborted" : status,
    text,
  });

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: options.signal,
    });
  } catch {
    return ended("failed", "");
  }
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return ended(
      response.status === 429
        ? "limited"
        : response.status === 503
          ? "unavailable"
          : "failed",
      "",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const read = (line: string): PlannerStreamResult | null => {
    const parsed = parseLine(line.trim());
    if (!parsed) return null;
    if ("d" in parsed && typeof parsed.d === "string") {
      text += parsed.d;
      options.onText?.(text);
      return null;
    }
    if ("done" in parsed) {
      return {
        status: "done",
        text,
        ...(typeof parsed.advance === "boolean"
          ? { advance: parsed.advance }
          : {}),
      };
    }
    if ("error" in parsed) {
      return ended(parsed.error === "limited" ? "limited" : "failed", text);
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const result = read(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (result) {
          await reader.cancel().catch(() => undefined);
          return result;
        }
        end = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = buffer.trim() ? read(buffer) : null;
    // An answer that ends without its last line was cut off.
    return last ?? ended("failed", text);
  } catch {
    return ended("failed", text);
  }
}

/** One coach reply, streamed. */
export function plannerStreamCoach(
  week: string,
  input: PlannerAiCoachInput,
  options: { signal?: AbortSignal; onText?: (text: string) => void },
) {
  return plannerReadAiStream(reviewPath(week, "ai/coach"), input, options);
}

/** The summary memo, streamed. */
export function plannerStreamMemo(
  week: string,
  input: PlannerAiMemoInput,
  options: { signal?: AbortSignal; onText?: (text: string) => void },
) {
  return plannerReadAiStream(reviewPath(week, "ai/memo"), input, options);
}
