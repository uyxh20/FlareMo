// Weekly review A/B test (fork-owned, docs/fork-review-ab-test.md).
//
// Writes the same weekly review three ways, on the same model, for the same
// past weeks, then hides which is which so the owner can score them blind:
//   A   plain API call with the context the app sends today (diary capped)
//   A+  plain API call with the whole week's diary, uncapped
//   B   a Managed Agent: the whole week plus earlier weeks as files it can
//       read, and a memory store that carries its notes from week to week
//
// Reads the DEV database only (read-only adapter). Never touches prod.
//
//   pnpm exec tsx scripts/fork/review-ab/run.ts --weeks 2026-09-07,2026-09-14 \
//     --out <dir> [--dry-run] [--model claude-sonnet-5-5] [--arms A,A+,B]
//
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (dev D1 read) and, unless
// --dry-run, ANTHROPIC_API_KEY.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createDb } from "../../../packages/db/src";
import { plannerAddDays } from "../../../packages/contracts/src/planner-goals";
import {
  plannerReadReviewContext,
  plannerReadWeekDiary,
  plannerReviewContextBlock,
  type PlannerReviewContext,
} from "../../../packages/domain/src/planner";
import { devDatabaseId, readOnlyD1 } from "./d1-http";

const ARMS = ["A", "A+", "B"] as const;
type Arm = (typeof ARMS)[number];

/** List prices per million tokens, checked 2026-10-11 (platform.claude.com pricing). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** How many earlier weeks of diary the agent can open. */
const HISTORY_WEEKS = 8;
/** Effectively uncapped: the app's own reader still stops at 200 entries a week. */
const UNCAPPED = 10_000_000;

