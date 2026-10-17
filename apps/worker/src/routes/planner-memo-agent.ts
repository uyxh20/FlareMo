import type { FlareMoEnv } from "../env";

// The weekly memo agent's client (fork-owned add-on,
// docs/fork-review-memo-agent.md). A Claude Managed Agent writes the Sunday
// summary memo when FLAREMO_REVIEW_MEMO_AGENT, _ENVIRONMENT and _STORE name
// the agent, its sandbox and its memory store (scripts/fork/review-memo-agent.ts
// sets them up) and ANTHROPIC_API_KEY is set. A session takes minutes, so it
// runs in two steps: one request uploads the files and starts the session, and
// the page then asks every few seconds until the memo is there. The session and
// its files are deleted as soon as the memo is read.
//
// Nothing is logged but the step and the error message: never a file, a memo
// or the key.

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const AGENTS_BETA = "managed-agents-2026-04-01";
/** The most one memo may cost at list price, unless FLAREMO_REVIEW_MEMO_BUDGET_USD says otherwise. */
const DEFAULT_BUDGET_USD = 3;
/** Output files show up a few seconds after the session goes idle. */
const OUTPUT_LAG_MS = 20_000;
const MEMO_FILE = "memo.md";

export type PlannerMemoAgent = {
  apiKey: string;
  agentId: string;
  environmentId: string;
  storeId: string;
  budgetCents: number;
};

/** The configured memo agent, or null when the memo is written by the review's model. */
export function plannerMemoAgent(env: FlareMoEnv): PlannerMemoAgent | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const agentId = env.FLAREMO_REVIEW_MEMO_AGENT?.trim();
  const environmentId = env.FLAREMO_REVIEW_MEMO_ENVIRONMENT?.trim();
  const storeId = env.FLAREMO_REVIEW_MEMO_STORE?.trim();
  if (!apiKey || !agentId || !environmentId || !storeId) return null;
  const budget = Number(env.FLAREMO_REVIEW_MEMO_BUDGET_USD);
  return {
    apiKey,
    agentId,
    environmentId,
    storeId,
    budgetCents: Math.round(
      (Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_USD) *
        100,
    ),
  };
}

class PlannerAgentError extends Error {
  constructor(step: string, status: number) {
    super(`memo agent ${step} answered ${status}`);
    this.name = "PlannerAgentError";
  }
}

function headers(agent: PlannerMemoAgent, beta = true): HeadersInit {
  return {
    "x-api-key": agent.apiKey,
    "anthropic-version": VERSION,
    ...(beta ? { "anthropic-beta": AGENTS_BETA } : {}),
  };
}

async function call<T>(
  agent: PlannerMemoAgent,
  step: string,
  path: string,
  init: { method?: string; body?: unknown; beta?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...headers(agent, init.beta ?? true),
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlannerAgentError(step, response.status);
  }
  return (await response.json()) as T;
}

async function upload(
  agent: PlannerMemoAgent,
  name: string,
  content: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/plain" }));
  const response = await fetch(`${API}/files`, {
    method: "POST",
    headers: headers(agent, false),
    body: form,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlannerAgentError("upload", response.status);
  }
  return ((await response.json()) as { id: string }).id;
}

async function remove(agent: PlannerMemoAgent, path: string, beta: boolean) {
  await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: headers(agent, beta),
  })
    .then((response) => response.body?.cancel())
    .catch(() => {});
}

/**
 * Uploads the files, starts a session on them with the memory store attached
 * and a hard budget, and sends the kickoff. Returns the session id.
 */
