import { plannerSummaryMemoClientId } from "@flaremo/contracts";
import type { UserRow } from "@flaremo/db";
import { exportData } from "../import-export";
import { createMemory } from "../memory";
import {
  PLANNER_DIARY_CHARS,
  plannerCheckMessages,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerMemoAgentFiles,
  plannerMemoMessages,
  plannerOpeningMessages,
  plannerReadMemoHistory,
  plannerReadReviewContext,
} from "../planner";
import {
  type PlannerTestRuntime,
  plannerTestRun,
} from "../planner/test-support";

// Vitest-only probes for the data-source tests (fork-owned;
// docs/fork-data-sources.md). Not imported by the app: it pulls in the planner
// test runtime, which imports miniflare.

/** The reviewed week: Monday 28 September to Sunday 4 October 2026. */
export const WEEK = "2026-09-28";
const PREVIOUS_WEEK = "2026-09-21";
export const TODAY = "2026-10-04";
const IN_WEEK = "2026-09-30T09:15:00.000Z";
const T0 = "2026-09-20T08:00:00.000Z";

export type ProbeContext = {
  rt: PlannerTestRuntime;
  user: UserRow;
  marker: string;
};

export type Probe = (probe: ProbeContext) => Promise<void>;

let sequence = 0;
const nextId = (prefix: string) => `${prefix}/probe-${++sequence}`;

