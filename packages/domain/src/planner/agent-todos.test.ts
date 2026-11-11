import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemo } from "../memos-write";
import type { TaskActor } from "../tasks";
import {
  plannerAgentAcceptAction,
  plannerAgentRevertAction,
} from "./agent-apply";
import { plannerAgentMarkSkipped } from "./agent-skip";
import {
  plannerAgentCreateRun,
  plannerAgentListActions,
  plannerAgentSettleAction,
} from "./agent-store";
import { PlannerAgentToolError, plannerAgentCallTool } from "./agent-tools";
import { plannerFlywheelRollup } from "./flywheel";
import { plannerSyncHistory } from "./history-sync";
import { plannerAddTask } from "./task-change";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "./test-support";

// Diary to-dos into tasks (docs/fork-general-agent.md, "To-dos from the
// diary"): find_todos lists the to-do lines of recent entries against the
// board, propose_add_task files one with its entry as the source, a to-do
// offered once is not offered again, and the card's edits and skips land in
// the learning log (docs/fork-flywheel.md).

let rt: PlannerTestRuntime;
const NOW = new Date("2026-11-11T10:00:00.000Z");
const TODAY = "2026-11-11";
const WEEK = "2026-11-09";
const USER: TaskActor = { type: "user" };
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

const call = (name: string, args: unknown) =>
  plannerAgentCallTool({ db: rt.db, user: rt.user, now: NOW }, name, args);

const asking = () =>
  plannerAgentCreateRun(rt.db, {
    userId: rt.user.id,
    job: "ask",
    ownerKey: `ask:${CONVERSATION}`,
    budgetCents: 500,
    step: "ask",
    now: NOW,
  });

const actions = () =>
  plannerAgentListActions(rt.db, {
    userId: rt.user.id,
    conversationId: CONVERSATION,
    now: NOW,
  });

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

