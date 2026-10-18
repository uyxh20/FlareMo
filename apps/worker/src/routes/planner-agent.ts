import { PLANNER_AGENT_KEY_NAME } from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  deleteMemosPersonalAccessToken,
  getAuthUserIdByFlaremoUserId,
  listMemosPersonalAccessTokens,
} from "@flaremo/domain";
import {
  type PlannerAgentJob,
  type PlannerAgentRunRow,
  plannerAgentAttachSession,
  plannerAgentBudget,
  plannerAgentCreateRun,
  plannerAgentEndRun,
  plannerAgentIdleRuns,
  plannerAgentMcpServers,
  plannerAgentMonthSpend,
  plannerAgentRecordCost,
  plannerAgentRunOfSession,
  plannerAgentSetStep,
  plannerAgentStepDone,
  plannerAgentTools,
} from "@flaremo/domain/src/planner";
import { getPublicUrl, MEMOS_PAT_CONFIG_ID } from "../auth-env";
import { loadAuthFactory } from "../context";
import type { FlareMoEnv } from "../env";

// The general agent's client (fork-owned add-on, docs/fork-general-agent.md).
// One Claude Managed Agent does the reviews, the period chapters, the goal
// check and the Ask chat. scripts/fork/general-agent.ts sets up the agent, its
// environment, its memory store and its vault, and FLAREMO_AGENT,
// _ENVIRONMENT, _STORE and _VAULT name them; ANTHROPIC_API_KEY is the Worker
// secret it already uses.
//
// The agent reads the record live through its own MCP server
// (planner-agent-mcp.ts) with a key the Worker makes for it and puts in the
// vault itself (ensureKey). One session per review or conversation: starting
// it sends the first step, every later step is one message, and the page asks
// every few seconds until the answer is there. Each session has a hard cap,
// the per-run stop or what is left of the month, whichever is less
// (FLAREMO_AGENT_RUN_USD, default $5, and FLAREMO_AGENT_MONTH_USD, default
// $30); planner_agent_run keeps what each one cost.
//
// Nothing is logged but the step and the error message: never a message, an
// answer or a key.

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const AGENTS_BETA = "managed-agents-2026-04-01";
const DEFAULT_RUN_USD = 5;
const DEFAULT_MONTH_USD = 30;
/** Events and output files show up a few seconds after the session goes idle. */
const OUTPUT_LAG_MS = 20_000;
const MEMO_FILE = "memo.md";
/** The agent's key lives this long and is replaced in its last two weeks. */
const KEY_DAYS = 90;
const KEY_RENEW_DAYS = 14;
const DAY_MS = 86_400_000;
/** A session no step has touched for this long is ended by the nightly sweep. */
export const PLANNER_AGENT_IDLE_MS = 12 * 60 * 60 * 1_000;

export type PlannerAgent = {
  apiKey: string;
  agentId: string;
  environmentId: string;
  storeId: string;
  vaultId: string;
  /** The per-run stop and the monthly cap, in US cents. */
  runCents: number;
  monthCents: number;
  /** Where the agent's MCP server is, as its vault credential names it. */
  mcpUrl: string;
};

function dollars(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Math.round(
    (Number.isFinite(number) && number > 0 ? number : fallback) * 100,
  );
}

/** The configured agent, or null when this deployment runs without it. */
export function plannerAgent(env: FlareMoEnv): PlannerAgent | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const agentId = env.FLAREMO_AGENT?.trim();
  const environmentId = env.FLAREMO_AGENT_ENVIRONMENT?.trim();
  const storeId = env.FLAREMO_AGENT_STORE?.trim();
  const vaultId = env.FLAREMO_AGENT_VAULT?.trim();
  if (!apiKey || !agentId || !environmentId || !storeId || !vaultId) {
    return null;
  }
  let origin: string;
  try {
    origin = getPublicUrl(env);
  } catch {
    return null;
  }
  const [server] = plannerAgentMcpServers(origin);
  if (!server) return null;
  return {
    apiKey,
    agentId,
    environmentId,
    storeId,
    vaultId,
    runCents: dollars(env.FLAREMO_AGENT_RUN_USD, DEFAULT_RUN_USD),
    monthCents: dollars(env.FLAREMO_AGENT_MONTH_USD, DEFAULT_MONTH_USD),
    mcpUrl: server.url,
  };
}

/** The agent cannot take a job: not set up, or the month's cap is spent. */
export class PlannerAgentUnavailableError extends Error {
  constructor(readonly code: "ai_unavailable" | "agent_month_cap") {
    super(
      code === "agent_month_cap"
        ? "This month's agent budget is used up."
        : "The agent is not available.",
    );
    this.name = "PlannerAgentUnavailableError";
  }
}

