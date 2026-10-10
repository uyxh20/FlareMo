import type {
  PlannerAiCheckInput,
  PlannerAiCloseInput,
  PlannerAiCoachInput,
  PlannerAiMemoInput,
  PlannerCommitInput,
  PlannerLookBackInput,
} from "@flaremo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, AUTHENTICATION_REQUIRED_EVENT } from "@/api/client";
import {
  plannerAiCheckRequest,
  plannerAiCloseRequest,
  plannerAiFailure,
  plannerAiOpeningRequest,
  plannerCreateGoalRequest,
  plannerDeleteGoalRequest,
  plannerFetchGoalsYear,
  plannerFetchReview,
  plannerFetchReviewStatus,
  plannerLookBackRequest,
  plannerLookForwardRequest,
  plannerReadAiStream,
  plannerSaveReviewStateRequest,
  plannerStreamCoach,
  plannerStreamMemo,
  plannerUpdateGoalRequest,
  plannerUpdateWeekRequest,
} from "./goals-api";

// Sunday 11 October 2026: the review looks back on the week of Monday 5 October.
const TODAY = "2026-10-11";
const WEEK = "2026-10-05";
const REVIEW = `/api/app/planner/review/${WEEK}`;

type Call = { url: string; init: RequestInit };

/** Replaces fetch with one that records each call and answers with `status` and `body`. */
function stubFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

const encoder = new TextEncoder();

/**
 * Replaces fetch with one that answers `status` with an NDJSON stream, handed
 * over in `chunks` as the network splits it. `events` says whether the reader
 * let the rest of the stream go.
 */
function stubStream(status: number, chunks: Array<string | Uint8Array>) {
  const calls: Call[] = [];
  const events: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      let next = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[next];
          next += 1;
          if (chunk === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        },
        cancel() {
          events.push("cancelled");
        },
      });
      return new Response(stream, {
        status,
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }),
  );
  return { calls, events };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const noAnswers = () => ({
  last_answer: [],
  answers: [[], [], [], [], [], [], []],
  goal_results: [],
  coach_notes: [],
});

const coachInput: PlannerAiCoachInput = {
  today: TODAY,
  mode: "free",
  messages: [{ role: "user", content: "The beta shipped on Thursday." }],
};