export async function plannerStartMemoAgent(
  agent: PlannerMemoAgent,
  input: {
    userId: string;
    weekStart: string;
    files: Record<string, string>;
    kickoff: string;
  },
): Promise<string> {
  const uploaded: Array<{ id: string; path: string }> = [];
  try {
    for (const [path, content] of Object.entries(input.files)) {
      uploaded.push({
        id: await upload(agent, path.slice(path.lastIndexOf("/") + 1), content),
        path,
      });
    }
    const session = await call<{ id: string }>(agent, "start", "/sessions", {
      body: {
        agent: agent.agentId,
        environment_id: agent.environmentId,
        title: `Weekly memo ${input.weekStart}`,
        // Who it is for, and what to delete once the memo is read.
        metadata: {
          user: input.userId,
          week: input.weekStart,
          files: uploaded.map((file) => file.id).join(","),
        },
        resources: [
          ...uploaded.map((file) => ({
            type: "file",
            file_id: file.id,
            mount_path: file.path,
          })),
          {
            type: "memory_store",
            memory_store_id: agent.storeId,
            access: "read_write",
          },
        ],
        budget: {
          type: "limit",
          max_list_cost: { amount: String(agent.budgetCents), currency: "USD" },
        },
      },
    });
    try {
      await call(agent, "kickoff", `/sessions/${session.id}/events`, {
        body: {
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: input.kickoff }],
            },
          ],
        },
      });
    } catch (error) {
      await remove(agent, `/sessions/${session.id}`, true);
      throw error;
    }
    return session.id;
  } catch (error) {
    await Promise.all(
      uploaded.map((file) => remove(agent, `/files/${file.id}`, false)),
    );
    throw error;
  }
}

export type PlannerMemoAgentState =
  | { status: "running" }
  | { status: "done"; memo: string }
  | { status: "failed" }
  | { status: "missing" };

type Session = {
  status: "rescheduling" | "running" | "idle" | "terminated";
  updated_at: string;
  metadata?: Record<string, string>;
  usage?: { output_tokens?: number };
};

/**
 * Where the session stands. Once it has finished, the memo is read, and the
 * session and its uploaded files are deleted. `missing` is a session that is
 * not there or not this user's.
 */
export async function plannerPollMemoAgent(
  agent: PlannerMemoAgent,
  input: { userId: string; weekStart: string; sessionId: string },
  now = Date.now(),
): Promise<PlannerMemoAgentState> {
  if (!/^sesn_[A-Za-z0-9]+$/.test(input.sessionId))
    return { status: "missing" };
  let session: Session;
  try {
    session = await call<Session>(
      agent,
      "status",
      `/sessions/${input.sessionId}`,
    );
  } catch (error) {
    if (error instanceof PlannerAgentError && error.message.endsWith("404")) {
      return { status: "missing" };
    }
    throw error;
  }
  if (
    session.metadata?.user !== input.userId ||
    session.metadata?.week !== input.weekStart
  ) {
    return { status: "missing" };
  }
  // Still working, or just started (the kickoff not picked up yet).
  if (session.status === "running" || session.status === "rescheduling") {
    return { status: "running" };
  }
  if (session.status === "idle" && !session.usage?.output_tokens) {
    return { status: "running" };
  }

  const files = await call<{ data: Array<{ id: string; filename: string }> }>(
    agent,
    "outputs",
    `/files?scope_id=${input.sessionId}`,
  );
  const output = files.data.find((file) => file.filename.endsWith(MEMO_FILE));
  if (!output && now - Date.parse(session.updated_at) < OUTPUT_LAG_MS) {
    return { status: "running" };
  }
  let memo = "";
  if (output) {
    const response = await fetch(`${API}/files/${output.id}/content`, {
      headers: headers(agent, false),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlannerAgentError("download", response.status);
    }
    memo = await response.text();
  }
  const uploaded = (session.metadata?.files ?? "").split(",").filter(Boolean);
  await Promise.all([
    remove(agent, `/sessions/${input.sessionId}`, true),
    ...[...uploaded, ...files.data.map((file) => file.id)].map((id) =>
      remove(agent, `/files/${id}`, false),
    ),
  ]);
  return memo.trim() ? { status: "done", memo } : { status: "failed" };
}

/** One line for the Worker's log when the agent fails: no file, no memo. */
export function plannerLogAgentError(step: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Weekly memo agent failed",
      step,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }),
  );
}
