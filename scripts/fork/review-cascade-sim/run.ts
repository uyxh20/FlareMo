// Cascade review simulation (fork-owned, docs/fork-general-agent.md, "The
// cascade ladder"): replays past Sundays through the DEV Worker's review API
// with the general agent, so two arms can be compared blind:
//
//   V0  the live review (dev deployed with FLAREMO_REVIEW_CASCADE unset)
//   C   the cascade ladder (dev deployed with FLAREMO_REVIEW_CASCADE=ladder)
//
// The arm is whatever dev is deployed with; this script only labels it.
// For each week it runs opening → scores (with the owner's saved answers)
// → memo (with the scores, question and verdict the owner saved, and the
// arm's own drafts) → next week's proposals → the goal check of the plan the
// owner saved. No coach replay: a new coach question cannot change an old
// answer. Nothing is saved to a review; it leaves what an unsaved review
// leaves (open proposals, notes in dev's memory store, a session the nightly
// sweep ends).
//
//   pnpm exec tsx scripts/fork/review-cascade-sim/run.ts run --arm V0 \
//     [--weeks 2026-10-12,2026-10-19,2026-10-26] [--out <dir>] \
//     [--budget-usd 10] [--dry-run]
//   pnpm exec tsx scripts/fork/review-cascade-sim/run.ts blind --out <dir>
//
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (reads the dev database:
// the owner's saved answers and each session's cost, read-only, dev only) and
// FLAREMO_EVAL_TOKEN (a memos_pat_ token made on dev; or a network secret for
// dev's host, with NODE_USE_ENV_PROXY=1). Dev only: refuses any other
// deployment. Prints statuses and sizes, never the answers: they are the
// diary's words. The answers go to --out (default a folder under
// /mnt/project-files/weekly-review-cascade/runs), never into the repository.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEV } from "../dev-env-config.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    arm: { type: "string" },
    weeks: {
      type: "string",
      default: "2026-10-12,2026-10-19,2026-10-26",
    },
    out: { type: "string" },
    "budget-usd": { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command !== "run" && command !== "blind") {
  fail("Usage: run.ts run --arm <label> [...] | run.ts blind --out <dir>");
}

const ORIGIN = DEV.publicUrl;
if (!/flaremo-dev/.test(ORIGIN)) fail(`Not the dev deployment: ${ORIGIN}`);
const PLANNER = `${ORIGIN}/api/app/planner`;
const token = process.env.FLAREMO_EVAL_TOKEN?.trim() || "proxy-injected";
if (token !== "proxy-injected" && !token.startsWith("memos_pat_")) {
  fail("FLAREMO_EVAL_TOKEN is not an access token (memos_pat_…).");
}
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Copenhagen",
}).format(new Date());
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const out =
  args.out ?? `/mnt/project-files/weekly-review-cascade/runs/${stamp}`;
const budgetCents = Math.round(Number(args["budget-usd"]) * 100);
if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
  fail("--budget-usd must be a number above 0.");
}

// --- Dev database, read-only ---------------------------------------------

const DEV_DATABASE = "flaremo-dev";
const READ_ONLY = /^\s*(select|with|pragma)\b/i;

async function devQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!READ_ONLY.test(sql)) throw new Error("Read-only: SELECT only.");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const key = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !key) fail("CLOUDFLARE_API_TOKEN and _ACCOUNT_ID are needed.");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const list = (await (
    await fetch(`${base}?name=${DEV_DATABASE}`, { headers })
  ).json()) as { success: boolean; result: Array<{ name: string; uuid: string }> };
  const db = list.result?.find((row) => row.name === DEV_DATABASE);
  if (!db) fail(`No database named ${DEV_DATABASE} on this account.`);
  const result = (await (
    await fetch(`${base}/${db.uuid}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql, params }),
    })
  ).json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: Array<{ results: T[] }>;
  };
  if (!result.success) {
    throw new Error(
      `D1: ${result.errors?.map((error) => error.message).join("; ")}`,
    );
  }
  return result.result[0]?.results ?? [];
}

/** The owner's saved look back and plan for a week reviewed in the app. */
type SavedReview = {
  back: {
    lastAnswer: string[];
    answers: string[][];
    goalResults: Record<string, "met" | "partial" | "missed" | null>;
    scores: { auth: number; ach: number };
    drafts: { scores: { auth: number; ach: number } };
    question: string | null;
    verdict: { kind: "continue" | "pivot" | "pause"; text: string } | null;
  };
  forward: {
    goals: Array<{ id: string; pillar: string | null; title: string }>;
    tasks: Array<{ goal_id: string; title: string }>;
  };
};

async function savedReview(week: string): Promise<SavedReview> {
  const rows = await devQuery<{ state: string }>(
    "select state from planner_review where week_start like ? limit 1",
    [`${week}%`],
  );
  const state = rows[0]?.state;
  if (!state) fail(`${week}: no review was saved in the app for this week.`);
  const parsed = JSON.parse(state) as SavedReview;
  if (!parsed.back?.scores || !parsed.back.answers) {
    fail(`${week}: the saved review has no look back.`);
  }
  return parsed;
}

/** What the week's sessions cost, from the run rows the Worker keeps. */
async function sessionCost(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = await devQuery<{ cents: number | null }>(
    `select sum(cost_cents) as cents from planner_agent_run where session_id in (${sessionIds.map(() => "?").join(",")})`,
    sessionIds,
  );
  return rows[0]?.cents ?? 0;
}

// --- Dev Worker -----------------------------------------------------------

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null; text: string }> {
  const response = await fetch(`${PLANNER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    // A streamed answer: one JSON object per line.
  }
  return { status: response.status, json, text };
}

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

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  minutes: number,
): Promise<T> {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > end) return value;
    await sleep(5000);
  }
}

