import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlareMoEnv } from "../env";
import {
  type PlannerMemoAgent,
  plannerMemoAgent,
  plannerPollMemoAgent,
  plannerStartMemoAgent,
} from "./planner-memo-agent";

// The memo agent's client (planner-memo-agent.ts), against a fake Anthropic API.

const ENV = {
  ANTHROPIC_API_KEY: "test-key",
  FLAREMO_REVIEW_MEMO_AGENT: "agent_1",
  FLAREMO_REVIEW_MEMO_ENVIRONMENT: "env_1",
  FLAREMO_REVIEW_MEMO_STORE: "memstore_1",
} as FlareMoEnv;
const AGENT = plannerMemoAgent(ENV) as PlannerMemoAgent;

type Call = { method: string; url: string; body?: unknown };

function fakeApi(
  answer: (call: Call) => { status?: number; json?: unknown; text?: string },
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      };
      calls.push(call);
      const { status = 200, json, text } = answer(call);
      return new Response(text ?? JSON.stringify(json ?? {}), { status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the memo agent's settings", () => {
  it("needs the key, the agent, its environment and its memory store", () => {
    expect(AGENT.budgetCents).toBe(300);
    expect(
      plannerMemoAgent({ ...ENV, FLAREMO_REVIEW_MEMO_BUDGET_USD: "1.5" })
        ?.budgetCents,
    ).toBe(150);
    expect(plannerMemoAgent({ ...ENV, FLAREMO_REVIEW_MEMO_STORE: "" })).toBe(
      null,
    );
    expect(plannerMemoAgent({ ...ENV, ANTHROPIC_API_KEY: undefined })).toBe(
      null,
    );
  });
});

describe("starting a memo", () => {
  it("uploads each file, mounts it with the memory store and a budget, then sends the kickoff", async () => {
    let n = 0;
    const calls = fakeApi((call) =>
      call.url.endsWith("/files")
        ? { json: { id: `file_${++n}` } }
        : call.url.endsWith("/sessions")
          ? { json: { id: "sesn_1" } }
          : { json: {} },
    );
    const session = await plannerStartMemoAgent(AGENT, {
      userId: "u1",
      weekStart: "2026-10-05",
      files: { "/data/this-week.md": "week", "/data/review.md": "review" },
      kickoff: "Go.",
    });
    expect(session).toBe("sesn_1");
    expect(calls.map((c) => `${c.method} ${c.url.split("/v1")[1]}`)).toEqual([
      "POST /files",
      "POST /files",
      "POST /sessions",
      "POST /sessions/sesn_1/events",
    ]);
    const body = calls[2]?.body as {
      metadata: Record<string, string>;
      resources: unknown[];
      budget: unknown;
    };
    expect(body.metadata).toEqual({
      user: "u1",
      week: "2026-10-05",
      files: "file_1,file_2",
    });
    expect(body.resources).toEqual([
      { type: "file", file_id: "file_1", mount_path: "/data/this-week.md" },
      { type: "file", file_id: "file_2", mount_path: "/data/review.md" },
      {
        type: "memory_store",
        memory_store_id: "memstore_1",
        access: "read_write",
      },
    ]);
    expect(body.budget).toEqual({
      type: "limit",
      max_list_cost: { amount: "300", currency: "USD" },
    });
  });

  it("deletes what it uploaded when the session cannot start", async () => {
    const calls = fakeApi((call) =>
      call.url.endsWith("/files")
        ? { json: { id: "file_1" } }
        : call.url.endsWith("/sessions")
          ? { status: 400 }
          : { json: {} },
    );
    await expect(
      plannerStartMemoAgent(AGENT, {
        userId: "u1",
        weekStart: "2026-10-05",
        files: { "/data/this-week.md": "week" },
        kickoff: "Go.",
      }),
    ).rejects.toThrow("memo agent start answered 400");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.anthropic.com/v1/files/file_1",
    });
  });
});

describe("asking for the memo", () => {
  const mine = { user: "u1", week: "2026-10-05", files: "file_1,file_2" };
  const input = { userId: "u1", weekStart: "2026-10-05", sessionId: "sesn_1" };
  const now = Date.parse("2026-10-11T18:10:00Z");

  it("waits while the agent works or has not started", async () => {
    for (const session of [
      { status: "running", metadata: mine, usage: { output_tokens: 10 } },
      { status: "idle", metadata: mine, usage: { output_tokens: 0 } },
    ]) {
      fakeApi(() => ({ json: session }));
      expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
        status: "running",
      });
    }
  });

  it("reads the memo once it is done, then deletes the session and every file", async () => {
    const calls = fakeApi((call) =>
      call.url.endsWith("/sessions/sesn_1") && call.method === "GET"
        ? {
            json: {
              status: "idle",
              updated_at: "2026-10-11T18:09:00Z",
              metadata: mine,
              usage: { output_tokens: 900 },
            },
          }
        : call.url.includes("scope_id=sesn_1")
          ? { json: { data: [{ id: "file_out", filename: "memo.md" }] } }
          : call.url.endsWith("/files/file_out/content")
            ? { text: "# Week 41\n\nThe memo." }
            : { json: {} },
    );
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "done",
      memo: "# Week 41\n\nThe memo.",
    });
    const deleted = calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.split("/v1")[1]);
    expect(deleted.sort()).toEqual([
      "/files/file_1",
      "/files/file_2",
      "/files/file_out",
      "/sessions/sesn_1",
    ]);
  });

  it("gives the outputs a moment to show up, then calls it failed", async () => {
    const idle = (updated: string) => () => ({
      json: {
        status: "idle",
        updated_at: updated,
        metadata: mine,
        usage: { output_tokens: 900 },
        data: [],
      },
    });
    fakeApi(idle("2026-10-11T18:09:55Z"));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "running",
    });
    fakeApi(idle("2026-10-11T18:05:00Z"));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "failed",
    });
  });

  it("does not show another user's or another week's session", async () => {
    fakeApi(() => ({
      json: { status: "idle", metadata: { ...mine, user: "u2" } },
    }));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "missing",
    });
    fakeApi(() => ({ status: 404 }));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "missing",
    });
    expect(
      await plannerPollMemoAgent(
        AGENT,
        { ...input, sessionId: "../agents" },
        now,
      ),
    ).toEqual({ status: "missing" });
  });
});