class PlannerAgentApiError extends Error {
  constructor(
    step: string,
    readonly status: number,
  ) {
    super(`agent ${step} answered ${status}`);
    this.name = "PlannerAgentApiError";
  }
}

function headers(agent: PlannerAgent, beta = true): HeadersInit {
  return {
    "x-api-key": agent.apiKey,
    "anthropic-version": VERSION,
    ...(beta ? { "anthropic-beta": AGENTS_BETA } : {}),
  };
}

async function call<T>(
  agent: PlannerAgent,
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
    throw new PlannerAgentApiError(step, response.status);
  }
  return (await response.json()) as T;
}

async function remove(agent: PlannerAgent, path: string, beta: boolean) {
  await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: headers(agent, beta),
  })
    .then((response) => response.body?.cancel())
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// The agent's key
// ---------------------------------------------------------------------------

type Credential = {
  id: string;
  archived_at?: string | null;
  auth?: { type?: string; mcp_server_url?: string };
};

/** Scheme and host lowercased, no trailing slash: how the vault matches URLs. */
function sameServer(a: string | undefined, b: string): boolean {
  const norm = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return value;
    }
  };
  return typeof a === "string" && norm(a) === norm(b);
}

function time(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const at =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(at) ? at : null;
}

/**
 * Makes sure the agent's vault holds a live key for its MCP server. The key is
 * an ordinary personal access token with the reserved name, so it shows in
 * Settings and can be revoked there; a revoked, missing or nearly expired key
 * is replaced here before the next session. Its value goes to the vault and
 * nowhere else.
 */
