// Weekly review model eval (fork-owned, docs/fork-review-model-eval.md).
//
// Sends the app's own five review calls (opening, coach, close, memo, check)
// for each eval week to each model through OpenRouter, with zero data
// retention required, then scores what can be scored by code, asks one judge
// model to count invented facts, and writes blind memos for the owner to score.
//
// Reads the DEV database only (the A/B test's read-only adapter).
//
//   pnpm exec tsx scripts/fork/review-eval/run.ts --out <dir> [--dry-run]
//     [--models a,b] [--weeks w1,w2] [--memo-models c,d] [--budget-usd 9]
//
// --memo-models also writes each week's memo with these models, from the same
// close drafts, to compare memo writers alone. The clash cases run on the
// latest eval week only (its goals are the current ones), each case three
// times, since OpenRouter ignores the temperature for some models.
//
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (dev D1 read) and, unless
// --dry-run, OPENROUTER_API_KEY (or OPENROUTERAPI).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../../../packages/db/src";
import {
  plannerAddDays,
  plannerReviewPrompts,
} from "../../../packages/contracts/src/planner-goals";
import {
  PLANNER_DIARY_CHARS,
  plannerCheckMessages,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerExtractJson,
  plannerMemoMessages,
  plannerOpeningMessages,
  plannerParseCheck,
  plannerParseClose,
  plannerParseOpening,
  plannerReadReviewContext,
  type PlannerChatMessage,
  type PlannerCheckGoal,
  type PlannerCheckSettled,
  type PlannerCoachMode,
  type PlannerReviewAnswers,
  type PlannerReviewContext,
} from "../../../packages/domain/src/planner";
import { devDatabaseId, readOnlyD1 } from "../review-ab/d1-http";

const MODELS = [
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "x-ai/grok-4.7", name: "Grok 4.7" },
];
const JUDGE = "anthropic/claude-opus-5.5";

/** The eval set (eval-set.json): weeks and the owner's own recorded scores. */
const WEEKS = [
  { week: "2026-09-28", auth: 4, ach: 4 },
  { week: "2026-09-21", auth: 4, ach: 3.5 },
  { week: "2026-09-14", auth: 4.5, ach: 5 },
  { week: "2026-08-17", auth: 4, ach: 2.5 },
  { week: "2026-07-20", auth: 3.5, ach: 2 },
  { week: "2026-07-06", auth: 3, ach: 2 },
  { week: "2026-06-08", auth: 4, ach: 4 },
  { week: "2026-03-23", auth: 5, ach: 5 },
];
const THIN_WEEK = "2026-07-20";
const BLIND_WEEKS = ["2026-09-28", "2026-08-17", "2026-07-20"];
const INJECTED_QUESTION = "Did I protect three evenings for deep work?";

/** The coach turn each week gets (one call per week), rotating over the five. */
const COACH_TURNS = ["C1", "C2", "C3", "C4", "C5", "C2", "C1", "C5"] as const;
/**
 * The clash cases, all run on CHECK_WEEK: its goals are the ones in use now,
 * where an older week would be read with goals edited after it.
 */
const CHECK_CASES = ["K1", "K2", "K3", "K4"] as const;
const CHECK_WEEK = "2026-09-28";
const CHECK_RUNS = 3;

/** Extra room for hidden reasoning on top of the app's own token limits. */
const REASONING_ROOM = 4_000;

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "budget-usd": { type: "string", default: "9" },
    models: { type: "string" },
    weeks: { type: "string" },
    judge: { type: "boolean", default: false },
    resume: { type: "string" },
    "memo-models": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!args.out && !args.resume) fail("--out or --resume is required.");
const dryRun = args["dry-run"];
const budget = Number(args["budget-usd"]);
const models = args.models
  ? MODELS.filter((m) => args.models!.split(",").includes(m.id))
  : MODELS;
const weeks = args.weeks
  ? WEEKS.filter((w) => args.weeks!.split(",").includes(w.week))
  : WEEKS;
const memoModels = args["memo-models"]?.split(",").filter(Boolean) ?? [];

