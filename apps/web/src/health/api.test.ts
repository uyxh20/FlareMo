import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/api/client";
import { healthFetchWeek, healthLoadMemoEntries } from "./api";
import { healthTestEntry } from "./test-fixtures";

vi.mock("@/api/client", () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loading labels", () => {
  it("sends the cards of one page as ONE request", async () => {
    request.mockResolvedValue({
      memos: { m1: [healthTestEntry()], m2: [] },
    });
    const a = healthLoadMemoEntries("m1");
    const b = healthLoadMemoEntries("m2");
    const c = healthLoadMemoEntries("m3");
    await vi.advanceTimersByTimeAsync(30);
    expect(request).toHaveBeenCalledTimes(1);
    const url = String(request.mock.calls[0]?.[0]);
    expect(url).toContain("/api/app/health-tracker/memos?ids=");
    expect(decodeURIComponent(url)).toContain("m1,m2,m3");
    expect(await a).toHaveLength(1);
    expect(await b).toEqual([]);
    // A memo the server did not mention has no labels.
    expect(await c).toEqual([]);
  });

  it("asks once for a memo that two cards want", async () => {
    request.mockResolvedValue({ memos: { m1: [] } });
    const first = healthLoadMemoEntries("m1");
    const second = healthLoadMemoEntries("m1");
    await vi.advanceTimersByTimeAsync(30);
    expect(decodeURIComponent(String(request.mock.calls[0]?.[0]))).toMatch(
      /ids=m1$/,
    );
    await Promise.all([first, second]);
  });

  it("splits a very long page into requests of 100", async () => {
    request.mockResolvedValue({ memos: {} });
    const loads = Array.from({ length: 130 }, (_, i) =>
      healthLoadMemoEntries(`m${i}`),
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(request).toHaveBeenCalledTimes(2);
    await Promise.all(loads);
  });

  it("fails every waiting card when the request fails", async () => {
    request.mockRejectedValue(new Error("offline"));
    const a = healthLoadMemoEntries("m1");
    const b = healthLoadMemoEntries("m2");
    const results = Promise.allSettled([a, b]);
    await vi.advanceTimersByTimeAsync(30);
    expect((await results).map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    // The next page starts clean.
    request.mockResolvedValue({ memos: { m9: [] } });
    const next = healthLoadMemoEntries("m9");
    await vi.advanceTimersByTimeAsync(30);
    expect(await next).toEqual([]);
  });
});

describe("the week", () => {
  it("reads the last seven days unless a start is given", async () => {
    request.mockResolvedValue({});
    await healthFetchWeek();
    await healthFetchWeek("2026-10-06");
    expect(request.mock.calls[0]?.[0]).toBe("/api/app/health-tracker/week");
    expect(request.mock.calls[1]?.[0]).toBe(
      "/api/app/health-tracker/week?start=2026-10-06",
    );
  });
});
