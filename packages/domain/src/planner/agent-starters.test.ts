import { plannerAskStarters } from "@flaremo/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createMemo } from "../memos-write";
import type { TaskActor } from "../tasks";
import { plannerAgentAcceptAction } from "./agent-apply";
import {
  plannerAgentAddChat,
  plannerAgentCreateRun,
  plannerAgentListActions,
} from "./agent-store";
import { plannerAgentCallTool } from "./agent-tools";
import {
  plannerAskStarterCounts,
  plannerMentionsHealth,
  plannerSentenceAboutTask,
  plannerSoundsDone,
} from "./ask-starters";
import { plannerAddTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// Ask my diary's starter buttons (docs/fork-general-agent.md, "The starter
// buttons"): the counts the buttons show, the finders the agent reads for
// each, the entry a Done row points to, and the button a proposal came from.

let rt: PlannerTestRuntime;
const NOW = new Date("2026-11-11T10:00:00.000Z");
const TODAY = "2026-11-11";
const USER: TaskActor = { type: "user" };
const CONVERSATION = "55555555-5555-4555-8555-555555555555";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

async function task(
  title: string,
  options: {
    column?: "backlog" | "todo" | "doing";
    due?: string;
    idle?: number;
  } = {},
) {
  const made = await plannerAddTask(rt.db, {
    user: rt.user,
    actor: USER,
    title,
    today: TODAY,
    ...(options.due ? { dueAt: options.due } : {}),
    ...(options.column === "todo" || options.column === "doing"
      ? {
          column: options.column,
          plan: { horizon: "week", day: TODAY },
        }
      : {}),
  });
  if (options.idle !== undefined) {
    const at = new Date(
      NOW.getTime() - options.idle * 86_400_000,
    ).toISOString();
    await plannerTestRows(
      rt.database,
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      at,
      made.task.id,
    );
  }
  return made.task.id;
}

async function entry(content: string, at: string) {
  const memo = await createMemo(rt.db, rt.user, {
    content,
    visibility: "private",
    source: "web",
  });
  await plannerTestRows(
    rt.database,
    "UPDATE memos SET created_at = ?, updated_at = ? WHERE id = ?",
    at,
    at,
    memo.id,
  );
  return memo.id;
}

describe("Ask my diary's starter buttons", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-starters-test");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      [
        "memos",
        "memo_tags",
        "memo_revisions",
        "embedding_tasks",
        "health_entry",
      ].map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
    );
  });

  it("counts overdue, stuck and untouched cards without a model", async () => {
    await task("Pay the plumber", { due: "2026-11-05" });
    await task("Write the deck", { column: "doing", idle: 9 });
    await task("Fresh doing", { column: "doing", idle: 1 });
    await task("Old idea", { idle: 30 });
    await task("Older idea", { idle: 60 });
    await task("New idea", { idle: 2 });
    expect(
      await plannerAskStarterCounts(rt.db, {
        userId: rt.user.id,
        today: TODAY,
      }),
    ).toEqual({ overdue: 1, stuck: 1, stale_backlog: 2 });

    const replan = await call("find_replan_tasks", {});
    expect(replan).toMatch(/"Pay the plumber" \| overdue/);
    expect(replan).toMatch(/"Write the deck" \| stuck in Doing \| doing/);
    expect(replan).not.toContain("Fresh doing");

    const stale = await call("find_stale_backlog", {});
    expect(stale.indexOf("Older idea")).toBeLessThan(stale.indexOf("Old idea"));
    expect(stale).not.toContain("New idea");
    expect(await call("find_stale_backlog", { weeks: 6 })).not.toContain(
      '"Old idea"',
    );
  });

  it("finds open tasks an entry says are done, and files a Done row with the entry", async () => {
    const invoice = await task("Send the invoice to Acme");
    await task("Book the dentist");
    const memo = await entry(
      "Busy morning. Finally sent the invoice to Acme. Still need to book the dentist.",
      "2026-11-10T09:00:00.000Z",
    );
    const found = await call("find_done_tasks", {});
    expect(found).toMatch(
      /"Send the invoice to Acme"[^\n]*\n {4}- entry [^\n]*"Finally sent the invoice to Acme\." \| sounds done/,
    );
    expect(found).toMatch(/"Still need to book the dentist\."\n/);

    // Asked from the button: the proposal carries the button's id.
    const run = await plannerAgentCreateRun(rt.db, {
      userId: rt.user.id,
      job: "ask",
      ownerKey: `ask:${CONVERSATION}`,
      budgetCents: 500,
      step: "ask",
      now: NOW,
    });
    await plannerAgentAddChat(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      role: "owner",
      text: plannerAskStarters.done,
      runId: run.id,
    });
    await expect(
      call("propose_task_change", {
        task_id: invoice,
        column: "done",
        from_entry_id: memo,
        from_quote: "sent the invoice to Globex",
        why: "x",
      }),
    ).rejects.toThrow(/word for word/);
    await call("propose_task_change", {
      task_id: invoice,
      column: "done",
      from_entry_id: memo,
      from_quote: "Finally sent the invoice to Acme.",
      why: "Your entry says it went out.",
    });
    const [action] = await plannerAgentListActions(rt.db, {
      userId: rt.user.id,
      conversationId: CONVERSATION,
      now: NOW,
    });
    expect(action?.change).toMatchObject({
      column: "done",
      starter: "done",
      source: {
        entry_id: memo,
        quote: "Finally sent the invoice to Acme.",
        day: "2026-11-10",
      },
    });
    const accepted = await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: action?.id ?? "",
      today: TODAY,
      edit: { column: "doing" },
    });
    expect(accepted.state).toBe("accepted");
    const [log] = await plannerTestRows<{ data: string }>(
      rt.database,
      "SELECT data FROM planner_event WHERE kind = 'proposal.accepted_edited'",
    );
    expect(JSON.parse(log?.data ?? "{}")).toMatchObject({
      starter: "done",
      fields: "column",
    });
  });

  it("lays the health log next to the diary's mentions", async () => {
    await plannerTestRows(
      rt.database,
      `INSERT INTO health_entry (id, user_id, kind, day, variant, minutes, bender, needs_check, source, memo_id, dismissed, edited, created_at, updated_at)
       VALUES ('h-1', ?, 'training', '2026-11-09', 'push', 50, 0, 0, 'memo', NULL, 0, 0, ?, ?)`,
      rt.user.id,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await entry(
      "Did 15 min of Wim Hof before work.",
      "2026-11-10T07:00:00.000Z",
    );
    const text = await call("compare_health", {});
    expect(text).toMatch(
      /## 2026-11-09 \| rows, no entry mentions it\n {2}- row h-1 \| training \(push\), 50 min/,
    );
    expect(text).toMatch(
      /## 2026-11-10 \| entries mention it, no row\n {4}- entry [^\n]*"Did 15 min of Wim Hof before work\."/,
    );
  });

  it("says per entry line whether the log has a row of its kind", async () => {
    // The diary reader stamps its rows with the clock; pin it to the test's day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await plannerTestRows(
      rt.database,
      `INSERT INTO health_entry (id, user_id, kind, day, variant, minutes, bender, needs_check, source, memo_id, dismissed, edited, created_at, updated_at)
       VALUES ('h-breath', ?, 'breath', '2026-11-10', 'wim_hof', 15, 0, 0, 'memo', NULL, 0, 0, ?, ?),
              ('h-gym', ?, 'training', '2026-11-09', 'gym', 60, 0, 0, 'manual', NULL, 0, 0, ?, ?)`,
      rt.user.id,
      NOW.toISOString(),
      NOW.toISOString(),
      rt.user.id,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await entry(
      "#wimhof 15 min. Went for a 30-minute run by the river.",
      "2026-11-10T07:00:00.000Z",
    );
    await entry("Ran 5k after the gym.", "2026-11-09T18:00:00.000Z");
    await entry("Skipped the gym, went for a run.", "2026-11-09T20:00:00.000Z");
    const text = await call("compare_health", {});
    expect(text).toMatch(
      /## 2026-11-10 \| an entry mentions a session with no row\n/,
    );
    expect(text).toMatch(
      /"Went for a 30-minute run by the river\." \| training \(cardio\): NO training \(cardio\) row that day/,
    );
    expect(text).toMatch(
      /"Ran 5k after the gym\." \| training \(cardio\): logged from this entry on 2026-11-11/,
    );
    // A run on a day with only a gym row is another session.
    expect(text).toMatch(
      /"Skipped the gym, went for a run\." \| training \(cardio\): NO training \(cardio\) row that day \(it has gym, another session\)/,
    );
    // The diary reader's own row for the entry counts, whatever its day.
    expect(text).toMatch(
      /"#wimhof 15 min\." \| breath: logged from this entry/,
    );
    expect(text).toContain("2 lines have none");
    expect(text).toContain("is cardio");
  });

  it("ties a long diary line to a short task title", () => {
    expect(
      plannerSentenceAboutTask(
        "Long call with Marta, we went through the outline line by line.",
        "Call Marta about the outline",
      ),
    ).toBe(true);
    for (const [line, title] of [
      ["Finally sent the invoice to Acme.", "Send invoice to Acme"],
      ["Paid the plumber this morning.", "Pay the plumber"],
      ["Bought the present for Lea.", "Buy birthday present for Lea"],
      ["Tidied the garage at last.", "Tidy garage"],
      ["Wrote the cover letter.", "Write cover letter"],
    ]) {
      expect(plannerSentenceAboutTask(line ?? "", title ?? "")).toBe(true);
    }
    expect(
      plannerSentenceAboutTask(
        "Called the bank back.",
        "Call Marta about the outline",
      ),
    ).toBe(false);
  });

  it("reads finished and health lines by fixed rules", () => {
    expect(plannerSoundsDone("Finally sent the invoice.")).toBe(true);
    expect(plannerSoundsDone("Still need to send the invoice.")).toBe(false);
    expect(
      plannerSoundsDone("I will call the bank tomorrow, done thinking."),
    ).toBe(false);
    expect(plannerMentionsHealth("Hit the gym at 7")).toBe(true);
    expect(plannerMentionsHealth("Drinks with Lea, home at 2")).toBe(true);
    expect(plannerMentionsHealth("Wrote the deck")).toBe(false);
  });
});
