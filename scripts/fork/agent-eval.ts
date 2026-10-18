// The general agent's eval on dev (fork-owned, docs/fork-general-agent.md):
// runs its five jobs through the dev Worker, exactly as the app does, and
// checks each answer's shape. The answers themselves are judged by reading
// them; this only catches what is plainly broken (an empty memo, a proposal
// with no reason, a question answered with a made-up day, a proposal filed
// from the Ask chat). The Worker tests cover the same jobs with a stub agent.
//
//   FLAREMO_EVAL_TOKEN=<a memos_pat_ token made on dev> \
//     pnpm exec tsx scripts/fork/agent-eval.ts [--jobs ask,back,forward,check,period]
//
// In a Claude cloud session the token can be a network secret instead (the
// Authorization header for dev's host); run with NODE_USE_ENV_PROXY=1 so
// Node's fetch goes through the proxy that adds it.
//
// Dev only: it refuses any other deployment. It leaves what the app would
// leave after an unsaved review: the agent's proposals for next week (open,
// on the Review page), its notes in dev's memory store, and the review's
// session, which the nightly sweep ends. Nothing is saved to a review.
//
// It prints checks and sizes, never the answers: they are the diary's words.
// The answers go to a file outside the repository (--out, default the
// system's temp folder) for reading.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEV } from "./dev-env-config.mjs";

const JOBS = ["ask", "back", "forward", "check", "period"] as const;
type Job = (typeof JOBS)[number];

