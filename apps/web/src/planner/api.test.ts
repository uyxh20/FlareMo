import { afterEach, describe, expect, it, vi } from "vitest";
import {
  plannerCreateTaskRequest,
  plannerErrorMessage,
  plannerFetchBoard,
  plannerFetchTask,
  plannerFetchTaskHistory,
  plannerIsRateLimited,
  plannerRolloverRequest,
  plannerUpdateTaskRequest,
} from "./api";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the planner client", () => {
  it("reads the board for a day, asking for dropped cards only when told to", async () => {
    const calls = stubFetch(200, { columns: {} });
    await plannerFetchBoard({ today: "2026-10-07" });
    await plannerFetchBoard({
      today: "2026-10-07",
      includeDropped: true,
      doneDays: 30,
    });
    expect(calls[0]?.url).toBe("/api/app/planner/board?today=2026-10-07");
    expect(calls[1]?.url).toBe(
      "/api/app/planner/board?today=2026-10-07&include_dropped=true&done_days=30",
    );
    expect(calls[0]?.init.method).toBeUndefined();
  });

  it("posts the local date to roll over", async () => {
    const calls = stubFetch(200, { history: "ok", carried: 2 });
    const result = await plannerRolloverRequest("2026-10-07");
    expect(result).toEqual({ history: "ok", carried: 2 });
    expect(calls[0]?.url).toBe("/api/app/planner/rollover");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ today: "2026-10-07" });
  });

  it("creates a task with its plan", async () => {
    const calls = stubFetch(201, { task: {}, plan: null });
    await plannerCreateTaskRequest({
      title: "Buy milk",
      today: "2026-10-07",
      plan: { horizon: "day", day: "2026-10-07" },
    });
    expect(calls[0]?.url).toBe("/api/app/planner/tasks");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({
      title: "Buy milk",
      today: "2026-10-07",
      plan: { horizon: "day", day: "2026-10-07" },
    });
  });

  it("patches a task by its bare, encoded id, sending only what changed", async () => {
    const calls = stubFetch(200, { task: {}, plan: null });
    await plannerUpdateTaskRequest("tasks/3370e0a0-7d71", {
      today: "2026-10-07",
      column: "doing",
    });
    await plannerUpdateTaskRequest("tasks/odd id/with?chars", {
      today: "2026-10-07",
      dropped: true,
    });
    expect(calls[0]?.url).toBe("/api/app/planner/tasks/3370e0a0-7d71");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({ today: "2026-10-07", column: "doing" });
    expect(calls[1]?.url).toBe(
      "/api/app/planner/tasks/odd%20id%2Fwith%3Fchars",
    );
    expect(bodyOf(calls[1])).toEqual({ today: "2026-10-07", dropped: true });
  });

  it("accepts a bare id as well as a namespaced one", async () => {
    const calls = stubFetch(200, { task: {}, plan: null });
    await plannerUpdateTaskRequest("abc-123", {
      today: "2026-10-07",
      due_at: null,
    });
    expect(calls[0]?.url).toBe("/api/app/planner/tasks/abc-123");
    expect(bodyOf(calls[0])).toEqual({ today: "2026-10-07", due_at: null });
  });

  it("reads a task's history and the whole upstream task by the same id form", async () => {
    const calls = stubFetch(200, { events: [], task: {} });
    await plannerFetchTaskHistory("tasks/abc-123");
    await plannerFetchTask("tasks/abc-123");
    expect(calls[0]?.url).toBe("/api/app/planner/tasks/abc-123/history");
    expect(calls[1]?.url).toBe("/api/app/tasks/abc-123");
  });
});

describe("failed writes", () => {
  it("recognises the throttle by its 429", async () => {
    stubFetch(429, {
      error: { message: "Too many requests. Please try again later." },
    });
    const error = await plannerUpdateTaskRequest("tasks/a", {
      today: "2026-10-07",
      column: "done",
    }).catch((caught: unknown) => caught);
    expect(plannerIsRateLimited(error)).toBe(true);
    expect(
      plannerErrorMessage(error, "Couldn't move the task", "Slow down"),
    ).toBe("Slow down");
  });

  it("shows the server's own message for any other failure", async () => {
    stubFetch(400, {
      error: { message: "The task is dropped. Undrop it first." },
    });
    const error = await plannerUpdateTaskRequest("tasks/a", {
      today: "2026-10-07",
      column: "done",
    }).catch((caught: unknown) => caught);
    expect(plannerIsRateLimited(error)).toBe(false);
    expect(
      plannerErrorMessage(error, "Couldn't move the task", "Slow down"),
    ).toBe("The task is dropped. Undrop it first.");
  });

  it("falls back to the caller's wording when there is nothing to show", () => {
    expect(plannerErrorMessage(undefined, "Couldn't move the task", "x")).toBe(
      "Couldn't move the task",
    );
    expect(plannerErrorMessage({ message: "  " }, "Couldn't move", "x")).toBe(
      "Couldn't move",
    );
  });

  it("does not treat a plain network error as a throttle", () => {
    expect(plannerIsRateLimited(new TypeError("Failed to fetch"))).toBe(false);
    expect(plannerIsRateLimited({ status: 429 })).toBe(false);
  });
});