const memoInput: PlannerAiMemoInput = {
  today: TODAY,
  ...noAnswers(),
  scores: { auth: 4, ach: 3.5 },
  question: null,
  verdict: null,
  recommended: "continue",
  drafts: {
    auth_evidence: "",
    ach_evidence: "",
    pattern: "",
    risk: "",
    opportunity: "",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("goals and weeks", () => {
  it("reads one ISO year for a day", async () => {
    const calls = stubFetch(200, { goals: [], weeks: [] });
    await plannerFetchGoalsYear({ year: 2026, today: TODAY });
    expect(calls[0]?.url).toBe(
      "/api/app/planner/goals?year=2026&today=2026-10-11",
    );
    expect(calls[0]?.init.method).toBeUndefined();
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  it("creates a goal under the id the page chose", async () => {
    const calls = stubFetch(201, { goal: {} });
    const input = {
      id: "6f1c2a8e-3d4b-4c5d-8e9f-0a1b2c3d4e5f",
      level: "week" as const,
      period_start: WEEK,
      pillar: "work" as const,
      title: "Ship the billing page",
    };
    await plannerCreateGoalRequest(input);
    expect(calls[0]?.url).toBe("/api/app/planner/goals");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual(input);
  });

  it("patches and deletes a goal by its encoded id", async () => {
    const calls = stubFetch(200, { goal: {}, ok: true });
    await plannerUpdateGoalRequest("goal-1", { result: "met" });
    await plannerUpdateGoalRequest("odd id/with?chars", { title: "Renamed" });
    await plannerDeleteGoalRequest("goal-1");
    expect(calls[0]?.url).toBe("/api/app/planner/goals/goal-1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({ result: "met" });
    expect(calls[1]?.url).toBe(
      "/api/app/planner/goals/odd%20id%2Fwith%3Fchars",
    );
    expect(calls[2]?.init.method).toBe("DELETE");
    expect(calls[2]?.init.body).toBeUndefined();
  });

  it("patches a week's record by its Monday, a null score clearing it", async () => {
    const calls = stubFetch(200, { week: {} });
    await plannerUpdateWeekRequest(WEEK, { auth: 4.5, ach: null });
    expect(calls[0]?.url).toBe("/api/app/planner/weeks/2026-10-05");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({ auth: 4.5, ach: null });
  });
});

describe("the review's JSON routes", () => {
  it("reads the review and whether one is due, for the client's day", async () => {
    const calls = stubFetch(200, { due: true });
    await plannerFetchReview({ today: TODAY });
    await plannerFetchReviewStatus(TODAY);
    expect(calls[0]?.url).toBe("/api/app/planner/review?today=2026-10-11");
    expect(calls[1]?.url).toBe(
      "/api/app/planner/review/status?today=2026-10-11",
    );
    expect(calls.map((call) => call.init.method)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("saves the page's state under the week, keeping it alive past the page only when asked and when it fits", async () => {
    const calls = stubFetch(200, { ok: true });
    const state = { v: 1, back: { stage: "p" } };
    await plannerSaveReviewStateRequest(WEEK, state);
    await plannerSaveReviewStateRequest(WEEK, state, { keepalive: true });
    await plannerSaveReviewStateRequest(
      WEEK,
      { v: 1, note: "a".repeat(40_000) },
      { keepalive: true },
    );
    expect(calls[0]?.url).toBe(`${REVIEW}/state`);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({ state });
    expect(calls[0]?.init.keepalive).toBeUndefined();
    expect(calls[1]?.init.keepalive).toBe(true);
    // Too big for keepalive: sent whole, as an ordinary request.
    expect(calls[2]?.init.keepalive).toBeUndefined();
    expect(bodyOf(calls[2]).state.note).toHaveLength(40_000);
  });

  it("posts Look back and Look forward to the week's routes", async () => {
    const calls = stubFetch(200, { ok: true });
    const lookBack: PlannerLookBackInput = {
      today: TODAY,
      scores: { auth: 4, ach: 3.5 },
      question: "Did I send the invoices on Monday?",
      verdict: { kind: "continue", text: "Continue." },
      goal_results: [{ goal_id: "goal-1", result: "met" }],
      memo: "# Week 41",
    };
    const commit: PlannerCommitInput = {
      today: TODAY,
      goals: [],
      tasks: [],
      to_backlog: [],
      question: null,
      settled: [],
      flags: [],
    };
    await plannerLookBackRequest(WEEK, lookBack);
    await plannerLookForwardRequest(WEEK, commit);
    expect(calls[0]?.url).toBe(`${REVIEW}/look-back`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual(lookBack);
    expect(calls[1]?.url).toBe(`${REVIEW}/look-forward`);
    expect(calls[1]?.init.method).toBe("POST");
    expect(bodyOf(calls[1])).toEqual(commit);
  });

  it("asks the model for the opening, the close and the check", async () => {
    const calls = stubFetch(200, {});
    const close: PlannerAiCloseInput = { today: TODAY, ...noAnswers() };
    const check: PlannerAiCheckInput = { today: TODAY, goals: [], settled: [] };
    await plannerAiOpeningRequest(WEEK, TODAY);
    await plannerAiCloseRequest(WEEK, close);
    await plannerAiCheckRequest(WEEK, check);
    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      [`${REVIEW}/ai/opening`, "POST"],
      [`${REVIEW}/ai/close`, "POST"],
      [`${REVIEW}/ai/check`, "POST"],
    ]);
    expect(bodyOf(calls[0])).toEqual({ today: TODAY });
    expect(bodyOf(calls[1])).toEqual(close);
    expect(bodyOf(calls[2])).toEqual(check);
  });

  it("encodes the week into the path", async () => {
    const calls = stubFetch(200, {});
    await plannerAiOpeningRequest("2026-10-05/../x", TODAY);
    expect(calls[0]?.url).toBe(
      "/api/app/planner/review/2026-10-05%2F..%2Fx/ai/opening",
    );
  });
});

describe("plannerAiFailure", () => {
  it("tells no model (503) from the throttle (429) from anything else", async () => {
    stubFetch(503, {
      error: {
        message: "The weekly review's model is not available.",
        code: "ai_unavailable",
      },
    });
    const down = await plannerAiOpeningRequest(WEEK, TODAY).catch(
      (caught: unknown) => caught,
    );
    expect(plannerAiFailure(down)).toBe("unavailable");

    stubFetch(429, { error: { message: "Too many requests." } });
    const limited = await plannerAiCheckRequest(WEEK, {
      today: TODAY,
      goals: [],
      settled: [],
    }).catch((caught: unknown) => caught);
    expect(plannerAiFailure(limited)).toBe("limited");

    stubFetch(500, { error: { message: "Internal error." } });
    const broken = await plannerAiCloseRequest(WEEK, {
      today: TODAY,
      ...noAnswers(),
    }).catch((caught: unknown) => caught);
    expect(plannerAiFailure(broken)).toBe("failed");
  });

  it("counts only the client's own errors by status", () => {
    expect(plannerAiFailure(new ApiError("x", 503))).toBe("unavailable");
    expect(plannerAiFailure(new ApiError("x", 429))).toBe("limited");
    expect(plannerAiFailure(new ApiError("x", 400))).toBe("failed");
    expect(plannerAiFailure(new TypeError("Failed to fetch"))).toBe("failed");
    expect(plannerAiFailure({ status: 503 })).toBe("failed");
    expect(plannerAiFailure(undefined)).toBe("failed");
  });
});

describe("plannerReadAiStream", () => {
  it("posts the input as JSON and joins the pieces until done, telling the page the text so far", async () => {
    const { calls } = stubStream(200, [
      line({ d: "Pattern" }),
      line({ d: " holds." }),
      line({ done: true }),
    ]);
    const texts: string[] = [];
    const result = await plannerReadAiStream(
      `${REVIEW}/ai/memo`,
      { today: TODAY },
      { onText: (text) => texts.push(text) },
    );
    expect(result).toStrictEqual({ status: "done", text: "Pattern holds." });
    expect(texts).toEqual(["Pattern", "Pattern holds."]);
    expect(calls[0]?.url).toBe(`${REVIEW}/ai/memo`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(calls[0]?.init.headers).toEqual({
      "content-type": "application/json",
    });
    expect(bodyOf(calls[0])).toEqual({ today: TODAY });
  });

  it("passes on the coach's verdict on moving on, when it gave one", async () => {
    stubStream(200, [
      line({ d: "Noted." }),
      line({ done: true, advance: true }),
    ]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "done",
      text: "Noted.",
      advance: true,
    });
    stubStream(200, [
      line({ d: "Why?" }),
      line({ done: true, advance: false }),
    ]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "done",
      text: "Why?",
      advance: false,
    });
    stubStream(200, [line({ d: "Hm." }), line({ done: true, advance: "yes" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "done",
      text: "Hm.",
    });
  });

  it("puts lines back together across reads, characters split between them included", async () => {
    const bytes = encoder.encode(
      `${line({ d: "Pattern" })}${line({ d: " · €5" })}${line({ done: true })}`,
    );
    // Cut inside the three bytes of "€".
    const euro = bytes.indexOf(0xe2) + 1;
    stubStream(200, [
      bytes.slice(0, 5),
      bytes.slice(5, euro),
      bytes.slice(euro, euro + 1),
      bytes.slice(euro + 1),
    ]);
    const texts: string[] = [];
    const result = await plannerReadAiStream(
      `${REVIEW}/ai/memo`,
      {},
      { onText: (text) => texts.push(text) },
    );
    expect(result).toStrictEqual({ status: "done", text: "Pattern · €5" });
    expect(texts).toEqual(["Pattern", "Pattern · €5"]);
  });

  it("reads a last line that has no newline", async () => {
    stubStream(200, ['{"d":"Hi"}\r\n{"d":" there"}\n{"done":true}']);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "done",
      text: "Hi there",
    });
  });

  it("skips blank lines and lines that are not pieces of the answer", async () => {
    stubStream(200, [
      "\n",
      "not json\n",
      line([1, 2]),
      line(null),
      line("text"),
      line({ d: 5 }),
      line({ other: true }),
      line({ d: "Kept" }),
      "   \n",
      line({ done: true }),
    ]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "done",
      text: "Kept",
    });
  });

  it("stops at the done line and lets the rest of the stream go", async () => {
    const { events } = stubStream(200, [
      `${line({ d: "All" })}${line({ done: true })}${line({ d: " more" })}`,
      line({ d: " and more" }),
    ]);
    const texts: string[] = [];
    const result = await plannerReadAiStream(
      `${REVIEW}/ai/memo`,
      {},
      { onText: (text) => texts.push(text) },
    );
    expect(result).toStrictEqual({ status: "done", text: "All" });
    expect(texts).toEqual(["All"]);
    expect(events).toEqual(["cancelled"]);
  });

  it("ends on the server's error line with the text that arrived", async () => {
    stubStream(200, [line({ d: "Half" }), line({ error: "failed" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "Half",
    });
    stubStream(200, [line({ d: "Half" }), line({ error: "limited" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "limited",
      text: "Half",
    });
  });

  it("calls an answer that ends without its last line cut off, keeping its text", async () => {
    stubStream(200, [line({ d: "Half a sen" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "Half a sen",
    });
    stubStream(200, [`${line({ d: "a" })}{"d":"b"}`]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "ab",
    });
    stubStream(200, [`${line({ d: "a" })}{"d":"b`]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "a",
    });
    stubStream(200, []);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "",
    });
  });

  it("reads the throttle's 429 as limited and a 503 as no model, without reading on", async () => {
    const limited = stubStream(429, [line({ error: "limited" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "limited",
      text: "",
    });
    expect(limited.events).toEqual(["cancelled"]);
    stubStream(503, [line({ error: { code: "ai_unavailable" } })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "unavailable",
      text: "",
    });
    stubStream(500, [line({ d: "never read" })]);
    expect(await plannerReadAiStream(`${REVIEW}/ai/coach`, {})).toStrictEqual({
      status: "failed",
      text: "",
    });
  });

  it("fails an answer with no body, and one the network lost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "",
    });
  });

  it("tells the app the session ended on a 401", async () => {
    const page = new EventTarget();
    const heard = vi.fn();
    page.addEventListener(AUTHENTICATION_REQUIRED_EVENT, heard);
    vi.stubGlobal("window", page);
    stubStream(401, []);
    expect(await plannerReadAiStream(`${REVIEW}/ai/memo`, {})).toStrictEqual({
      status: "failed",
      text: "",
    });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("says the page stopped it, before it began or halfway, with the text so far", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(line({ d: "Pattern: " })));
              init.signal?.addEventListener("abort", () =>
                controller.error(
                  new DOMException("The operation was aborted.", "AbortError"),
                ),
              );
            },
          }),
          { status: 200 },
        );
      }),
    );
    const early = new AbortController();
    early.abort();
    expect(
      await plannerReadAiStream(
        `${REVIEW}/ai/memo`,
        {},
        { signal: early.signal },
      ),
    ).toStrictEqual({ status: "aborted", text: "" });

    const stop = new AbortController();
    const result = await plannerReadAiStream(
      `${REVIEW}/ai/memo`,
      {},
      { signal: stop.signal, onText: () => stop.abort() },
    );
    expect(result).toStrictEqual({ status: "aborted", text: "Pattern: " });
  });

  it("streams the coach and the memo from the week's routes, passing the page's signal", async () => {
    const { calls } = stubStream(200, [line({ done: true })]);
    const stop = new AbortController();
    await plannerStreamCoach(WEEK, coachInput, { signal: stop.signal });
    await plannerStreamMemo(WEEK, memoInput, {});
    expect(calls[0]?.url).toBe(`${REVIEW}/ai/coach`);
    expect(calls[0]?.init.signal).toBe(stop.signal);
    expect(bodyOf(calls[0])).toEqual(coachInput);
    expect(calls[1]?.url).toBe(`${REVIEW}/ai/memo`);
    expect(calls[1]?.init.signal).toBeUndefined();
    expect(bodyOf(calls[1])).toEqual(memoInput);
  });
});
