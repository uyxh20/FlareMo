import { afterEach, describe, expect, it, vi } from "vitest";
import {
  plannerAddCommentRequest,
  plannerCreateTaskRequest,
  plannerDeleteCommentRequest,
  plannerErrorMessage,
  plannerFetchBoard,
  plannerFetchTask,
  plannerFetchTaskDetail,
  plannerFetchTaskHistory,
  plannerFetchTree,
  plannerFitsKeepalive,
  plannerIsRateLimited,
  plannerKeepaliveMaxBytes,
  plannerRolloverRequest,
  plannerUpdateCommentRequest,
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

describe("the task panel's requests", () => {
  it("creates a task straight in a column", async () => {
    const calls = stubFetch(201, { task: {}, plan: null });
    await plannerCreateTaskRequest({
      title: "In Doing",
      today: "2026-10-07",
      column: "doing",
    });
    expect(bodyOf(calls[0])).toEqual({
      title: "In Doing",
      today: "2026-10-07",
      column: "doing",
    });
  });

  it("reads one task whole by its bare, encoded id", async () => {
    const calls = stubFetch(200, { task: {}, plan: null, comments: [] });
    await plannerFetchTaskDetail("tasks/3370e0a0-7d71");
    await plannerFetchTaskDetail("abc 1/2");
    expect(calls[0]?.url).toBe("/api/app/planner/tasks/3370e0a0-7d71");
    expect(calls[0]?.init.method).toBeUndefined();
    expect(calls[1]?.url).toBe("/api/app/planner/tasks/abc%201%2F2");
  });

  it("sets an effort, and clears it with null, in an ordinary patch", async () => {
    const calls = stubFetch(200, { task: {}, plan: null });
    await plannerUpdateTaskRequest("tasks/a", {
      today: "2026-10-07",
      effort: 3.5,
    });
    await plannerUpdateTaskRequest("tasks/a", {
      today: "2026-10-07",
      effort: null,
    });
    expect(bodyOf(calls[0])).toEqual({ today: "2026-10-07", effort: 3.5 });
    expect(bodyOf(calls[1])).toEqual({ today: "2026-10-07", effort: null });
  });

  it("asks fetch to keep an update alive past the page only when told to", async () => {
    const calls = stubFetch(200, { task: {}, plan: null });
    const input = { today: "2026-10-07", notes: "Quick note" };
    await plannerUpdateTaskRequest("tasks/a", input);
    await plannerUpdateTaskRequest("tasks/a", input, { keepalive: false });
    await plannerUpdateTaskRequest("tasks/a", input, { keepalive: true });
    expect(calls[0]?.init.keepalive).toBeUndefined();
    expect(calls[1]?.init.keepalive).toBeUndefined();
    expect(calls[2]?.init.keepalive).toBe(true);
    // The request is the same one either way.
    expect(calls[2]?.url).toBe("/api/app/planner/tasks/a");
    expect(calls[2]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[2])).toEqual(input);
  });

  it("sends a body that is too big for keepalive as an ordinary request, whole", async () => {
    const calls = stubFetch(200, { task: {}, plan: null });
    // Browsers refuse a keepalive body past 64 KB for the whole page, and count
    // bytes, not characters: 12,000 euro signs are 36,000 bytes in UTF-8.
    await plannerUpdateTaskRequest(
      "tasks/a",
      { today: "2026-10-07", notes: "€".repeat(12_000) },
      { keepalive: true },
    );
    await plannerUpdateTaskRequest(
      "tasks/a",
      { today: "2026-10-07", notes: "a".repeat(40_000) },
      { keepalive: true },
    );
    await plannerUpdateTaskRequest(
      "tasks/a",
      { today: "2026-10-07", notes: "a".repeat(20_000) },
      { keepalive: true },
    );
    expect(calls[0]?.init.keepalive).toBeUndefined();
    expect(calls[1]?.init.keepalive).toBeUndefined();
    expect(calls[2]?.init.keepalive).toBe(true);
    expect(bodyOf(calls[0]).notes).toHaveLength(12_000);
    expect(bodyOf(calls[1]).notes).toHaveLength(40_000);
  });

  it("counts a body's size in bytes, half of the 64 KB cap being the limit", () => {
    expect(plannerKeepaliveMaxBytes).toBe(32 * 1024);
    expect(plannerFitsKeepalive("a".repeat(plannerKeepaliveMaxBytes))).toBe(
      true,
    );
    expect(plannerFitsKeepalive("a".repeat(plannerKeepaliveMaxBytes + 1))).toBe(
      false,
    );
    // Three bytes each: 10,922 of them are 32,766 bytes, 10,923 are 32,769.
    expect(plannerFitsKeepalive("€".repeat(10_922))).toBe(true);
    expect(plannerFitsKeepalive("€".repeat(10_923))).toBe(false);
  });

  it("reads the goal tree", async () => {
    const calls = stubFetch(200, { nodes: [] });
    await plannerFetchTree();
    expect(calls[0]?.url).toBe("/api/app/planner/tree");
  });

  it("adds a comment to a task by its bare id, sending only the text", async () => {
    const calls = stubFetch(201, { comment: {} });
    await plannerAddCommentRequest("tasks/abc-123", "Looks good");
    expect(calls[0]?.url).toBe("/api/app/planner/tasks/abc-123/comments");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ body: "Looks good" });
  });

  it("edits and deletes a comment by its own, encoded id", async () => {
    const calls = stubFetch(200, { comment: {}, ok: true });
    await plannerUpdateCommentRequest(
      "5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11",
      "Edited",
    );
    await plannerDeleteCommentRequest("5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11");
    await plannerDeleteCommentRequest("odd id/with?chars");
    expect(calls[0]?.url).toBe(
      "/api/app/planner/comments/5b0e6a6c-6c0f-4d3a-9a52-1f3f0f0c2f11",
    );
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[0])).toEqual({ body: "Edited" });
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.init.body).toBeUndefined();
    expect(calls[2]?.url).toBe(
      "/api/app/planner/comments/odd%20id%2Fwith%3Fchars",
    );
  });

  it("says why a comment could not be saved: the throttle, or the server's own message", async () => {
    stubFetch(429, { error: { message: "Too many requests." } });
    const throttled = await plannerAddCommentRequest("tasks/a", "hi").catch(
      (caught: unknown) => caught,
    );
    expect(plannerIsRateLimited(throttled)).toBe(true);

    stubFetch(400, { error: { message: "A comment cannot be empty." } });
    const refused = await plannerAddCommentRequest("tasks/a", "  ").catch(
      (caught: unknown) => caught,
    );
    expect(plannerErrorMessage(refused, "Couldn't comment", "Slow down")).toBe(
      "A comment cannot be empty.",
    );
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
