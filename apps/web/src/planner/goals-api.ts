import type {
  PlannerAgentProposalResponse,
  PlannerAgentProposalsResponse,
  PlannerAgentResponse,
  PlannerAgentStep,
  PlannerAiCheckInput,
  PlannerAiCheckResponse,
  PlannerAiCheckResult,
  PlannerAiCloseInput,
  PlannerAiCloseResponse,
  PlannerAiCloseResult,
  PlannerAiCoachInput,
  PlannerAiMemoInput,
  PlannerAiOpeningInput,
  PlannerAiOpeningResponse,
  PlannerAiOpeningResult,
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

// `week` can also be the path of a month or quarter review's chat routes
// (period-chat.tsx), which answer the weekly review's AI requests in kind.
const reviewPath = (week: string, rest: string) =>
  week.startsWith("/")
    ? `${week}/${rest}`
    : `${PLANNER_API}/review/${encodeURIComponent(week)}/${rest}`;

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

/** Starts the week's review over: its state and done marks are cleared. */
export function plannerStartReviewOverRequest(week: string) {
  return apiRequest<PlannerReviewStateResponse>(
    reviewPath(week, "start-over"),
    { method: "POST" },
  );
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

export function plannerAiOpeningRequest(
  week: string,
  input: PlannerAiOpeningInput,
) {
  return apiRequest<PlannerAiOpeningResult>(reviewPath(week, "ai/opening"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function plannerAiCloseRequest(
  week: string,
  input: PlannerAiCloseInput,
) {
  return apiRequest<PlannerAiCloseResult>(reviewPath(week, "ai/close"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** The review agent did not answer the step (it failed, or ran out of time). */
export class PlannerAgentFailed extends Error {
  constructor() {
    super("The review agent did not answer.");
    this.name = "PlannerAgentFailed";
  }
}

/**
 * The opening's drafts. When the review agent runs the review, the server
 * starts its session and the drafts come from it a few minutes later; the
 * session is returned to give the later steps to. Throws like apiRequest, or
 * PlannerAgentFailed.
 */
export async function plannerAiOpening(
  week: string,
  input: PlannerAiOpeningInput,
  options: { signal?: AbortSignal; onAgent?: (session: string) => void } = {},
): Promise<{ opening: PlannerAiOpeningResponse; agent?: string }> {
  const result = await plannerAiOpeningRequest(week, input);
  if (!("agent" in result)) return { opening: result };
  options.onAgent?.(result.agent);
  const answer = await plannerWaitForAgent(week, result.agent, {
    today: input.today,
    step: "opening",
    signal: options.signal,
  });
  if (answer?.step !== "opening") throw new PlannerAgentFailed();
  return { opening: answer.opening, agent: result.agent };
}

/** The scores and trajectory drafts, from the review agent when it has the step. */
export async function plannerAiClose(
  week: string,
  input: PlannerAiCloseInput,
  options: { signal?: AbortSignal } = {},
): Promise<PlannerAiCloseResponse> {
  const result = await plannerAiCloseRequest(week, input);
  if (!("agent" in result)) return result;
  const answer = await plannerWaitForAgent(week, result.agent, {
    today: input.today,
    step: "close",
    signal: options.signal,
  });
  if (answer?.step !== "close") throw new PlannerAgentFailed();
  return answer.close;
}

export function plannerAiCheckRequest(
  week: string,
  input: PlannerAiCheckInput,
) {
  return apiRequest<PlannerAiCheckResult>(reviewPath(week, "ai/check"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * The goal check's flags, and who checked: the review's agent session when
 * the review has one (its answer comes in a minute or so), else the model.
 * Throws like apiRequest, or PlannerAgentFailed.
 */
export async function plannerAiCheck(
  week: string,
  input: PlannerAiCheckInput,
  options: { signal?: AbortSignal } = {},
): Promise<PlannerAiCheckResponse & { by: "agent" | "model" }> {
  const result = await plannerAiCheckRequest(week, input);
  if (!("agent" in result)) return { ...result, by: "model" };
  const answer = await plannerWaitForAgent(week, result.agent, {
    today: input.today,
    step: "check",
    signal: options.signal,
  });
  if (answer?.step !== "check") throw new PlannerAgentFailed();
  return { ...answer.check, by: "agent" };
}

/** The agent's goal and task proposals for the week being planned. */
export function plannerFetchProposals(week: string, today: string) {
  return apiRequest<PlannerAgentProposalsResponse>(
    `${reviewPath(week, "proposals")}?${new URLSearchParams({ today })}`,
  );
}

/** Accepts or dismisses one of the agent's proposals. */
export function plannerSettleProposalRequest(
  id: string,
  state: "accepted" | "dismissed" | "open",
) {
  return apiRequest<PlannerAgentProposalResponse>(
    `${PLANNER_API}/agent/proposals/${encodeURIComponent(id)}`,
    { method: "POST", body: JSON.stringify({ state }) },
  );
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
  /** The memo agent's session, when the agent writes the memo instead. */
  agent?: string;
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
    if ("agent" in parsed && typeof parsed.agent === "string") {
      return { status: "done", text, agent: parsed.agent };
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

/** One coach reply, streamed; or, from the review agent, shown whole. */
export async function plannerStreamCoach(
  week: string,
  input: PlannerAiCoachInput,
  options: { signal?: AbortSignal; onText?: (text: string) => void },
): Promise<PlannerStreamResult> {
  const result = await plannerReadAiStream(
    reviewPath(week, "ai/coach"),
    input,
    options,
  );
  if (!result.agent) return result;
  const answer = await plannerWaitForAgent(week, result.agent, {
    today: input.today,
    step: "coach",
    mode: input.mode,
    signal: options.signal,
  });
  if (options.signal?.aborted) return { status: "aborted", text: "" };
  if (answer?.step !== "coach" || !answer.text) {
    return { status: "failed", text: "" };
  }
  options.onText?.(answer.text);
  return {
    status: "done",
    text: answer.text,
    ...(answer.advance === null ? {} : { advance: answer.advance }),
  };
}

/** How often the page asks the review agent for an answer, and for how long. */
const AGENT_POLL_MS = 4_000;
const AGENT_WAIT_MS = 15 * 60_000;

/**
 * Asks the review agent's session every few seconds for its answer to `step`
 * until it is there (a reply takes seconds, the opening and the memo a few
 * minutes). Null when it failed, ran out of time or was stopped.
 */
export async function plannerWaitForAgent(
  week: string,
  session: string,
  options: {
    today: string;
    step: PlannerAgentStep;
    mode?: PlannerAiCoachInput["mode"];
    signal?: AbortSignal;
  },
): Promise<Extract<PlannerAgentResponse, { status: "done" }> | null> {
  const query = new URLSearchParams({
    today: options.today,
    step: options.step,
    ...(options.mode ? { mode: options.mode } : {}),
  });
  const path = `${reviewPath(week, `ai/agent/${encodeURIComponent(session)}`)}?${query}`;
  const deadline = Date.now() + AGENT_WAIT_MS;
  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AGENT_POLL_MS);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  while (Date.now() < deadline) {
    await wait();
    if (options.signal?.aborted) return null;
    let state: PlannerAgentResponse;
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        signal: options.signal,
      });
      if (response.status === 401 && typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
      }
      if ([400, 401, 404, 503].includes(response.status)) return null;
      if (!response.ok) continue;
      state = (await response.json()) as PlannerAgentResponse;
    } catch {
      if (options.signal?.aborted) return null;
      continue;
    }
    if (state.status === "done") return state;
    if (state.status === "failed") return null;
  }
  return null;
}

/**
 * The summary memo, streamed; or, when the review agent writes it, asked for
 * every few seconds until the agent is done (a few minutes), then shown whole.
 */
export async function plannerStreamMemo(
  week: string,
  input: PlannerAiMemoInput,
  options: {
    signal?: AbortSignal;
    onText?: (text: string) => void;
    /** The agent has it: the memo comes whole, in a few minutes. */
    onAgent?: () => void;
  },
): Promise<PlannerStreamResult> {
  const result = await plannerReadAiStream(
    reviewPath(week, "ai/memo"),
    input,
    options,
  );
  if (!result.agent) return result;
  options.onAgent?.();
  const answer = await plannerWaitForAgent(week, result.agent, {
    today: input.today,
    step: "memo",
    signal: options.signal,
  });
  if (options.signal?.aborted) return { status: "aborted", text: "" };
  if (answer?.step !== "memo") return { status: "failed", text: "" };
  options.onText?.(answer.memo);
  return { status: "done", text: answer.memo };
}
