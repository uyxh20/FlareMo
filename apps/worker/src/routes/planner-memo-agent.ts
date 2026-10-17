import type { FlareMoEnv } from "../env";

// The weekly review agent's client (fork-owned add-on,
// docs/fork-review-memo-agent.md). A Claude Managed Agent runs the Look back
// part of the review (opening, coach, scores, memo) when
// FLAREMO_REVIEW_MEMO_AGENT, _ENVIRONMENT and _STORE name the agent, its sandbox
// and its memory store (scripts/fork/review-memo-agent.ts sets them up) and
// ANTHROPIC_API_KEY is set. One session per review: the opening uploads the
// week and starts it, every later step is one message to it, and the page asks
// every few seconds until the step's answer is there. The session and its
// files are deleted as soon as the memo is read.
//
// Nothing is logged but the step and the error message: never a file, a memo
// or the key.

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const AGENTS_BETA = "managed-agents-2026-04-01";
/**
 * The most one review's session may cost at list price, unless
 * FLAREMO_REVIEW_MEMO_BUDGET_USD says otherwise.
 */
const DEFAULT_BUDGET_USD = 5;
/** Events and output files show up a few seconds after the session goes idle. */
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

/**
 * Sends one step to a review's session: adds `files` first (replacing any at
 * the same path), then the message. `missing` when the session is not there,
 * not this user's and week's, or ended.
 */
export async function plannerSendMemoAgent(
  agent: PlannerMemoAgent,
  input: {
    userId: string;
    weekStart: string;
    sessionId: string;
    message: string;
    files?: Record<string, string>;
  },
): Promise<"sent" | "missing"> {
  const session = await readSession(agent, input);
  if (!session || session.status === "terminated") return "missing";
  const id = input.sessionId;
  const files = Object.entries(input.files ?? {});
  if (files.length) {
    const resources = await call<{ data: Resource[] }>(
      agent,
      "resources",
      `/sessions/${id}/resources`,
    );
    for (const [path, content] of files) {
      for (const old of resources.data.filter((r) => r.mount_path === path)) {
        await remove(agent, `/sessions/${id}/resources/${old.id}`, true);
        if (old.file_id) await remove(agent, `/files/${old.file_id}`, false);
      }
      const fileId = await upload(
        agent,
        path.slice(path.lastIndexOf("/") + 1),
        content,
      );
      try {
        await call(agent, "add file", `/sessions/${id}/resources`, {
          body: { type: "file", file_id: fileId, mount_path: path },
        });
      } catch (error) {
        await remove(agent, `/files/${fileId}`, false);
        throw error;
      }
    }
  }
  await call(agent, "message", `/sessions/${id}/events`, {
    body: {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: input.message }],
        },
      ],
    },
  });
  return "sent";
}

export type PlannerMemoAgentState =
  | { status: "running" }
  /** The agent's messages since the last step was sent, oldest first. */
  | { status: "done"; texts: string[] }
  | { status: "failed" }
  | { status: "missing" };

type Session = {
  status: "rescheduling" | "running" | "idle" | "terminated";
  updated_at: string;
  metadata?: Record<string, string>;
  usage?: { output_tokens?: number };
};

type Resource = {
  id: string;
  type: string;
  mount_path?: string;
  file_id?: string;
};

type SessionEvent = {
  type: string;
  processed_at?: string | null;
  content?: Array<{ type?: string; text?: unknown }>;
  stop_reason?: { type?: string } | null;
};

/** The session when it is this user's and week's; null otherwise. */
async function readSession(
  agent: PlannerMemoAgent,
  input: { userId: string; weekStart: string; sessionId: string },
): Promise<Session | null> {
  if (!/^sesn_[A-Za-z0-9]+$/.test(input.sessionId)) return null;
  let session: Session;
  try {
    session = await call<Session>(
      agent,
      "status",
      `/sessions/${input.sessionId}`,
    );
  } catch (error) {
    if (error instanceof PlannerAgentError && error.message.endsWith("404")) {
      return null;
    }
    throw error;
  }
  return session.metadata?.user === input.userId &&
    session.metadata?.week === input.weekStart
    ? session
    : null;
}

