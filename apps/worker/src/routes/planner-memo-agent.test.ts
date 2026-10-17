import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlareMoEnv } from "../env";
import {
  type PlannerMemoAgent,
  plannerEndMemoAgent,
  plannerMemoAgent,
  plannerPollMemoAgent,
  plannerReadMemoAgentMemo,
  plannerSendMemoAgent,
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
    expect(AGENT.budgetCents).toBe(500);
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
      max_list_cost: { amount: "500", currency: "USD" },
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

describe("a review's later steps", () => {
  const mine = { user: "u1", week: "2026-10-05", files: "file_1,file_2" };
  const input = { userId: "u1", weekStart: "2026-10-05", sessionId: "sesn_1" };
  const now = Date.parse("2026-10-11T18:10:00Z");
  const session = (extra: Record<string, unknown> = {}) => ({
    status: "idle",
    updated_at: "2026-10-11T18:09:00Z",
    metadata: mine,
    ...extra,
  });
  const text = (value: string) => [{ type: "text", text: value }];

  it("adds the step's files in place of any at the same path, then sends the message", async () => {
    let n = 0;
    const calls = fakeApi((call) =>
      call.url.endsWith("/sessions/sesn_1")
        ? { json: session() }
        : call.url.endsWith("/resources") && call.method === "GET"
          ? {
              json: {
                data: [
                  {
                    id: "sesrsc_old",
                    type: "file",
                    mount_path: "/data/review.md",
                    file_id: "file_old",
                  },
                ],
              },
            }
          : call.url.endsWith("/files")
            ? { json: { id: `file_new${++n}` } }
            : { json: {} },
    );
    expect(
      await plannerSendMemoAgent(AGENT, {
        ...input,
        message: "Memo step.",
        files: { "/data/review.md": "answers" },
      }),
    ).toBe("sent");
    expect(calls.map((c) => `${c.method} ${c.url.split("/v1")[1]}`)).toEqual([
      "GET /sessions/sesn_1",
      "GET /sessions/sesn_1/resources",
      "DELETE /sessions/sesn_1/resources/sesrsc_old",
      "DELETE /files/file_old",
      "POST /files",
      "POST /sessions/sesn_1/resources",
      "POST /sessions/sesn_1/events",
    ]);
    expect(calls[5]?.body).toEqual({
      type: "file",
      file_id: "file_new1",
      mount_path: "/data/review.md",
    });
    expect(calls[6]?.body).toEqual({
      events: [{ type: "user.message", content: text("Memo step.") }],
    });
  });

  it("does not send to another user's session or one that ended", async () => {
    fakeApi(() => ({ json: session({ metadata: { ...mine, user: "u2" } }) }));
    expect(
      await plannerSendMemoAgent(AGENT, { ...input, message: "Hi." }),
    ).toBe("missing");
    fakeApi(() => ({ json: session({ status: "terminated" }) }));
    expect(
      await plannerSendMemoAgent(AGENT, { ...input, message: "Hi." }),
    ).toBe("missing");
  });

  it("waits while the agent works or the step is queued", async () => {
    fakeApi(() => ({ json: session({ status: "running" }) }));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "running",
    });
    fakeApi((call) =>
      call.url.includes("/events")
        ? {
            json: {
              data: [
                {
                  type: "user.message",
                  processed_at: null,
                  content: text("Go"),
                },
              ],
            },
          }
        : { json: session() },
    );
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "running",
    });
  });

  it("answers with the agent's replies to the last step only", async () => {
    fakeApi((call) =>
      call.url.includes("/events")
        ? {
            json: {
              data: [
                {
                  type: "user.message",
                  processed_at: "2026-10-11T18:00:00Z",
                  content: text("Opening"),
                },
                {
                  type: "agent.message",
                  processed_at: "2026-10-11T18:01:00Z",
                  content: text('{"recap":"old"}'),
                },
                {
                  type: "session.status_idle",
                  processed_at: "2026-10-11T18:01:01Z",
                },
                {
                  type: "user.message",
                  processed_at: "2026-10-11T18:05:00Z",
                  content: text("Coach"),
                },
                {
                  type: "agent.message",
                  processed_at: "2026-10-11T18:05:20Z",
                  content: text("Let me check the diary."),
                },
                {
                  type: "agent.message",
                  processed_at: "2026-10-11T18:05:40Z",
                  content: text('Which number? @@ {"advance": false}'),
                },
                {
                  type: "session.status_idle",
                  processed_at: "2026-10-11T18:05:41Z",
                  stop_reason: { type: "end_turn" },
                },
              ].reverse(),
            },
          }
        : { json: session() },
    );
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "done",
      texts: ["Let me check the diary.", 'Which number? @@ {"advance": false}'],
    });
  });

  it("calls a step failed at the budget, or idle without an answer for a while", async () => {
    const events = (idle: Record<string, unknown>) => (call: Call) =>
      call.url.includes("/events")
        ? {
            json: {
              data: [
                {
                  type: "user.message",
                  processed_at: "2026-10-11T18:00:00Z",
                  content: text("Go"),
                },
                {
                  type: "session.status_idle",
                  processed_at: "2026-10-11T18:01:00Z",
                  ...idle,
                },
              ],
            },
          }
        : { json: session() };
    fakeApi(events({ stop_reason: { type: "budget_reached" } }));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "failed",
    });
    fakeApi(events({}));
    expect(await plannerPollMemoAgent(AGENT, input, now)).toEqual({
      status: "failed",
    });
  });

  it("does not show another user's or another week's session", async () => {
    fakeApi(() => ({ json: session({ metadata: { ...mine, user: "u2" } }) }));
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

  it("reads the newest memo the agent wrote", async () => {
    fakeApi((call) =>
      call.url.includes("scope_id=sesn_1")
        ? {
            json: {
              data: [
                {
                  id: "file_a",
                  filename: "memo.md",
                  created_at: "2026-10-11T18:00:00Z",
                },
                {
                  id: "file_b",
                  filename: "memo.md",
                  created_at: "2026-10-11T18:30:00Z",
                },
              ],
            },
          }
        : call.url.endsWith("/files/file_b/content")
          ? { text: "# Week 41\n\nThe memo." }
          : { status: 404 },
    );
    expect(await plannerReadMemoAgentMemo(AGENT, "sesn_1")).toBe(
      "# Week 41\n\nThe memo.",
    );
  });

  it("ends a review by deleting the session and every file in it", async () => {
    const calls = fakeApi((call) =>
      call.url.endsWith("/sessions/sesn_1") && call.method === "GET"
        ? { json: session() }
        : call.url.endsWith("/resources")
          ? {
              json: {
                data: [
                  { id: "r1", type: "file", file_id: "file_2" },
                  { id: "r2", type: "file", file_id: "file_3" },
                  { id: "r3", type: "memory_store" },
                ],
              },
            }
          : call.url.includes("scope_id=sesn_1")
            ? { json: { data: [{ id: "file_out" }] } }
            : { json: {} },
    );
    await plannerEndMemoAgent(AGENT, input);
    const deleted = calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.split("/v1")[1]);
    expect(deleted.sort()).toEqual([
      "/files/file_1",
      "/files/file_2",
      "/files/file_3",
      "/files/file_out",
      "/sessions/sesn_1",
    ]);
  });
});