/** The key as saved; tolerates a NAME= prefix pasted in with it. */
function openRouterKey(): string {
  const raw = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTERAPI;
  if (!raw) fail("OPENROUTER_API_KEY is not set (or run with --dry-run).");
  const value = raw.trim().split("=").pop()!.trim();
  return value.startsWith("sk-or-") ? value : `sk-or-v1-${value.slice(-64)}`;
}

const accountId =
  process.env.CLOUDFLARE_ACCOUNT_ID ??
  fail("CLOUDFLARE_ACCOUNT_ID is not set.");
const apiToken =
  process.env.CLOUDFLARE_API_TOKEN ?? fail("CLOUDFLARE_API_TOKEN is not set.");
const apiKey = dryRun ? "" : openRouterKey();

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

let spent = 0;

type Answer = {
  text: string;
  usd: number;
  seconds: number;
  provider: string | null;
  /** `cached`: prompt tokens the provider billed as a cache hit. */
  tokens: { input: number; cached: number; output: number; reasoning: number };
  error?: string;
};

const NO_TOKENS = { input: 0, cached: 0, output: 0, reasoning: 0 };

async function complete(
  model: string,
  messages: PlannerChatMessage[],
  options: { maxTokens: number; temperature: number },
): Promise<Answer> {
  if (spent >= budget) fail(`Budget of $${budget} reached; stopping.`);
  const started = Date.now();
  const body = {
    model,
    messages,
    max_tokens: options.maxTokens + REASONING_ROOM,
    temperature: options.temperature,
    reasoning: { effort: "low", exclude: true },
    // Only providers that keep nothing and don't train on it.
    provider: { zdr: true, data_collection: "deny" },
    usage: { include: true },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "Schizo Diary review eval",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        },
      );
      const json = (await response.json()) as {
        error?: { message: string };
        provider?: string;
        choices?: Array<{ message: { content: string | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          cost?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      if (!response.ok || json.error) {
        throw new Error(json.error?.message ?? `HTTP ${response.status}`);
      }
      const usd = json.usage?.cost ?? 0;
      spent += usd;
      return {
        text: json.choices?.[0]?.message.content ?? "",
        usd,
        seconds: (Date.now() - started) / 1000,
        provider: json.provider ?? null,
        tokens: {
          input: json.usage?.prompt_tokens ?? 0,
          cached: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          output: json.usage?.completion_tokens ?? 0,
          reasoning:
            json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        },
      };
    } catch (error) {
      if (attempt >= 3) {
        return {
          text: "",
          usd: 0,
          seconds: (Date.now() - started) / 1000,
          provider: null,
          tokens: NO_TOKENS,
          error: (error as Error).message.slice(0, 300),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Data: the app's own reader over the dev database
// ---------------------------------------------------------------------------

const databaseId = await devDatabaseId({ accountId, apiToken }, "flaremo-dev");
const d1 = readOnlyD1({ accountId, apiToken }, databaseId);
const db = createDb(d1);
const owners = (
  await d1
    .prepare("SELECT id, name FROM users WHERE status = 'active' LIMIT 2")
    .all()
).results as Array<{ id: string; name: string }>;
if (owners.length !== 1) fail("Expected exactly one user on the dev database.");
const owner = owners[0]!;
const ownerName = owner.name.split(/\s+/)[0] || owner.name;

async function contextFor(weekStart: string): Promise<PlannerReviewContext> {
  return plannerReadReviewContext(db, {
    userId: owner.id,
    ownerName,
    weekStart,
    today: plannerAddDays(weekStart, 6),
    // As the Worker reads it for an OpenRouter or Anthropic model.
    diaryChars: PLANNER_DIARY_CHARS,
  });
}

// ---------------------------------------------------------------------------
// The five calls
// ---------------------------------------------------------------------------

const NO_ANSWERS: PlannerReviewAnswers = {
  lastAnswer: [],
  answers: plannerReviewPrompts.map(() => []),
  goalResults: [],
  coachNotes: [],
};

const head = (index: number) =>
  `[Prompt ${index + 1} of ${plannerReviewPrompts.length}: ${plannerReviewPrompts[index]!.question}]\n`;

type CoachTurn = {
  mode: PlannerCoachMode;
  chat: Array<{ role: "user" | "assistant"; content: string }>;
  advance: boolean | null;
  question: boolean | null;
};

function coachTurn(id: (typeof COACH_TURNS)[number]): CoachTurn {
  switch (id) {
    case "C1":
      return {
        mode: "free",
        chat: [
          {
            role: "user",
            content: `[Last week's key question: "${INJECTED_QUESTION}"]\nPartly.`,
          },
        ],
        advance: false,
        question: true,
      };
    case "C2":
      return {
        mode: "free",
        chat: [
          {
            role: "user",
            content: `${head(5)}I don't think I had a blindspot this week.`,
          },
        ],
        advance: false,
        question: true,
      };
    case "C3":
      return {
        mode: "force",
        chat: [
          {
            role: "user",
            content: `${head(5)}I don't think I had a blindspot this week.`,
          },
          {
            role: "assistant",
            content:
              'One candidate: you kept planning around the original goals even as the week changed, which looks like anchoring. Could that be it?\n@@ {"advance": false}',
          },
          {
            role: "user",
            content: "Fair, maybe I did avoid that.",
          },
        ],
        advance: true,
        question: false,
      };
    case "C4":
      return {
        mode: "free",
        chat: [
          {
            role: "user",
            content: `${head(1)}I did less than I planned; most evenings went somewhere else.`,
          },
        ],
        advance: null,
        question: null,
      };
    case "C5":
      return {
        mode: "free",
        chat: [{ role: "user", content: `${head(6)}Nothing really.` }],
        advance: false,
        question: true,
      };
  }
}

function checkCase(
  id: (typeof CHECK_CASES)[number],
  context: PlannerReviewContext,
): {
  plan: PlannerCheckGoal[];
  settled: PlannerCheckSettled[];
  expect: (flags: RawFlag[]) => boolean;
} {
  const month = context.monthGoals;
  const title = (pillar: string) =>
    month.find((goal) => goal.pillar === pillar)?.title ||
    month
      .find((goal) => goal.pillar === pillar)
      ?.lines.map((line) => line.text)
      .join("; ") ||
    pillar;
  const plan: PlannerCheckGoal[] = month.map((goal, index) => ({
    id: `eval-${index}`,
    pillar: goal.pillar,
    title: `This week: ${title(goal.pillar ?? "")}`,
    tasks: [],
  }));
  const set = (pillar: string, text: string) => {
    const goal = plan.find((item) => item.pillar === pillar);
    if (goal) goal.title = text;
  };
  const higher = ["month", "quarter", "year", "north_star"];
  if (id === "K1") return { plan, settled: [], expect: (f) => f.length === 0 };
  if (id === "K3") {
    set("ai", "Spend every evening this week, all of them, on AI projects");
    set("health", "Spend every evening this week, all of them, on training");
    return {
      plan,
      settled: [],
      expect: (f) =>
        f.some(
          (flag) =>
            (flag.goal === "ai" || flag.goal === "health") &&
            flag.with_level === "week",
        ),
    };
  }
  set("work", `Pause all work on: ${title("work")}`);
  if (id === "K2") {
    return {
      plan,
      settled: [],
      expect: (f) =>
        f.some(
          (flag) =>
            flag.goal === "work" && higher.includes(flag.with_level ?? ""),
        ),
    };
  }
  return {
    plan,
    settled: [
      {
        label: "Month · Work",
        why: "Pausing work this week pulls against the month's work goal.",
        state: "kept",
      },
    ],
    expect: (f) => !f.some((flag) => flag.goal === "work"),
  };
}

type RawFlag = { goal?: string; with_level?: string; with_goal?: string };

// ---------------------------------------------------------------------------
// Checks done by code
// ---------------------------------------------------------------------------

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sentences = (text: string) =>
  text.split(/(?<=[.?!])\s+/).filter((s) => /\w/.test(s)).length;
const PRAISE =
  /\b(great|amazing|awesome|well done|proud|impressive|fantastic|excellent|good job|nice work)\b/i;
const BIAS = /\b(confirmation|sunk[- ]cost|anchoring|complexity|recency)\b/i;
const HONEST = /not sure|nothing|don't know|no idea|unsure|can't say|none/i;
const half = (n: unknown) =>
  typeof n === "number" && n >= 1 && n <= 5 && Number.isInteger(n * 2);

type Check = { name: string; pass: boolean };

function checkOpening(raw: string, week: string): Check[] {
  const json = plannerExtractJson(raw);
  const draft = plannerParseOpening(raw);
  const prompts = (json?.prompts ?? []) as unknown[];
  const options = prompts.flatMap((p) => (Array.isArray(p) ? p : []));
  const out: Check[] = [
    { name: "valid JSON", pass: json !== null },
    {
      name: "recap ≤ 35 words",
      pass: !!draft.recap && words(draft.recap) <= 35,
    },
    {
      name: "7 prompts × 3 options",
      pass:
        prompts.length === 7 &&
        prompts.every((p) => Array.isArray(p) && p.length === 3),
    },
    {
      name: "options ≤ 14 words",
      pass:
        options.length > 0 &&
        options.every((o) => typeof o === "string" && words(o) <= 14),
    },
  ];
  if (week === THIN_WEEK) {
    out.push({
      name: "thin week: honest option",
      pass:
        prompts.length > 0 &&
        prompts.every(
          (p) =>
            Array.isArray(p) &&
            p.some((o) => typeof o === "string" && HONEST.test(o)),
        ),
    });
  }
  return out;
}

function checkCoach(raw: string, turn: CoachTurn, id: string): Check[] {
  const match = raw.match(/@@\s*(\{[^}]*\})\s*$/);
  let advance: boolean | null = null;
  try {
    advance = match
      ? (JSON.parse(match[1]!) as { advance: boolean }).advance
      : null;
  } catch {
    advance = null;
  }
  const body = raw.replace(/@@[\s\S]*$/, "").trim();
  const out: Check[] = [
    { name: "ends with @@ advance line", pass: advance !== null },
    {
      name: "1 to 3 sentences",
      pass: sentences(body) >= 1 && sentences(body) <= 3,
    },
    { name: "no praise", pass: !PRAISE.test(body) },
  ];
  if (turn.advance !== null) {
    out.push({ name: "right advance signal", pass: advance === turn.advance });
  }
  if (turn.question !== null) {
    out.push({
      name: turn.question ? "asks a question" : "no question",
      pass: body.includes("?") === turn.question,
    });
  }
  if (id === "C2") out.push({ name: "names a bias", pass: BIAS.test(body) });
  return out;
}

const VERDICT = {
  continue: /^Continue\. .+/,
  pivot: /^Pivot toward .+, away from .+\. .+/,
  pause: /^Pause for .+[.?] Without answering this, next week risks .+/,
};

function checkClose(raw: string): {
  checks: Check[];
  auth: number | null;
  ach: number | null;
} {
  const json = plannerExtractJson(raw) as {
    scores?: { auth?: unknown; ach?: unknown };
    trajectory?: { questions?: unknown; verdicts?: Record<string, unknown> };
  } | null;
  const draft = plannerParseClose(raw);
  const auth = json?.scores?.auth;
  const ach = json?.scores?.ach;
  const questions = Array.isArray(json?.trajectory?.questions)
    ? (json!.trajectory!.questions as unknown[])
    : [];
  const verdicts = json?.trajectory?.verdicts ?? {};
  return {
    checks: [
      { name: "valid JSON", pass: json !== null },
      { name: "scores in half steps", pass: half(auth) && half(ach) },
      {
        name: "3 questions starting 'Did I'",
        pass:
          questions.length === 3 &&
          questions.every((q) => typeof q === "string" && /^Did I\b/.test(q)),
      },
      {
        name: "verdict formats",
        pass: (Object.keys(VERDICT) as Array<keyof typeof VERDICT>).every(
          (kind) =>
            typeof verdicts[kind] === "string" &&
            VERDICT[kind].test(verdicts[kind] as string),
        ),
      },
      {
        name: "recommends a verdict",
        pass: draft.trajectory.recommended !== null,
      },
    ],
    auth: half(auth) ? (auth as number) : null,
    ach: half(ach) ? (ach as number) : null,
  };
}

function checkMemo(raw: string, template: string): Check[] {
  const headings = template.match(/^#{1,3} .+$/gm) ?? [];
  let at = 0;
  const inOrder = headings.every((heading) => {
    const found = raw.indexOf(heading.trim(), at);
    if (found < 0) return false;
    at = found;
    return true;
  });
  return [
    { name: "not empty", pass: raw.trim().length > 200 },
    {
      name: "skeleton headings in order",
      pass: headings.length > 0 && inOrder,
    },
  ];
}

async function judge(
  messages: PlannerChatMessage[],
  output: string,
): Promise<{ claims: number; unsupported: string[]; usd: number } | null> {
  const material = messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join("\n\n");
  const answer = await complete(
    JUDGE,
    [
      {
        role: "system",
        content:
          "You check a model's output against the exact material it was given. You reply with JSON only.",
      },
      {
        role: "user",
        content: `Below is the MATERIAL a model was given, then its OUTPUT. List every concrete factual claim in the OUTPUT about what happened or what exists (an event, a task, a goal, a name, a number, a date, a score). Then list the ones the MATERIAL does not support. Interpretations, questions, suggestions and template text are not claims. Paraphrase is fine; only flag claims with no basis in the MATERIAL.

MATERIAL:
<<<
${material}
>>>

OUTPUT:
<<<
${output}
>>>

Reply with only JSON: {"claims": number, "unsupported": ["each unsupported claim, quoted or paraphrased in under 20 words"]}`,
      },
    ],
    { maxTokens: 1_500, temperature: 0 },
  );
  const json = plannerExtractJson(answer.text) as {
    claims?: unknown;
    unsupported?: unknown;
  } | null;
  if (!json || typeof json.claims !== "number") return null;
  return {
    claims: json.claims,
    unsupported: Array.isArray(json.unsupported)
      ? json.unsupported.map(String)
      : [],
    usd: answer.usd,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
// --resume <run dir> reuses the answers already saved there and only calls
// for the missing ones (their cost is not known again, so it shows as reused).
const runDir = args.resume ?? join(args.out!, stamp);
mkdirSync(runDir, { recursive: true });

const contexts = new Map<string, PlannerReviewContext>();
for (const { week } of weeks) contexts.set(week, await contextFor(week));

if (dryRun) {
  const rows = weeks.map(({ week }) => {
    const c = contexts.get(week)!;
    const chars = plannerOpeningMessages(c)
      .map((m) => m.content.length)
      .reduce((a, b) => a + b, 0);
    const diary = c.diary.reduce((a, e) => a + e.text.length, 0);
    const cut = c.diary.filter((e) => e.text.endsWith("…")).length;
    return `| ${week} | ${c.diary.length} | ${diary} | ${cut} | ${Object.keys(c.previousSteps).length} | ${chars} | ${c.monthGoals.length} | ${c.weekGoals.length} |`;
  });
  const report = `# Dry run\n\n| Week | Diary entries | Diary chars sent | Entries cut | Next Steps read | Opening prompt chars | Month goals | Week goals |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
  writeFileSync(join(runDir, "dry-run.md"), report);
  console.log(report);
  process.exit(0);
}

type CallResult = {
  model: string;
  week: string;
  call: string;
  case?: string;
  usd: number;
  seconds: number;
  provider: string | null;
  tokens: Answer["tokens"];
  error?: string;
  checks: Check[];
  scores?: { auth: number | null; ach: number | null };
  facts?: { claims: number; unsupported: string[] } | null;
};

const results: CallResult[] = [];
const memos = new Map<string, Map<string, string>>();

function save(model: string, week: string, call: string, text: string) {
  const dir = join(runDir, "raw", model.replace("/", "_"), week);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${call}.txt`), text);
}

async function runModel(model: string) {
  for (const [index, entry] of weeks.entries()) {
    const { week } = entry;
    const context = contexts.get(week)!;
    const call = async (
      name: string,
      messages: PlannerChatMessage[],
      options: { maxTokens: number; temperature: number },
      by = model,
    ): Promise<Answer> => {
      const file = join(
        runDir,
        "raw",
        model.replace("/", "_"),
        week,
        `${name}.txt`,
      );
      if (existsSync(file)) {
        const text = readFileSync(file, "utf8");
        if (!text.startsWith("(error)")) {
          return {
            text,
            usd: Number.NaN,
            seconds: Number.NaN,
            provider: "reused",
            tokens: NO_TOKENS,
          };
        }
      }
      return complete(by, messages, options);
    };
    const record = (
      call: string,
      answer: Answer,
      checks: Check[],
      extra: Partial<CallResult> = {},
      file = call,
    ) => {
      save(model, week, file, answer.text || `(error) ${answer.error ?? ""}`);
      const row: CallResult = {
        model,
        week,
        call,
        usd: answer.usd,
        seconds: answer.seconds,
        provider: answer.provider,
        tokens: answer.tokens,
        error: answer.error,
        checks: answer.error ? [{ name: "answered", pass: false }] : checks,
        ...extra,
      };
      results.push(row);
      appendFileSync(join(runDir, "results.jsonl"), `${JSON.stringify(row)}\n`);
    };

    // 1. Opening
    const openingMessages = plannerOpeningMessages(context);
    save(
      model,
      week,
      "opening.prompt",
      openingMessages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"),
    );
    const opening = await call("opening", openingMessages, {
      maxTokens: 1_600,
      temperature: 0.4,
    });
    const openingFacts =
      opening.text && args.judge
        ? await judge(openingMessages, opening.text)
        : null;
    if (openingFacts) spentJudge += openingFacts.usd;
    record("opening", opening, checkOpening(opening.text, week), {
      facts: openingFacts,
    });

    // 2. Coach: one turn
    const turnId = COACH_TURNS[index % COACH_TURNS.length]!;
    const turn = coachTurn(turnId);
    const coachContext =
      turnId === "C1" && !context.lastQuestion
        ? { ...context, lastQuestion: INJECTED_QUESTION }
        : context;
    const coachMessages = plannerCoachMessages(
      coachContext,
      turn.mode,
      turn.chat,
    );
    const coach = await call("coach", coachMessages, {
      maxTokens: 400,
      temperature: 0.5,
    });
    record("coach", coach, checkCoach(coach.text, turn, turnId), {
      case: turnId,
    });
    if (index === 0) {
      // The same call again: the prompt tokens billed as cached show whether
      // the provider's prompt cache works with zero data retention.
      const repeat = await call("coach-repeat", coachMessages, {
        maxTokens: 400,
        temperature: 0.5,
      });
      record(
        "coach-repeat",
        repeat,
        [{ name: "repeat billed as cached", pass: repeat.tokens.cached > 0 }],
        { case: turnId },
      );
    }

    // 3. Close
    const close = await call(
      "close",
      plannerCloseMessages(context, NO_ANSWERS),
      { maxTokens: 1_200, temperature: 0.2 },
    );
    const closed = checkClose(close.text);
    record("close", close, closed.checks, {
      scores: { auth: closed.auth, ach: closed.ach },
    });

    // 4. Memo, fed the owner's real scores and this model's close drafts
    const draft = plannerParseClose(close.text);
    const recommended = draft.trajectory.recommended ?? "continue";
    const memoRequest = {
      ...NO_ANSWERS,
      reviewedOn: plannerAddDays(week, 6),
      scores: { auth: entry.auth, ach: entry.ach },
      question: draft.trajectory.questions[0] ?? null,
      verdict: {
        kind: recommended,
        text: draft.trajectory.verdicts[recommended] || "Continue.",
      },
      recommended,
      // The scores the drafts were written for, as the page sends them.
      drafted:
        draft.scores.auth !== null && draft.scores.ach !== null
          ? { auth: draft.scores.auth, ach: draft.scores.ach }
          : null,
      drafts: {
        auth_evidence: draft.scores.auth_evidence,
        ach_evidence: draft.scores.ach_evidence,
        pattern: draft.trajectory.pattern,
        risk: draft.trajectory.risk,
        opportunity: draft.trajectory.opportunity,
      },
    } satisfies Parameters<typeof plannerMemoMessages>[1];
    const memoMessages = plannerMemoMessages(context, memoRequest);
    const memo = await call("memo", memoMessages, {
      maxTokens: 2_600,
      temperature: 0.3,
    });
    const memoFacts =
      memo.text && args.judge ? await judge(memoMessages, memo.text) : null;
    save(
      model,
      week,
      "memo.prompt",
      memoMessages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"),
    );
    if (memoFacts) spentJudge += memoFacts.usd;
    // The skeleton's headings alone: last week's summary is left out so its
    // headings don't count.
    const skeleton = plannerMemoMessages(
      { ...context, previousSummary: null, diary: [] },
      memoRequest,
    ).at(-1)!.content;
    record("memo", memo, checkMemo(memo.text, skeleton), {
      facts: memoFacts,
    });
    if (!memos.has(week)) memos.set(week, new Map());
    memos.get(week)!.set(model, memo.text);

    // 4b. The same memo by other writers, from this model's drafts
    for (const writer of memoModels) {
      const file = `memo@${writer.replace("/", "_")}`;
      const other = await call(
        file,
        memoMessages,
        { maxTokens: 2_600, temperature: 0.3 },
        writer,
      );
      record(
        `memo@${writer}`,
        other,
        checkMemo(other.text, skeleton),
        {},
        file,
      );
      memos.get(week)!.set(`${writer} (memo from ${model}'s drafts)`, other.text);
    }

    // 5. Check: every planted case, CHECK_RUNS times, on CHECK_WEEK only
    for (const caseId of week === CHECK_WEEK ? CHECK_CASES : []) {
      for (let run = 1; run <= CHECK_RUNS; run++) {
        const planted = checkCase(caseId, context);
        const file = `check-${caseId}-${run}`;
        const check = await call(
          file,
          plannerCheckMessages(
            { ...context, keptFlags: [] },
            planted.plan,
            planted.settled,
          ),
          { maxTokens: 700, temperature: 0.1 },
        );
        const json = plannerExtractJson(check.text) as {
          flags?: unknown;
        } | null;
        const flags = (
          Array.isArray(json?.flags) ? json!.flags : []
        ) as RawFlag[];
        const parsed = plannerParseCheck(check.text, context, planted.plan);
        record(
          "check",
          check,
          [
            {
              name: "valid JSON",
              pass: json !== null && Array.isArray(json.flags),
            },
            { name: "≤ 3 flags", pass: parsed.length <= 3 },
            { name: `${caseId} right answer`, pass: planted.expect(flags) },
          ],
          { case: caseId },
          file,
        );
      }
    }
    console.log(`${model} ${week} done ($${spent.toFixed(3)} so far)`);
  }
}

let spentJudge = 0;
// Models run side by side; each runs its weeks in order.
await Promise.all(models.map((m) => runModel(m.id)));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2));

const letters = ["A", "B", "C", "D", "E", "F"];
const key: Record<string, Record<string, string>> = {};
for (const week of BLIND_WEEKS) {
  const byModel = memos.get(week);
  if (!byModel) continue;
  const order = [...byModel.keys()].sort(() => Math.random() - 0.5);
  key[week] = {};
  mkdirSync(join(runDir, "blind", week), { recursive: true });
  order.forEach((model, i) => {
    key[week]![letters[i]!] = model;
    writeFileSync(
      join(runDir, "blind", week, `${letters[i]}.md`),
      byModel.get(model) || "_(no memo: this model failed)_\n",
    );
  });
}
writeFileSync(join(runDir, "blind", ".key.json"), JSON.stringify(key, null, 2));

const pct = (list: Check[]) =>
  list.length
    ? `${Math.round((100 * list.filter((c) => c.pass).length) / list.length)}%`
    : "-";
const lines = models.map(({ id, name }) => {
  const mine = results.filter((r) => r.model === id);
  const of = (call: string) => mine.filter((r) => r.call === call);
  const closes = of("close");
  const errors = closes.flatMap((r) => {
    const truth = WEEKS.find((w) => w.week === r.week)!;
    return r.scores?.auth != null && r.scores.ach != null
      ? [
          Math.abs(r.scores.auth - truth.auth),
          Math.abs(r.scores.ach - truth.ach),
        ]
      : [];
  });
  const mae = errors.length
    ? (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(2)
    : "-";
  const facts = (call: string) => {
    const judged = of(call).filter((r) => r.facts);
    if (!judged.length) return "-";
    const bad = judged.reduce((a, r) => a + r.facts!.unsupported.length, 0);
    return (bad / judged.length).toFixed(1);
  };
  // One review's five calls: the four per week, plus one clash check.
  const paid = (call: string) =>
    of(call).filter((r) => Number.isFinite(r.usd));
  const mean = (rows: CallResult[], key: "usd" | "seconds") =>
    rows.length ? rows.reduce((a, r) => a + r[key], 0) / rows.length : 0;
  const perReview = (key: "usd" | "seconds") =>
    ["opening", "coach", "close", "memo", "check"].reduce(
      (a, call) => a + mean(paid(call), key),
      0,
    );
  const anyPaid = mine.some((r) => Number.isFinite(r.usd));
  const failed = mine.filter((r) => r.error).length;
  return `| ${name} | ${pct(of("opening").flatMap((r) => r.checks))} | ${pct(of("coach").flatMap((r) => r.checks))} | ${pct(closes.flatMap((r) => r.checks))} | ${mae} | ${pct(of("memo").flatMap((r) => r.checks))} | ${facts("opening")} | ${facts("memo")} | ${pct(of("check").flatMap((r) => r.checks))} | ${failed} | ${anyPaid ? `$${perReview("usd").toFixed(3)}` : "reused"} | ${anyPaid ? `${perReview("seconds").toFixed(0)}s` : "reused"} |`;
});

const cacheLines = results
  .filter((r) => r.call === "coach-repeat")
  .map(
    (r) =>
      `- ${r.model}: the repeated coach call had ${r.tokens.cached} of ${r.tokens.input} prompt tokens billed as cached.`,
  );
const writerLines = memoModels.map((writer) => {
  const rows = results.filter((r) => r.call === `memo@${writer}`);
  const paid = rows.filter((r) => Number.isFinite(r.usd));
  const usd = paid.reduce((a, r) => a + r.usd, 0);
  return `- ${writer}: memo checks ${pct(rows.flatMap((r) => r.checks))}, $${(usd / (paid.length || 1)).toFixed(3)} a memo, ${rows.filter((r) => r.error).length} failed.`;
});

const summary = `# Weekly review model eval: results

${weeks.length} weeks × 4 calls (opening, coach, close, memo) and the ${CHECK_CASES.length} clash cases × ${CHECK_RUNS} runs on ${CHECK_WEEK}, × ${models.length} models, through OpenRouter with zero data retention required. Diary budget ${PLANNER_DIARY_CHARS.toLocaleString("en")} characters. Model spend $${(spent - spentJudge).toFixed(2)}, judge spend $${spentJudge.toFixed(2)}.

| Model | Opening checks | Coach checks | Close checks | Score error (vs your scores) | Memo checks | Invented facts per opening | Invented facts per memo | Clash cases right | Failed calls | Cost per review (5 calls) | Time per review |
|---|---|---|---|---|---|---|---|---|---|---|---|
${lines.join("\n")}

Score error is the average distance, in points, between the drafted score and the one you gave (both scores, all weeks). ${args.judge ? `Invented facts are counted by ${JUDGE}, which saw exactly what each model saw.` : "No judge model ran (--judge off): invented facts are checked separately, against the saved prompts."}
${cacheLines.length ? `\nPrompt cache:\n${cacheLines.join("\n")}\n` : ""}${writerLines.length ? `\nMemos by other writers, from the same drafts:\n${writerLines.join("\n")}\n` : ""}
Blind memos for you to score: blind/<week>/A.md to E.md. The key is blind/.key.json; open it after scoring.
`;
writeFileSync(join(runDir, "summary.md"), summary);
console.log(summary);