async function insertMemo(
  { rt, user }: ProbeContext,
  memo: {
    content: string;
    createdAt?: string;
    source?: string;
    clientId?: string | null;
  },
): Promise<string> {
  const id = nextId("memos");
  const at = memo.createdAt ?? IN_WEEK;
  await plannerTestRun(
    rt.database,
    `INSERT INTO memos (id, user_id, content, source, client_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    memo.content,
    memo.source ?? "web",
    memo.clientId ?? null,
    at,
    at,
  );
  return id;
}

async function insertTask(
  { rt, user }: ProbeContext,
  task: {
    title: string;
    status: "todo" | "in_progress" | "done";
    notes?: string;
    completedAt?: string | null;
  },
): Promise<string> {
  const id = nextId("tasks");
  await plannerTestRun(
    rt.database,
    `INSERT INTO tasks (id, user_id, title, notes, status, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    task.title,
    task.notes ?? null,
    task.status,
    task.completedAt ?? null,
    T0,
    T0,
  );
  return id;
}

async function insertGoal(
  { rt, user }: ProbeContext,
  goal: { level: string; periodStart: string | null; title: string },
) {
  await plannerTestRun(
    rt.database,
    `INSERT INTO planner_goal (id, user_id, level, period_start, pillar, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'work', ?, ?, ?)`,
    nextId("goal"),
    user.id,
    goal.level,
    goal.periodStart,
    goal.title,
    T0,
    T0,
  );
}

/**
 * One probe per content source in data-sources.ts, keyed by its id. A probe
 * puts `marker` where a person using the app would put text of that kind, and
 * nowhere else.
 */
export const PROBES: Record<string, Probe> = {
  memos: async (p) => {
    await insertMemo(p, { content: `Long run by the river with ${p.marker}.` });
  },
  "memos:earlier-week": async (p) => {
    await insertMemo(p, {
      content: `Three weeks ago: ${p.marker}.`,
      createdAt: "2026-09-09T18:00:00.000Z",
    });
  },
  "memos:weekly-summary": async (p) => {
    await insertMemo(p, {
      content: `# Week 39: September 21 - 27, 2026\n\n## Executive Summary\n\n${p.marker} was the theme.`,
      createdAt: "2026-09-27T20:00:00.000Z",
      source: "weekly-review",
      clientId: plannerSummaryMemoClientId(PREVIOUS_WEEK),
    });
  },
  attachments: async (p) => {
    const memoId = await insertMemo(p, { content: "Photo from the hike." });
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO attachments (id, user_id, memo_id, r2_key, filename, content_type, size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', 10, ?, ?)`,
      nextId("attachments"),
      p.user.id,
      memoId,
      `r2/${p.marker}`,
      `${p.marker}.jpg`,
      IN_WEEK,
      IN_WEEK,
    );
  },
  memory_items: async (p) => {
    await createMemory(
      p.rt.db,
      p.user,
      { type: "user" },
      {
        content: `Prefers training in the morning, tag ${p.marker}`,
        type: "semantic",
        kind: "preference",
        scopeType: "global",
        scopeKey: null,
        tier: "normal",
        importance: 60,
        confidence: 80,
      },
    );
    // The review reads the memories made during the reviewed week.
    await plannerTestRun(
      p.rt.database,
      "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE user_id = ?",
      IN_WEEK,
      IN_WEEK,
      p.user.id,
    );
  },
  tasks: async (p) => {
    await insertTask(p, {
      title: `Ship ${p.marker}`,
      status: "done",
      completedAt: IN_WEEK,
    });
  },
  "tasks:backlog": async (p) => {
    await insertTask(p, { title: `Someday ${p.marker}`, status: "todo" });
  },
  "tasks.notes": async (p) => {
    await insertTask(p, {
      title: "Call the bank",
      status: "done",
      completedAt: IN_WEEK,
      notes: `They said ${p.marker}.`,
    });
  },
  planner_task_comment: async (p) => {
    const taskId = await insertTask(p, {
      title: "Draft the proposal",
      status: "done",
      completedAt: IN_WEEK,
    });
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_task_comment (id, user_id, task_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      nextId("comment"),
      p.user.id,
      taskId,
      `Blocked on ${p.marker}.`,
      IN_WEEK,
      IN_WEEK,
    );
  },
  planner_task_event: async (p) => {
    // The archive keeps a purged task's title: only the event remembers it.
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_task_event (user_id, task_id, task_title, type, data, source, occurred_at, created_at)
       VALUES (?, ?, ?, 'purged', '{}', 'planner', ?, ?)`,
      p.user.id,
      nextId("tasks"),
      `Old task ${p.marker}`,
      IN_WEEK,
      IN_WEEK,
    );
  },
  planner_goal: async (p) => {
    await insertGoal(p, {
      level: "year",
      periodStart: "2026-01-01",
      title: `Grow ${p.marker}`,
    });
  },
  planner_week: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_week (user_id, week_start, auth, ach, question, created_at, updated_at)
       VALUES (?, ?, 7, 6, ?, ?, ?)`,
      p.user.id,
      PREVIOUS_WEEK,
      `Will ${p.marker} hold?`,
      T0,
      T0,
    );
  },
  planner_review: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_review (user_id, week_start, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      p.user.id,
      WEEK,
      JSON.stringify({ answers: [[`Draft answer ${p.marker}`]] }),
      IN_WEEK,
      IN_WEEK,
    );
  },
  planner_goal_flag: async (p) => {
    for (const state of ["open", "kept"]) {
      await plannerTestRun(
        p.rt.database,
        `INSERT INTO planner_goal_flag (id, user_id, week_start, pillar, with_label, why, state, created_at)
         VALUES (?, ?, ?, 'work', 'Year · Work', ?, ?, ?)`,
        nextId("flag"),
        p.user.id,
        WEEK,
        `Pulls against ${p.marker}.`,
        state,
        IN_WEEK,
      );
    }
  },
  planner_period_review: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_period_review (user_id, level, period_start, state, verdict, forecast, created_at, updated_at)
       VALUES (?, 'month', '2026-09-01', ?, ?, ?, ?, ?)`,
      p.user.id,
      JSON.stringify({ answers: { fold: [`Fold ${p.marker}`] } }),
      `Continue: ${p.marker}`,
      `Next month ${p.marker} lands.`,
      IN_WEEK,
      IN_WEEK,
    );
  },
  planner_evidence: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO planner_evidence (id, user_id, level, period_start, pillar, claim, quote, source, verified, created_at)
       VALUES (?, ?, 'month', '2026-09-01', 'work', ?, ?, 'memo', 1, ?)`,
      nextId("evidence"),
      p.user.id,
      `Shipped ${p.marker}`,
      `we shipped ${p.marker} on Tuesday`,
      IN_WEEK,
    );
  },
  health_entry: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO health_entry (id, user_id, kind, day, variant, feel, source, created_at, updated_at)
       VALUES (?, ?, 'training', '2026-09-30', 'crossfit', ?, 'manual', ?, ?)`,
      nextId("health"),
      p.user.id,
      p.marker,
      IN_WEEK,
      IN_WEEK,
    );
  },
  articles: async (p) => {
    await plannerTestRun(
      p.rt.database,
      `INSERT INTO articles (id, user_id, slug, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      nextId("articles"),
      p.user.id,
      `slug-${sequence}`,
      `On ${p.marker}`,
      `Body about ${p.marker}.`,
      IN_WEEK,
      IN_WEEK,
    );
  },
};