const { values: args } = parseArgs({
  options: {
    jobs: { type: "string" },
    out: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Without the variable, a network proxy may supply the token (a network
// secret for dev's host); the placeholder is replaced on the way out.
const token = process.env.FLAREMO_EVAL_TOKEN?.trim() || "proxy-injected";
if (token !== "proxy-injected" && !token.startsWith("memos_pat_")) {
  fail("FLAREMO_EVAL_TOKEN is not an access token (memos_pat_…).");
}
const jobs = (args.jobs ?? JOBS.join(","))
  .split(",")
  .map((job) => job.trim()) as Job[];
for (const job of jobs) {
  if (!JOBS.includes(job)) fail(`Unknown job ${job}: use ${JOBS.join(", ")}.`);
}
if (jobs.includes("forward") && !jobs.includes("back")) {
  fail("forward reads the proposals the back job's memo asks for: add back.");
}
if (jobs.includes("check") && !jobs.includes("back")) {
  fail("check runs in the back job's session: add back.");
}

const ORIGIN = DEV.publicUrl;
const PLANNER = `${ORIGIN}/api/app/planner`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Copenhagen",
}).format(new Date());

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T; text: string }> {
  const response = await fetch(`${PLANNER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null as T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    // A streamed answer: one JSON object per line.
  }
  return { status: response.status, json, text };
}

/** The session a step went to: the body's `agent`, or a streamed line's. */
function sessionOf(text: string): string | null {
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line) as { agent?: unknown };
      if (typeof value.agent === "string") return value.agent;
    } catch {
      // Not a line of JSON.
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Asks every few seconds until `ready` holds or the time is up. */
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  minutes: number,
): Promise<T> {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > end) return value;
    await sleep(4000);
  }
}

// --- Results -------------------------------------------------------------

type Check = { job: Job; name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const answers: Record<string, unknown> = {};
const timings: Record<string, number> = {};

function check(job: Job, name: string, ok: boolean, detail?: string) {
  checks.push({ job, name, ok, ...(detail ? { detail } : {}) });
  console.log(
    `  ${ok ? "pass" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`,
  );
}

const DAY = /\b(\d{4}-\d{2}-\d{2})\b/g;
const daysIn = (text: string) => [...text.matchAll(DAY)].map((m) => m[1]);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

// --- The chat steps the weekly and period reviews share -------------------

const ANSWERS = {
  last_answer: ["Partly."],
  answers: [
    ["It was an ordinary week; the eval answers for me."],
    [],
    [],
    [],
    [],
    [],
    [],
  ],
  goal_results: [],
  coach_notes: [],
};

type AgentAnswer = {
  status: "running" | "done" | "failed";
  step?: string;
  [key: string]: unknown;
};

async function step(
  job: Job,
  base: string,
  name: "opening" | "coach" | "close" | "memo",
  body: Record<string, unknown>,
  session: string | null,
): Promise<{ session: string | null; answer: AgentAnswer | null }> {
  const started = Date.now();
  const sent = await request<{ agent?: string }>("POST", `${base}/ai/${name}`, {
    today,
    ...body,
    ...(session ? { session } : {}),
  });
  const sid = sent.json?.agent ?? sessionOf(sent.text);
  check(
    job,
    `${name}: the agent took the step`,
    sent.status === 200 && sid !== null,
    sid ? undefined : `HTTP ${sent.status}`,
  );
  if (!sid) return { session, answer: null };
  const mode = name === "coach" ? "&mode=free" : "";
  const answer = await until(
    async () =>
      (
        await request<AgentAnswer>(
          "GET",
          `${base}/ai/agent/${sid}?today=${today}&step=${name}${mode}`,
        )
      ).json,
    (value) => value?.status !== "running",
    name === "coach" ? 3 : 10,
  );
  timings[`${job}.${name}`] = Math.round((Date.now() - started) / 1000);
  check(
    job,
    `${name}: answered`,
    answer?.status === "done",
    `${answer?.status ?? "no answer"}, ${timings[`${job}.${name}`]}s`,
  );
  answers[`${job}.${name}`] = answer;
  return { session: sid, answer: answer?.status === "done" ? answer : null };
}

async function lookBack(job: Job, base: string, periodWord: string) {
  const opening = await step(job, base, "opening", {}, null);
  const o = opening.answer?.opening as
    | {
        recap: string;
        prompts: string[][];
        happened: unknown[];
        dropped: number;
      }
    | undefined;
  if (o) {
    check(job, "opening: has a recap", o.recap.trim().length > 0);
    check(
      job,
      "opening: options for all seven prompts",
      o.prompts.length === 7,
    );
    check(
      job,
      "opening: every claim in what happened was found in the owner's words",
      o.dropped === 0,
      `${o.happened.length} kept, ${o.dropped} dropped`,
    );
  }
  const session = opening.session;
  if (!session) return null;

  const coach = await step(
    job,
    base,
    "coach",
    {
      mode: "free",
      messages: [
        {
          role: "user",
          content: `How did this ${periodWord} go against my goals? Keep it short.`,
        },
      ],
    },
    session,
  );
  const text = String(coach.answer?.text ?? "");
  check(
    job,
    "coach: a short reply",
    text.length > 0 && text.length < 2000,
    `${text.length} chars`,
  );
  check(
    job,
    "coach: at most one question",
    (text.match(/\?/g) ?? []).length <= 1,
  );

  const close = await step(job, base, "close", ANSWERS, session);
  const scores = (
    close.answer?.close as {
      scores?: { auth: number | null; ach: number | null };
    }
  )?.scores;
  const inRange = (n: number | null | undefined) =>
    typeof n === "number" && n >= 1 && n <= 5 && Number.isInteger(n * 2);
  if (scores) {
    check(
      job,
      "close: both scores 1 to 5 in half steps",
      inRange(scores.auth) && inRange(scores.ach),
    );
  }

  const memo = await step(
    job,
    base,
    "memo",
    {
      ...ANSWERS,
      scores: { auth: 3.5, ach: 3 },
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
    },
    session,
  );
  const m = String(memo.answer?.memo ?? "");
  check(job, "memo: written", m.length > 200, `${m.length} chars`);
  check(job, "memo: starts with its title", m.startsWith("# "));
  check(job, "memo: has its sections", (m.match(/^## /gm) ?? []).length >= 3);
  check(job, "memo: no step markers or JSON left in it", !/@@|^\s*\{/m.test(m));
  return session;
}

// --- The jobs ------------------------------------------------------------

type Proposal = {
  id: string;
  kind: "goal" | "task";
  pillar: string | null;
  title: string;
  goal_ref: string | null;
  why: string;
  quote: string | null;
  source_day: string | null;
  state: string;
};

async function proposals(week: string) {
  return (
    await request<{ proposals: Proposal[]; pending: boolean }>(
      "GET",
      `/review/${week}/proposals?today=${today}`,
    )
  ).json;
}

const enabled = await request<{ enabled: boolean }>(
  "GET",
  `/ask?today=${today}`,
);
if (enabled.status === 401 || enabled.status === 403) {
  fail(
    `Dev refused the token (HTTP ${enabled.status}): make an access token on dev (Settings, Access tokens) and set FLAREMO_EVAL_TOKEN or a network secret for dev's host.`,
  );
}
if (!enabled.json?.enabled) {
  fail(
    "The agent is not set up on dev: run scripts/fork/general-agent.ts --target dev and set its vars on dev (docs/fork-general-agent.md).",
  );
}
const review = (
  await request<{ review_week: string; plan_week: string }>(
    "GET",
    `/review?today=${today}`,
  )
).json;
const week = review.review_week;
const planWeek = review.plan_week;
console.log(
  `Eval on ${ORIGIN}, today ${today}, week ${week}, plan week ${planWeek}.`,
);

let reviewSession: string | null = null;
let proposed: Proposal[] = [];

if (jobs.includes("ask")) {
  console.log("\nAsk my diary");
  const before = (await proposals(week)).proposals.length;
  const ask = async (text: string, conversation?: string) => {
    const started = Date.now();
    const sent = await request<{ conversation: string }>("POST", "/ask", {
      today,
      text,
      ...(conversation ? { conversation } : {}),
    });
    check("ask", "asked", sent.status === 200, `HTTP ${sent.status}`);
    const id = sent.json?.conversation;
    if (!id) return { id: null, answer: "" };
    const read = await until(
      async () =>
        (
          await request<{
            status: string;
            messages: Array<{ role: string; text: string }>;
          }>("GET", `/ask?today=${today}&conversation=${id}`)
        ).json,
      (value) => value?.status !== "running",
      6,
    );
    const last = read?.messages.at(-1);
    const answer = last?.role === "agent" ? last.text : "";
    check(
      "ask",
      "answered",
      answer.length > 0,
      `${answer.length} chars, ${Math.round((Date.now() - started) / 1000)}s`,
    );
    return { id, answer };
  };
  const recent = await ask(
    "What did I write about most in the last two weeks? Name the days.",
  );
  answers["ask.recent"] = recent.answer;
  const cited = daysIn(recent.answer);
  check(
    "ask",
    "the answer names days in the span it was asked about",
    cited.length > 0 &&
      cited.every((day) => day >= addDays(today, -21) && day <= today),
    `${cited.length} days named`,
  );
  const follow = await ask(
    "And what did I write on 1999-01-01?",
    recent.id ?? undefined,
  );
  answers["ask.unrecorded"] = follow.answer;
  check(
    "ask",
    "a day with no entry is said to be unrecorded",
    /not recorded|no entr|nothing|not find|can't find|cannot find|don't have|doesn't|does not|no record/i.test(
      follow.answer,
    ),
  );
  if (recent.id) await request("POST", `/ask/${recent.id}/end`, {});
  check(
    "ask",
    "the chat proposed nothing",
    (await proposals(week)).proposals.length === before,
  );
}

if (jobs.includes("back")) {
  console.log("\nLook back (the weekly review)");
  reviewSession = await lookBack("back", `/review/${week}`, "week");
}

if (jobs.includes("forward")) {
  console.log("\nLook forward (proposals for next week)");
  const started = Date.now();
  const read = await until(
    () => proposals(week),
    (value) => value?.pending === false,
    10,
  );
  check(
    "forward",
    "the agent finished proposing",
    read?.pending === false,
    `${Math.round((Date.now() - started) / 1000)}s`,
  );
  proposed = (read?.proposals ?? []).filter((p) => p.state === "open");
  answers.forward = proposed;
  const goals = proposed.filter((p) => p.kind === "goal");
  const tasks = proposed.filter((p) => p.kind === "task");
  check(
    "forward",
    "proposed something",
    proposed.length > 0,
    `${goals.length} goals, ${tasks.length} tasks`,
  );
  check(
    "forward",
    "at most one goal per objective",
    new Set(goals.map((g) => g.pillar)).size === goals.length &&
      goals.length <= 4,
  );
  check("forward", "at most six tasks", tasks.length <= 6);
  check(
    "forward",
    "every proposal says why",
    proposed.every((p) => p.why.trim().length > 0),
  );
  check(
    "forward",
    "every quote has its day",
    proposed.every((p) => !p.quote || p.source_day !== null),
  );
  check(
    "forward",
    "every task names a goal",
    tasks.every((t) => t.goal_ref !== null),
  );
}

if (jobs.includes("check") && reviewSession) {
  console.log("\nGoal check");
  const goals = proposed
    .filter((p) => p.kind === "goal")
    .map((p) => ({
      id: crypto.randomUUID(),
      pillar: p.pillar,
      title: p.title.slice(0, 200),
      tasks: proposed
        .filter((t) => t.kind === "task" && t.goal_ref === p.id)
        .map((t) => t.title.slice(0, 200)),
    }));
  const plan = goals.length
    ? goals
    : [
        {
          id: crypto.randomUUID(),
          pillar: "work",
          title: "Finish the agent eval",
          tasks: [],
        },
      ];
  const started = Date.now();
  const sent = await request<{ agent?: string }>(
    "POST",
    `/review/${week}/ai/check`,
    {
      today,
      goals: plan,
      settled: [],
      session: reviewSession,
    },
  );
  check(
    "check",
    "the agent took the step",
    sent.json?.agent === reviewSession,
    `HTTP ${sent.status}`,
  );
  const answer = await until(
    async () =>
      (
        await request<AgentAnswer>(
          "GET",
          `/review/${week}/ai/agent/${reviewSession}?today=${today}&step=check`,
        )
      ).json,
    (value) => value?.status !== "running",
    6,
  );
  answers.check = answer;
  const flags = (
    answer?.check as { flags?: Array<{ goal_id: string | null; why: string }> }
  )?.flags;
  check(
    "check",
    "answered",
    answer?.status === "done" && Array.isArray(flags),
    `${flags?.length ?? 0} flags, ${Math.round((Date.now() - started) / 1000)}s`,
  );
  const ids = new Set<string>(plan.map((g) => g.id));
  check(
    "check",
    "every flag names a goal of the plan and says why",
    (flags ?? []).every(
      (f) =>
        (f.goal_id === null || ids.has(f.goal_id)) && f.why.trim().length > 0,
    ),
  );
}

if (jobs.includes("period")) {
  console.log("\nPeriod chapter (last month)");
  const month = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  await lookBack("period", `/period-review/month/${month}/chat`, "month");
}

// --- Report --------------------------------------------------------------

const failed = checks.filter((c) => !c.ok);
const folder = args.out ?? join(tmpdir(), "schizo-agent-eval");
await mkdir(folder, { recursive: true });
const file = join(
  folder,
  `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
await writeFile(
  file,
  JSON.stringify(
    { origin: ORIGIN, today, week, planWeek, checks, timings, answers },
    null,
    2,
  ),
);
console.log(
  `\n${checks.length - failed.length} of ${checks.length} checks passed. The answers (the diary's words: keep them out of the repository) are in ${file}`,
);
process.exitCode = failed.length ? 1 : 0;