const { values: args } = parseArgs({
  options: {
    weeks: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    arms: { type: "string", default: ARMS.join(",") },
    "dry-run": { type: "boolean", default: false },
    "budget-usd": { type: "string", default: "3" },
    "keep-memory": { type: "boolean", default: false },
    database: { type: "string", default: "flaremo-dev" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const weeks = (args.weeks ?? "").split(",").filter(Boolean).sort();
if (!weeks.length || weeks.some((week) => !/^\d{4}-\d{2}-\d{2}$/.test(week))) {
  fail("--weeks takes Monday dates, comma separated (2026-09-07,2026-09-14).");
}
if (!args.out) fail("--out is required.");
const arms = args.arms.split(",") as Arm[];
if (arms.some((arm) => !ARMS.includes(arm))) fail(`--arms takes ${ARMS.join(",")}.`);
const model = args.model;
const price = PRICES[model] ?? fail(`No price on file for ${model}.`);
const dryRun = args["dry-run"];
const budgetCents = String(Math.round(Number(args["budget-usd"]) * 100));

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? fail("CLOUDFLARE_ACCOUNT_ID is not set.");
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? fail("CLOUDFLARE_API_TOKEN is not set.");
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is not set (or run with --dry-run).");
}

// ---------------------------------------------------------------------------
// The task: identical words for every arm
// ---------------------------------------------------------------------------

const task = (name: string) => `You write ${name}'s weekly review: an honest, analytical read of the week that just ended, measured against their goals.

Write it in Markdown, at most 900 words, with these sections:
1. **The week in one paragraph**: what actually happened, factually.
2. **Read per pillar**: for each pillar with goals, did the week move it, stall it, or work against it? Cite the evidence (a diary day, a task, a score).
3. **Patterns**: what repeats across this week and earlier weeks. Only claim a pattern you can point to.
4. **Goal conflicts**: where two goals, or a goal and how time was actually spent, pull against each other. Say which one is losing.
5. **What ${name} may not have noticed**: one or two observations they are unlikely to have made themselves.
6. **Suggested scores**: Authenticity and Achievement, 1 to 5 in half steps, one line of reasoning each.
7. **Next week**: three concrete goals, each tied to a higher goal, and the one question to answer at the next review.

Rules: ground every claim in the material. If the material is thin, say so instead of filling the gap. No praise, no motivational tone. Address ${name} as "you".`;

const AGENT_HARNESS = `The material is in files:
- /data/this-week.md: the goals, scores, tasks and every diary entry of the week under review.
- /data/history/: the diary of earlier weeks, one file per week.
Your memory store holds notes you wrote at earlier reviews of this person. Read it first. Use the history to check patterns rather than guess them.

When the review is done:
1. Write it to /mnt/session/outputs/review.md.
2. Update your memory store with short notes for next week's review: open threads, what you asked them to watch, patterns to re-check. Notes, not a copy of the review.
Then reply with the single word: done.`;

// ---------------------------------------------------------------------------
// Data: the app's own reader over the dev database
// ---------------------------------------------------------------------------

const databaseId = await devDatabaseId({ accountId, apiToken }, args.database);
const d1 = readOnlyD1({ accountId, apiToken }, databaseId);
const db = createDb(d1);

const owners = (await d1.prepare("SELECT id, name FROM users WHERE status = 'active' LIMIT 2").all())
  .results as Array<{ id: string; name: string }>;
if (owners.length !== 1) fail("Expected exactly one user on the dev database.");
const owner = owners[0]!;
const ownerName = owner.name.split(/\s+/)[0] || owner.name;

async function contextFor(weekStart: string): Promise<{
  capped: PlannerReviewContext;
  full: PlannerReviewContext;
}> {
  const capped = await plannerReadReviewContext(db, {
    userId: owner.id,
    ownerName,
    weekStart,
    today: plannerAddDays(weekStart, 6),
  });
  const diary = await plannerReadWeekDiary(db, {
    userId: owner.id,
    weekStart,
    maxChars: UNCAPPED,
  });
  return { capped, full: { ...capped, diary } };
}

async function historyFor(weekStart: string): Promise<Array<{ week: string; text: string }>> {
  const out: Array<{ week: string; text: string }> = [];
  for (let back = HISTORY_WEEKS; back >= 1; back--) {
    const week = plannerAddDays(weekStart, -7 * back);
    const diary = await plannerReadWeekDiary(db, {
      userId: owner.id,
      weekStart: week,
      maxChars: UNCAPPED,
    });
    if (!diary.length) continue;
    out.push({
      week,
      text: [`# Diary, week of ${week}`, ...diary.map((e) => `[${e.at.slice(0, 10)}] ${e.text}`)].join("\n\n"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type Result = { text: string; usd: number; seconds: number; tokens: Record<string, number>; note?: string };

const client = dryRun ? null : new Anthropic();

async function plainArm(context: PlannerReviewContext): Promise<Result> {
  const started = Date.now();
  const message = await client!.messages
    .stream({
      model,
      max_tokens: 16_000,
      output_config: { effort: "high" },
      system: task(ownerName),
      messages: [{ role: "user", content: plannerReviewContextBlock(context) }],
    })
    .finalMessage();
  const u = message.usage;
  const usd =
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      (u.cache_read_input_tokens ?? 0) * price.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1e6;
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return {
    text,
    usd,
    seconds: (Date.now() - started) / 1000,
    tokens: { input: u.input_tokens, output: u.output_tokens },
    note: message.stop_reason === "end_turn" ? undefined : `stop_reason: ${message.stop_reason}`,
  };
}

type AgentSetup = { environmentId: string; agentId: string; agentVersion: number; storeId: string };

async function setUpAgent(): Promise<AgentSetup> {
  const environment = await client!.beta.environments.create({
    name: `review-ab-${randomUUID().slice(0, 8)}`,
    config: { type: "cloud", networking: { type: "limited" } },
  });
  const agent = await client!.beta.agents.create({
    name: "Weekly review (A/B test)",
    model,
    system: task(ownerName),
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "auto" } },
        configs: [
          { name: "web_fetch", enabled: false },
          { name: "web_search", enabled: false },
        ],
      },
    ],
  });
  const store = await client!.beta.memoryStores.create({
    name: "review-notes",
    description: `Your own notes from earlier weekly reviews of ${ownerName}: open threads, what you asked them to watch, patterns to re-check.`,
  });
  return { environmentId: environment.id, agentId: agent.id, agentVersion: agent.version, storeId: store.id };
}

async function agentArm(setup: AgentSetup, context: PlannerReviewContext, weekStart: string): Promise<Result> {
  const started = Date.now();
  const uploads: Array<{ id: string; mount: string }> = [];
  const upload = async (mount: string, text: string) => {
    const file = await client!.files.upload({
      file: await toFile(Buffer.from(text), mount.split("/").pop()!, { type: "text/markdown" }),
    });
    uploads.push({ id: file.id, mount });
  };
  await upload("/data/this-week.md", plannerReviewContextBlock(context));
  for (const week of await historyFor(weekStart)) {
    await upload(`/data/history/${week.week}.md`, week.text);
  }

  const session = await client!.beta.sessions.create({
    agent: { type: "agent", id: setup.agentId, version: setup.agentVersion },
    environment_id: setup.environmentId,
    title: `Weekly review A/B, week of ${weekStart}`,
    budget: { type: "limit", max_list_cost: { amount: budgetCents, currency: "USD" } },
    resources: [
      ...uploads.map((file) => ({ type: "file" as const, file_id: file.id, mount_path: file.mount })),
      { type: "memory_store" as const, memory_store_id: setup.storeId, access: "read_write" as const },
    ],
  });

  let note: string | undefined;
  let lastText = "";
  const stream = await client!.beta.sessions.events.stream(session.id);
  const kickoff = client!.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: AGENT_HARNESS }] }],
  });
  loop: for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        lastText = event.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") || lastText;
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        // Nobody watches the run: a call the policy could not decide is denied.
        if (event.evaluated_permission === "ask") {
          await client!.beta.sessions.events.send(session.id, {
            events: [{ type: "user.tool_confirmation", tool_use_id: event.id, result: "deny" }],
          });
        }
        break;
      case "session.status_idle":
        if (event.stop_reason.type === "requires_action") break;
        if (event.stop_reason.type !== "end_turn") note = `stopped: ${event.stop_reason.type}`;
        break loop;
      case "session.status_terminated":
        note = "session terminated";
        break loop;
    }
  }
  await kickoff;

  let text = "";
  for (let attempt = 0; attempt < 4 && !text; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
    for await (const file of client!.beta.files.list({ scope_id: session.id })) {
      if (file.filename === "review.md") {
        text = await (await client!.beta.files.download(file.id)).text();
      }
    }
  }
  if (!text) {
    text = lastText;
    note = [note, "no review.md written; used the agent's last message"].filter(Boolean).join("; ");
  }

  const final = await client!.beta.sessions.retrieve(session.id);
  const usage = final.usage;
  // Diary text should not stay at Anthropic longer than the test needs it.
  await client!.beta.sessions.delete(session.id);
  for (const file of uploads) await client!.files.delete(file.id);

  return {
    text,
    usd: Number(usage?.list_cost?.amount ?? 0) / 100,
    seconds: (Date.now() - started) / 1000,
    tokens: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cache_read: usage?.cache_read_input_tokens ?? 0,
      active_seconds: usage?.active_seconds ?? 0,
    },
    note,
  };
}