/** The consumers this file measures; the others are checked in data-sources.test.ts. */
export const MEASURED = ["lookBack", "lookForward", "userExport"] as const;
export type Measured = (typeof MEASURED)[number];

/** Rows a probe can write outside the planner runtime's own reset. */
const EXTRA_RESET = [
  "memory_events",
  "memory_evidence",
  "memory_resource_links",
  "memory_relations",
  "memory_revisions",
  "memory_items",
  "embedding_tasks",
  "attachments",
  "articles",
  "memo_relations",
  "memo_tags",
  "memos",
];

/** Empties everything a probe can write; users stay. */
export async function resetProbes(rt: PlannerTestRuntime): Promise<void> {
  await rt.reset();
  await rt.database.batch(
    EXTRA_RESET.map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
  );
}

/** The weekly review's context for the owner's reviewed week, as production reads it. */
export async function reviewContextFor(rt: PlannerTestRuntime) {
  return plannerReadReviewContext(rt.db, {
    userId: rt.user.id,
    ownerName: rt.user.name,
    weekStart: WEEK,
    today: TODAY,
    diaryChars: PLANNER_DIARY_CHARS,
  });
}

/** What each measured consumer would hand on, for the owner, as one string. */
export async function consumerTexts(
  rt: PlannerTestRuntime,
): Promise<Record<Measured, string>> {
  const context = await reviewContextFor(rt);
  const answers = {
    lastAnswer: [],
    answers: [["Fine."]],
    goalResults: [],
    coachNotes: [],
  };
  const memoRequest = {
    ...answers,
    reviewedOn: TODAY,
    scores: { auth: 7, ach: 6 },
    question: null,
    verdict: null,
    recommended: "continue" as const,
    drafts: {
      auth_evidence: "",
      ach_evidence: "",
      pattern: "",
      risk: "",
      opportunity: "",
    },
  };
  const lookBack = [
    ...plannerOpeningMessages(context),
    ...plannerCoachMessages(context, "free", [
      { role: "user", content: "It was a good week." },
    ]),
    ...plannerCloseMessages(context, answers),
    ...plannerMemoMessages(context, memoRequest),
  ];
  const lookForward = plannerCheckMessages(context, [], []);
  const bundle = await exportData(rt.db, rt.user);
  // The memo agent, when set up, gets the same week and the weeks before it as files.
  const agentFiles = plannerMemoAgentFiles(
    context,
    memoRequest,
    await plannerReadMemoHistory(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
    }),
  );
  return {
    lookBack: [
      ...lookBack.map((message) => message.content),
      ...Object.values(agentFiles),
    ].join("\n"),
    lookForward: lookForward.map((message) => message.content).join("\n"),
    userExport: JSON.stringify(bundle),
  };
}

export const markerOf = (id: string) =>
  `Zq${id.replace(/[^a-z0-9]/gi, "")}Probe`;