async function ensureKey(
  agent: PlannerAgent,
  input: { db: FlareMoDb; env: FlareMoEnv; authUserId: string; now: number },
): Promise<void> {
  const listed = await call<{ data: Credential[] }>(
    agent,
    "vault",
    `/vaults/${agent.vaultId}/credentials?limit=100`,
  );
  const credentials = listed.data.filter(
    (credential) =>
      !credential.archived_at &&
      sameServer(credential.auth?.mcp_server_url, agent.mcpUrl),
  );
  const keys = (
    await listMemosPersonalAccessTokens(input.db, input.authUserId)
  ).filter((key) => key.name === PLANNER_AGENT_KEY_NAME);
  const live = keys.filter((key) => {
    const expires = time(key.expiresAt);
    return (
      key.enabled !== false &&
      (expires === null || expires > input.now + KEY_RENEW_DAYS * DAY_MS)
    );
  });
  if (credentials.length === 1 && keys.length === 1 && live.length === 1) {
    return;
  }
  const { createFlareMoAuth } = await loadAuthFactory();
  const auth = createFlareMoAuth(input.env, input.db);
  const created = await auth.api.createApiKey({
    body: {
      configId: MEMOS_PAT_CONFIG_ID,
      userId: input.authUserId,
      name: PLANNER_AGENT_KEY_NAME,
      expiresIn: KEY_DAYS * 24 * 60 * 60,
    },
  });
  try {
    for (const credential of credentials) {
      await call(
        agent,
        "vault",
        `/vaults/${agent.vaultId}/credentials/${credential.id}/archive`,
        { body: {} },
      );
    }
    await call(agent, "vault", `/vaults/${agent.vaultId}/credentials`, {
      body: {
        display_name: "Schizo Diary (read-only)",
        auth: {
          type: "static_bearer",
          mcp_server_url: agent.mcpUrl,
          token: created.key,
        },
      },
    });
  } catch (error) {
    await deleteMemosPersonalAccessToken(input.db, {
      authUserId: input.authUserId,
      keyId: created.id,
    });
    throw error;
  }
  for (const key of keys) {
    await deleteMemosPersonalAccessToken(input.db, {
      authUserId: input.authUserId,
      keyId: key.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type Session = {
  status: "rescheduling" | "running" | "idle" | "terminated";
  updated_at: string;
  metadata?: Record<string, string>;
  usage?: { list_cost?: { amount?: string; currency?: string } };
};

type SessionEvent = {
  type: string;
  processed_at?: string | null;
  content?: Array<{ type?: string; text?: unknown }>;
  stop_reason?: { type?: string } | null;
};

function costOf(session: Session): number | null {
  const amount = Number(session.usage?.list_cost?.amount);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

const userMessage = (text: string) => ({
  type: "user.message",
  content: [{ type: "text", text }],
});

/**
 * Starts a session for one job: checks the month's budget, makes sure the
 * agent's key is in its vault, records the run, then creates the session with
 * its first step. An Ask session cannot propose and only reads its notes.
 * Returns the session and its run; throws PlannerAgentUnavailableError at the
 * cap.
 */
export async function plannerStartAgent(
  agent: PlannerAgent,
  input: {
    db: FlareMoDb;
    env: FlareMoEnv;
    user: UserRow;
    authUserId?: string | null;
    job: PlannerAgentJob;
    ownerKey: string;
    step: string;
    stepInput?: unknown;
    message: string;
    title: string;
    startedBy?: "owner" | "schedule";
    now?: Date;
  },
): Promise<{ sessionId: string; runId: string }> {
  const now = input.now ?? new Date();
  const { db, user } = input;
  const spend = await plannerAgentMonthSpend(db, { userId: user.id, now });
  const budget = plannerAgentBudget({
    runCents: agent.runCents,
    monthCents: agent.monthCents,
    ...spend,
  });
  if (budget === 0) throw new PlannerAgentUnavailableError("agent_month_cap");
  const authUserId =
    input.authUserId ?? (await getAuthUserIdByFlaremoUserId(db, user.id));
  if (!authUserId) throw new PlannerAgentUnavailableError("ai_unavailable");
  await ensureKey(agent, {
    db,
    env: input.env,
    authUserId,
    now: now.getTime(),
  });
  const run = await plannerAgentCreateRun(db, {
    userId: user.id,
    job: input.job,
    ownerKey: input.ownerKey,
    budgetCents: budget,
    startedBy: input.startedBy,
    step: input.step,
    stepInput: input.stepInput,
    now,
  });
  const ask = input.job === "ask";
  try {
    const session = await call<{ id: string }>(agent, "start", "/sessions", {
      body: {
        agent: ask
          ? {
              type: "agent_with_overrides",
              id: agent.agentId,
              tools: plannerAgentTools({ propose: false }),
            }
          : agent.agentId,
        environment_id: agent.environmentId,
        title: input.title,
        // Whose it is and what it is for: every later call checks both.
        metadata: { user: user.id, key: input.ownerKey, run: run.id },
        resources: [
          {
            type: "memory_store",
            memory_store_id: agent.storeId,
            access: ask ? "read_only" : "read_write",
          },
        ],
        vault_ids: [agent.vaultId],
        budget: {
          type: "limit",
          max_list_cost: { amount: String(budget), currency: "USD" },
        },
        initial_events: [userMessage(input.message)],
      },
    });
    await plannerAgentAttachSession(db, {
      runId: run.id,
      sessionId: session.id,
    });
    return { sessionId: session.id, runId: run.id };
  } catch (error) {
    await plannerAgentEndRun(db, {
      runId: run.id,
      state: "failed",
      error: error instanceof Error ? error.message : "start failed",
    });
    throw error;
  }
}

/** The run and session when both are this user's, this job's, and open. */
async function ownedSession(
  agent: PlannerAgent,
  db: FlareMoDb,
  input: { userId: string; ownerKey: string; sessionId: string },
): Promise<{ run: PlannerAgentRunRow; session: Session } | null> {
  if (!/^sesn_[A-Za-z0-9]+$/.test(input.sessionId)) return null;
  const run = await plannerAgentRunOfSession(db, input);
  if (run?.state !== "open" || run.ownerKey !== input.ownerKey) {
    return null;
  }
  let session: Session;
  try {
    session = await call<Session>(
      agent,
      "status",
      `/sessions/${input.sessionId}`,
    );
  } catch (error) {
    if (error instanceof PlannerAgentApiError && error.status === 404) {
      await plannerAgentEndRun(db, {
        runId: run.id,
        state: "failed",
        error: "session gone",
      });
      return null;
    }
    throw error;
  }
  if (
    session.metadata?.user !== input.userId ||
    session.metadata?.key !== input.ownerKey
  ) {
    return null;
  }
  return { run, session };
}

/**
 * Sends one step to a session. `missing` when the session is not there, not
 * this user's and job's, ended, or paused at its budget.
 */
export async function plannerSendAgent(
  agent: PlannerAgent,
  db: FlareMoDb,
  input: {
    userId: string;
    ownerKey: string;
    sessionId: string;
    step: string;
    stepInput?: unknown;
    message: string;
  },
): Promise<"sent" | "missing"> {
  const owned = await ownedSession(agent, db, input);
  if (!owned || owned.session.status === "terminated") return "missing";
  try {
    await call(agent, "message", `/sessions/${input.sessionId}/events`, {
      body: { events: [userMessage(input.message)] },
    });
  } catch (error) {
    // A session paused at its cap takes no new step.
    if (error instanceof PlannerAgentApiError && error.status === 400) {
      return "missing";
    }
    throw error;
  }
  await plannerAgentSetStep(db, {
    runId: owned.run.id,
    step: input.step,
    stepInput: input.stepInput,
  });
  return "sent";
}

export type PlannerAgentState =
  | { status: "running" }
  /** The agent's messages since the last step was sent, oldest first. */
  | { status: "done"; texts: string[]; run: PlannerAgentRunRow }
  | { status: "failed" }
  | { status: "missing" }
  /** The run is past the step asked about. */
  | { status: "moved"; run: PlannerAgentRunRow };

/** Every event of the session in the order it happened. */
async function readEvents(
  agent: PlannerAgent,
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
 * to it. Records what the session has cost so far. `missing` is a session
 * that is not there or not this user's and job's.
 */
export async function plannerPollAgent(
  agent: PlannerAgent,
  db: FlareMoDb,
  input: {
    userId: string;
    ownerKey: string;
    sessionId: string;
    /** The step asked about; another request may have moved the run on. */
    step?: string;
  },
  now = Date.now(),
): Promise<PlannerAgentState> {
  const owned = await ownedSession(agent, db, input);
  if (!owned) return { status: "missing" };
  const { run, session } = owned;
  if (input.step !== undefined && run.step !== input.step) {
    return { status: "moved", run };
  }
  const cost = costOf(session);
  if (cost !== null && cost !== run.costCents) {
    await plannerAgentRecordCost(db, { runId: run.id, costCents: cost });
  }
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
  if (texts.length && idle) {
    await plannerAgentStepDone(db, { runId: run.id, costCents: cost });
    return { status: "done", texts, run };
  }
  // Idle without an answer: give the events a moment to show up.
  return now - Date.parse(session.updated_at) < OUTPUT_LAG_MS
    ? { status: "running" }
    : { status: "failed" };
}

/** The newest memo.md the agent wrote in the session, or null. */
export async function plannerReadAgentMemo(
  agent: PlannerAgent,
  sessionId: string,
): Promise<string | null> {
  const files = await call<{
    data: Array<{ id: string; filename: string; created_at?: string }>;
  }>(agent, "outputs", `/files?scope_id=${sessionId}`, { beta: false });
  const output = files.data
    .filter((file) => file.filename.endsWith(MEMO_FILE))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!output) return null;
  const response = await fetch(`${API}/files/${output.id}/content`, {
    headers: headers(agent, false),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlannerAgentApiError("download", response.status);
  }
  const memo = await response.text();
  return memo.trim() ? memo : null;
}

/**
 * Ends a run: reads what its session cost, then deletes the session with
 * everything it wrote. Never throws; a session already gone just closes the
 * run.
 */
export async function plannerEndAgent(
  agent: PlannerAgent,
  db: FlareMoDb,
  input: { userId: string; sessionId: string; failed?: boolean },
): Promise<void> {
  const run = await plannerAgentRunOfSession(db, input).catch(() => null);
  if (run?.state !== "open") return;
  let cost: number | null = null;
  try {
    const session = await call<Session>(
      agent,
      "status",
      `/sessions/${input.sessionId}`,
    );
    cost = costOf(session);
    const outputs = await call<{ data: Array<{ id: string }> }>(
      agent,
      "outputs",
      `/files?scope_id=${input.sessionId}`,
      { beta: false },
    )
      .then((list) => list.data)
      .catch(() => []);
    await remove(agent, `/sessions/${input.sessionId}`, true);
    await Promise.all(
      outputs.map((file) => remove(agent, `/files/${file.id}`, false)),
    );
  } catch {
    // Best effort: an orphan session costs storage, not money.
  }
  await plannerAgentEndRun(db, {
    runId: run.id,
    state: input.failed ? "failed" : "ended",
    costCents: cost,
  }).catch(() => {});
}

/**
 * The nightly sweep: ends every session no step has touched for twelve hours
 * (a review left half done, a prepared review never opened, an Ask chat put
 * down). Runs without the agent too, to close runs whose session never
 * started.
 */
export async function plannerSweepAgentRuns(
  agent: PlannerAgent | null,
  db: FlareMoDb,
  now: Date,
): Promise<number> {
  const idle = await plannerAgentIdleRuns(db, {
    before: new Date(now.getTime() - PLANNER_AGENT_IDLE_MS).toISOString(),
  });
  for (const run of idle) {
    if (agent && run.sessionId) {
      await plannerEndAgent(agent, db, {
        userId: run.userId,
        sessionId: run.sessionId,
      });
    } else {
      await plannerAgentEndRun(db, {
        runId: run.id,
        state: "failed",
        error: run.sessionId ? "agent not configured" : "never started",
      });
    }
  }
  return idle.length;
}

/** One line for the Worker's log when the agent fails: no message, no answer. */
export function plannerLogAgentError(step: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "General agent failed",
      step,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }),
  );
}