async function tearDownAgent(setup: AgentSetup) {
  if (!args["keep-memory"]) await client!.beta.memoryStores.delete(setup.storeId);
  await client!.beta.agents.archive(setup.agentId);
  await client!.beta.environments.delete(setup.environmentId);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const runDir = join(args.out, new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
mkdirSync(runDir, { recursive: true });

if (dryRun) {
  const rows: string[] = ["| Week | A (capped) chars | A+ / B this week chars | B history files | B history chars |", "|---|---|---|---|---|"];
  for (const week of weeks) {
    const { capped, full } = await contextFor(week);
    const history = await historyFor(week);
    rows.push(
      `| ${week} | ${plannerReviewContextBlock(capped).length} | ${plannerReviewContextBlock(full).length} | ${history.length} | ${history.reduce((n, h) => n + h.text.length, 0)} |`,
    );
  }
  const report = `# Dry run (no model calls)\n\nModel: ${model}. Roughly 4 characters per token.\n\n${rows.join("\n")}\n`;
  writeFileSync(join(runDir, "dry-run.md"), report);
  console.log(report);
  process.exit(0);
}

const key: Record<string, Record<string, Arm>> = {};
const costs: Array<{ week: string; arm: Arm } & Omit<Result, "text">> = [];
const setup = arms.includes("B") ? await setUpAgent() : null;
try {
  for (const week of weeks) {
    const { capped, full } = await contextFor(week);
    const results: Partial<Record<Arm, Result>> = {};
    for (const arm of arms) {
      console.log(`${week} ${arm}…`);
      try {
        results[arm] =
          arm === "A" ? await plainArm(capped) : arm === "A+" ? await plainArm(full) : await agentArm(setup!, full, week);
      } catch (error) {
        results[arm] = { text: "", usd: 0, seconds: 0, tokens: {}, note: `failed: ${(error as Error).message.slice(0, 200)}` };
      }
      const { text: _text, ...rest } = results[arm]!;
      costs.push({ week, arm, ...rest });
      console.log(`  $${rest.usd.toFixed(3)}, ${rest.seconds.toFixed(0)}s${rest.note ? `, ${rest.note}` : ""}`);
    }
    // Shuffle the arms behind letters so scoring is blind.
    const letters = ["X", "Y", "Z"].slice(0, arms.length);
    const shuffled = [...arms].sort(() => Math.random() - 0.5);
    const weekKey: Record<string, Arm> = {};
    key[week] = weekKey;
    mkdirSync(join(runDir, week), { recursive: true });
    shuffled.forEach((arm, index) => {
      const letter = letters[index]!;
      weekKey[letter] = arm;
      writeFileSync(join(runDir, week, `${letter}.md`), results[arm]?.text || "_(no review: this version failed)_\n");
    });
  }
} finally {
  if (setup) await tearDownAgent(setup);
}

writeFileSync(join(runDir, ".key.json"), JSON.stringify(key, null, 2));
writeFileSync(join(runDir, ".costs.json"), JSON.stringify(costs, null, 2));
const criteria = [
  "Told me something I had not noticed",
  "Got the facts right (nothing invented)",
  "Spotted real conflicts between goals",
  "Next week's plan is concrete and doable",
  "Followed up on earlier weeks",
];
const letters = ["X", "Y", "Z"].slice(0, arms.length);
writeFileSync(
  join(runDir, "scorecard.md"),
  `# Weekly review A/B scorecard\n\nRead each week's ${letters.join(", ")} reviews, then score 1 to 5. Don't open .key.json until you're done.\n\n${weeks
    .map(
      (week) =>
        `## Week of ${week}\n\n| | ${letters.join(" | ")} |\n|---|${letters.map(() => "---|").join("")}\n${criteria
          .map((c) => `| ${c} | ${letters.map(() => " ").join(" | ")} |`)
          .join("\n")}\n\nFavourite: \n`,
    )
    .join("\n")}`,
);
console.log(`Done. Reviews and scorecard in ${runDir}`);