type AgentAnswer = {
  status: "running" | "done" | "failed";
  step?: string;
  [key: string]: unknown;
};

const log = (week: string, line: string) => console.log(`${week}  ${line}`);

async function step(
  week: string,
  name: "opening" | "close" | "memo" | "check",
  body: Record<string, unknown>,
  session: string | null,
): Promise<{ session: string | null; answer: AgentAnswer | null; seconds: number }> {
  const started = Date.now();
  const base = `/review/${week}`;
  const sent = await request<{ agent?: string }>("POST", `${base}/ai/${name}`, {
    today,
    ...body,
    ...(session ? { session } : {}),
  });
  const sid = sent.json?.agent ?? sessionOf(sent.text);
  if (sent.status !== 200 || !sid) {
    log(week, `${name}: the agent did not take the step (HTTP ${sent.status})`);
    return { session, answer: null, seconds: 0 };
  }
  const answer = await until(
    async () =>
      (
        await request<AgentAnswer>(
          "GET",
          `${base}/ai/agent/${sid}?today=${today}&step=${name}`,
        )
      ).json,
    (value) => value?.status !== "running",
    name === "memo" ? 20 : 12,
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  log(week, `${name}: ${answer?.status ?? "no answer"} after ${seconds}s`);
  return {
    session: sid,
    answer: answer?.status === "done" ? answer : null,
    seconds,
  };
}

function write(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

// --- One week -------------------------------------------------------------

async function replay(arm: string, week: string): Promise<string[]> {
  const saved = await savedReview(week);
  const dir = join(out, arm, week);
  const answers = {
    last_answer: saved.back.lastAnswer ?? [],
    answers: saved.back.answers.map((list) => list ?? []),
    goal_results: Object.entries(saved.back.goalResults ?? {}).map(
      ([goal_id, result]) => ({ goal_id, result }),
    ),
    coach_notes: [],
  };
  log(
    week,
    `saved review: ${answers.answers.filter((list) => list.length).length} of 7 prompts answered, ${answers.goal_results.length} goals judged, scores ${saved.back.scores.auth}/${saved.back.scores.ach}`,
  );
  if (args["dry-run"]) return [];
  const timings: Record<string, number> = {};
  const sessions = new Set<string>();

  const opening = await step(week, "opening", {}, null);
  if (!opening.session) return [];
  sessions.add(opening.session);
  timings.opening = opening.seconds;
  write(dir, "opening.json", opening.answer ?? { failed: true });

  const close = await step(week, "close", answers, opening.session);
  timings.close = close.seconds;
  write(dir, "close.json", close.answer ?? { failed: true });
  const drafted = (close.answer?.close ?? null) as {
    scores: {
      auth: number | null;
      ach: number | null;
      auth_evidence: string;
      ach_evidence: string;
    };
    trajectory: {
      pattern: string;
      risk: string;
      opportunity: string;
      recommended: "continue" | "pivot" | "pause" | null;
    };
  } | null;

  const memo = await step(
    week,
    "memo",
    {
      ...answers,
      scores: saved.back.scores,
      drafted:
        drafted?.scores.auth !== null && drafted?.scores.ach !== null
          ? { auth: drafted?.scores.auth, ach: drafted?.scores.ach }
          : null,
      question: saved.back.question ?? null,
      verdict: saved.back.verdict ?? null,
      recommended:
        saved.back.verdict?.kind ?? drafted?.trajectory.recommended ?? "continue",
      drafts: {
        auth_evidence: drafted?.scores.auth_evidence ?? "",
        ach_evidence: drafted?.scores.ach_evidence ?? "",
        pattern: drafted?.trajectory.pattern ?? "",
        risk: drafted?.trajectory.risk ?? "",
        opportunity: drafted?.trajectory.opportunity ?? "",
      },
    },
    opening.session,
  );
  timings.memo = memo.seconds;
  const memoText = String(memo.answer?.memo ?? "");
  write(dir, "memo.md", memoText || "(no memo)");
  log(week, `memo: ${memoText.split(/\s+/).filter(Boolean).length} words`);

  // Reading the memo sends the propose step; wait for its proposals.
  const proposals = await until(
    async () =>
      (
        await request<{ proposals: unknown[]; pending: boolean }>(
          "GET",
          `/review/${week}/proposals?today=${today}`,
        )
      ).json,
    (value) => value !== null && !value.pending,
    12,
  );
  write(dir, "proposals.json", proposals ?? { failed: true });
  log(week, `proposals: ${proposals?.proposals.length ?? 0}`);

  const plan = saved.forward.goals.map((goal) => ({
    id: goal.id,
    pillar: goal.pillar,
    title: goal.title,
    tasks: saved.forward.tasks
      .filter((task) => task.goal_id === goal.id)
      .map((task) => task.title),
  }));
  const check = await step(
    week,
    "check",
    { goals: plan, settled: [] },
    opening.session,
  );
  timings.check = check.seconds;
  write(dir, "check.json", check.answer ?? { failed: true });

  const cents = await sessionCost([...sessions]);
  write(dir, "run.json", {
    arm,
    week,
    today,
    sessions: [...sessions],
    timings,
    cost_cents: cents,
  });
  log(week, `cost so far: $${(cents / 100).toFixed(2)}`);
  return [...sessions];
}

// --- Blind copies ---------------------------------------------------------

function blind() {
  const arms = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "blind")
    .map((entry) => entry.name);
  const weeks = new Set<string>();
  for (const arm of arms) {
    for (const week of readdirSync(join(out, arm))) weeks.add(week);
  }
  for (const week of weeks) {
    const have = arms.filter((arm) => {
      try {
        readFileSync(join(out, arm, week, "memo.md"));
        return true;
      } catch {
        return false;
      }
    });
    if (have.length < 2) continue;
    const letters = "XYZWV".split("").slice(0, have.length);
    const shuffled = [...have].sort(() => Math.random() - 0.5);
    const key: Record<string, string> = {};
    shuffled.forEach((arm, index) => {
      const letter = letters[index] ?? String(index);
      key[letter] = arm;
      write(
        join(out, "blind", week),
        `${letter}.md`,
        readFileSync(join(out, arm, week, "memo.md"), "utf8"),
      );
    });
    write(join(out, "blind", week), ".key.json", key);
    console.log(`${week}: ${have.length} memos shuffled as ${letters.join(", ")}`);
  }
}

// --- Main -----------------------------------------------------------------

if (command === "blind") {
  if (!args.out) fail("blind needs --out <dir>.");
  blind();
} else {
  if (!args.arm) fail("--arm <label> is required (V0, C, …).");
  const weeks = args.weeks.split(",").map((week) => week.trim());
  for (const week of weeks) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) fail(`Not a day: ${week}`);
  }
  console.log(
    `${args["dry-run"] ? "Dry run" : "Run"}: arm ${args.arm}, ${weeks.length} weeks, budget $${(budgetCents / 100).toFixed(2)}, out ${out}`,
  );
  const all: string[] = [];
  for (const week of weeks) {
    const sessions = await replay(args.arm, week);
    all.push(...sessions);
    if (args["dry-run"]) continue;
    const cents = await sessionCost(all);
    if (cents >= budgetCents) {
      console.log(
        `Budget reached: $${(cents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)}. Stopping.`,
      );
      break;
    }
  }
  if (!args["dry-run"]) {
    const cents = await sessionCost(all);
    write(join(out, args.arm), "summary.json", {
      arm: args.arm,
      weeks,
      sessions: all,
      cost_cents: cents,
      today,
    });
    console.log(`Done: ${all.length} sessions, $${(cents / 100).toFixed(2)}.`);
  }
}