/** Every event of the session in the order it happened. */
async function readEvents(
  agent: PlannerMemoAgent,
  sessionId: string,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let page: string | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const query: string = page ? `&page=${encodeURIComponent(page)}` : "";
    const list: { data: SessionEvent[]; next_page?: string | null } =
      await call(
        agent,
        "events",
        `/sessions/${sessionId}/events?limit=1000${query}`,
      );
    events.push(...list.data);
    page = list.next_page ?? null;
    if (!page) break;
  }
  // Whatever order the pages come in; an event not processed yet is the latest.
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        (a.event.processed_at ?? "~").localeCompare(
          b.event.processed_at ?? "~",
        ) || a.index - b.index,
    )
    .map(({ event }) => event);
}

const textOf = (event: SessionEvent) =>
  (event.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("")
    .trim();

/**
 * Where the last step stands: still running, or done with the agent's replies
 * to it. `missing` is a session that is not there or not this user's.
 */
export async function plannerPollMemoAgent(
  agent: PlannerMemoAgent,
  input: { userId: string; weekStart: string; sessionId: string },
  now = Date.now(),
): Promise<PlannerMemoAgentState> {
  const session = await readSession(agent, input);
  if (!session) return { status: "missing" };
  if (session.status === "terminated") return { status: "failed" };
  if (session.status === "running" || session.status === "rescheduling") {
    return { status: "running" };
  }
  const events = await readEvents(agent, input.sessionId);
  let last = -1;
  events.forEach((event, index) => {
    if (event.type === "user.message") last = index;
  });
  // The step is queued, not picked up yet.
  if (last < 0 || !events[last]?.processed_at) return { status: "running" };
  const after = events.slice(last + 1);
  const texts = after
    .filter((event) => event.type === "agent.message")
    .map(textOf)
    .filter(Boolean);
  const idle = [...after]
    .reverse()
    .find((event) => event.type === "session.status_idle");
  if (idle?.stop_reason?.type === "budget_reached") return { status: "failed" };
  if (texts.length && idle) return { status: "done", texts };
  // Idle without an answer: give the events a moment to show up.
  return now - Date.parse(session.updated_at) < OUTPUT_LAG_MS
    ? { status: "running" }
    : { status: "failed" };
}

/** The newest memo.md the agent wrote in the session, or null. */
export async function plannerReadMemoAgentMemo(
  agent: PlannerMemoAgent,
  sessionId: string,
): Promise<string | null> {
  const files = await call<{
    data: Array<{ id: string; filename: string; created_at?: string }>;
  }>(agent, "outputs", `/files?scope_id=${sessionId}`);
  const output = files.data
    .filter((file) => file.filename.endsWith(MEMO_FILE))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!output) return null;
  const response = await fetch(`${API}/files/${output.id}/content`, {
    headers: headers(agent, false),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlannerAgentError("download", response.status);
  }
  const memo = await response.text();
  return memo.trim() ? memo : null;
}

/**
 * Deletes a review's session with everything uploaded to it and everything it
 * wrote. Never throws.
 */
export async function plannerEndMemoAgent(
  agent: PlannerMemoAgent,
  input: { userId: string; weekStart: string; sessionId: string },
): Promise<void> {
  try {
    const session = await readSession(agent, input);
    if (!session) return;
    const id = input.sessionId;
    const [resources, outputs] = await Promise.all([
      call<{ data: Resource[] }>(
        agent,
        "resources",
        `/sessions/${id}/resources`,
      )
        .then((list) => list.data)
        .catch(() => [] as Resource[]),
      call<{ data: Array<{ id: string }> }>(
        agent,
        "outputs",
        `/files?scope_id=${id}`,
      )
        .then((list) => list.data)
        .catch(() => []),
    ]);
    const fileIds = new Set([
      ...(session.metadata?.files ?? "").split(",").filter(Boolean),
      ...resources.flatMap((r) => (r.file_id ? [r.file_id] : [])),
      ...outputs.map((file) => file.id),
    ]);
    await remove(agent, `/sessions/${id}`, true);
    await Promise.all(
      [...fileIds].map((fileId) => remove(agent, `/files/${fileId}`, false)),
    );
  } catch {
    // Best effort: an orphan costs storage, not money.
  }
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