describe("diary to-dos into tasks", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("planner-agent-todos-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memos", "memo_tags", "memo_revisions", "embedding_tasks"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  it("lists recent to-do lines, marking the ones a task covers", async () => {
    const recent = await entry(
      "Slept badly. I need to renew the passport.\n- [ ] call the bank",
      "2026-11-10T19:00:00.000Z",
    );
    await entry(
      "I need to repaint the hall.",
      "2026-10-01T19:00:00.000Z", // older than 14 days
    );
    await plannerAddTask(rt.db, {
      user: rt.user,
      actor: USER,
      title: "Renew passport",
      today: TODAY,
    });
    const text = await call("find_todos", {});
    expect(text).toContain(`entry ${recent}`);
    expect(text).toMatch(
      /"I need to renew the passport\." \| maybe on the board: \[[^\]]+\] "Renew passport" \(Backlog\)/,
    );
    expect(text).toMatch(/open box \| "call the bank" \| not on the board/);
    expect(text).not.toContain("repaint");
    expect(await call("find_todos", { days: 60 })).toContain("repaint");
  });

  it("files a to-do with its entry as the source, once", async () => {
    await asking();
    const id = await entry(
      "- [ ] call the bank about the card",
      "2026-11-10T19:00:00.000Z",
    );
    await expect(
      call("propose_add_task", {
        title: "Call the bank",
        from_entry_id: id,
        from_quote: "call the plumber",
        why: "You wrote it on Tuesday.",
      }),
    ).rejects.toBeInstanceOf(PlannerAgentToolError);
    await expect(
      call("propose_add_task", {
        title: "Call the bank",
        from_entry_id: id,
        why: "x",
      }),
    ).rejects.toThrow(/go together/);

    await call("propose_add_task", {
      title: "Call the bank",
      from_entry_id: id,
      from_quote: "call the bank about the card",
      why: "You wrote it on Tuesday.",
    });
    const [action] = await actions();
    expect(action?.kind).toBe("task_new");
    expect(action?.change.source).toEqual({
      entry_id: id,
      quote: "call the bank about the card",
      day: "2026-11-10",
      preview: "- [ ] call the bank about the card",
    });
    expect(action?.change).not.toHaveProperty("from_entry_id");

    // Dismissed: not offered again, and find_todos says so.
    await plannerAgentSettleAction(rt.db, {
      userId: rt.user.id,
      id: action?.id ?? "",
      state: "dismissed",
    });
    await expect(
      call("propose_add_task", {
        title: "Phone the bank",
        from_entry_id: id,
        from_quote: "Call the bank about the card",
        why: "again",
      }),
    ).rejects.toThrow(/offered before \(dismissed\)/);
    expect(await call("find_todos", {})).toContain(
      "offered before (dismissed): do not offer again",
    );
  });

  it("logs an edited accept and a skip, and counts both", async () => {
    await asking();
    const id = await entry(
      "- [ ] renew passport\n- [ ] book dentist\n- [ ] fix bike",
      "2026-11-10T19:00:00.000Z",
    );
    for (const [title, quote] of [
      ["Renew passport", "renew passport"],
      ["Book dentist", "book dentist"],
      ["Fix bike", "fix bike"],
    ]) {
      await call("propose_add_task", {
        title,
        from_entry_id: id,
        from_quote: quote,
        why: "From Tuesday's entry.",
      });
    }
    const [first, second, third] = await actions();

    // Edited on the card, then accepted; a plain accept; one left unticked.
    const edited = await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: first?.id ?? "",
      today: TODAY,
      edit: { title: "Renew passport at the town hall", due_at: "2026-11-20" },
    });
    expect(edited.state).toBe("accepted");
    expect(edited.change.edited).toMatchObject({
      title: "Renew passport at the town hall",
    });
    await plannerAgentAcceptAction(rt.db, {
      user: rt.user,
      id: second?.id ?? "",
      today: TODAY,
    });
    const dismissed = await plannerAgentSettleAction(rt.db, {
      userId: rt.user.id,
      id: third?.id ?? "",
      state: "dismissed",
    });
    const skipped = await plannerAgentMarkSkipped(rt.db, {
      userId: rt.user.id,
      action: dismissed!,
      now: NOW,
    });
    expect(skipped.change.settled_reason).toBe("skipped");

    const log = await plannerTestRows<{ kind: string; data: string }>(
      rt.database,
      "SELECT kind, data FROM planner_event WHERE user_id = ? ORDER BY kind",
      rt.user.id,
    );
    expect(log.map((row) => row.kind)).toEqual([
      "proposal.accepted_edited",
      "proposal.skipped",
    ]);
    expect(JSON.parse(log[0]?.data ?? "{}")).toEqual({
      action_kind: "task_new",
      field: null,
      fields: "title,due_at",
      count: 2,
      from_diary: true,
      starter: null,
      title_chars: 17,
    });
    expect(JSON.parse(log[1]?.data ?? "{}")).toEqual({
      action_kind: "task_new",
      field: null,
      from_diary: true,
      starter: null,
    });
    // Numbers and names only: no words of the entry or the titles.
    expect(log.map((row) => row.data).join(" ")).not.toMatch(/passport|bike/);

    // Undo the edited one: the task is dropped, and the to-do is still not
    // offered again.
    await plannerSyncHistory(rt.db, {
      userId: rt.user.id,
      now: NOW,
      force: true,
    });
    const undone = await plannerAgentRevertAction(rt.db, {
      user: rt.user,
      actor: USER,
      id: first?.id ?? "",
      today: TODAY,
    });
    expect(undone.state).toBe("reverted");
    await expect(
      call("propose_add_task", {
        title: "Renew passport",
        from_entry_id: id,
        from_quote: "renew passport",
        why: "again",
      }),
    ).rejects.toThrow(/offered before \(reverted\)/);

    const week = await plannerFlywheelRollup(rt.db, {
      userId: rt.user.id,
      weekStart: WEEK,
      now: NOW,
    });
    const metric = (name: string) =>
      week.values.find((v) => v.metric === name && v.origin === "ai");
    expect(metric("proposals_skipped")).toMatchObject({ num: 1, den: 3 });
    expect(metric("todos_accepted")).toMatchObject({ num: 2, den: 3 });
    expect(metric("todos_edited")).toMatchObject({ num: 1, den: 2 });
  });
});
