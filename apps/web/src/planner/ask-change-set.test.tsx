// @vitest-environment jsdom
import type {
  PlannerAgentActionDto,
  PlannerAskResponse,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  plannerFetchAsk,
  plannerRevertActionRequest,
  plannerSettleActionRequest,
} from "./ask-api";
import {
  PlannerAskChat,
  plannerGroupActions,
  plannerLineDiff,
} from "./ask-chat";
import { plannerFetchGoalsYear } from "./goals-api";
import {
  type PlannerTestMount,
  plannerTestMount,
  plannerTestType,
} from "./test-render";

// One card per answer (docs/fork-general-agent.md, "One card per answer"):
// every proposal of one answer sits in one card with a tick box each; Accept
// writes the ticked ones one by one, Dismiss settles the rest, and Undo all
// puts back what was accepted. A single proposal keeps its own card, with Undo
// once accepted. The network is replaced.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./ask-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ask-api")>()),
  plannerFetchAsk: vi.fn(),
  plannerSettleActionRequest: vi.fn(),
  plannerRevertActionRequest: vi.fn(),
}));

vi.mock("./goals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./goals-api")>()),
  plannerFetchGoalsYear: vi.fn(),
}));

const fetchGoals = vi.mocked(plannerFetchGoalsYear);
const fetchAsk = vi.mocked(plannerFetchAsk);
const settleAction = vi.mocked(plannerSettleActionRequest);
const revertAction = vi.mocked(plannerRevertActionRequest);

const CONVERSATION = "33333333-3333-4333-8333-333333333333";

function action(
  id: string,
  patch: Partial<PlannerAgentActionDto>,
): PlannerAgentActionDto {
  return {
    id,
    kind: "task_change",
    task_id: `tasks/${id}`,
    field: "due_at",
    change: { due_at: "2026-11-07", was: null, task_title: `Task ${id}` },
    why: "Friday, as asked.",
    state: "open",
    landed_id: null,
    entry_id: null,
    created_at: "2026-11-02T10:00:05.000Z",
    ...patch,
  };
}

const QUESTION = {
  id: "m1",
  role: "owner" as const,
  text: "Move my overdue tasks to Friday",
  created_at: "2026-11-02T10:00:00.000Z",
};

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;

async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function show(actions: PlannerAgentActionDto[]) {
  const response: PlannerAskResponse = {
    enabled: true,
    conversation: CONVERSATION,
    task: null,
    messages: [QUESTION],
    actions,
    status: "idle",
  };
  fetchAsk.mockResolvedValue(response);
  mounted = plannerTestMount(
    <PlannerAskChat
      state={{ conversation: CONVERSATION, fresh: false, draft: "" }}
      onChange={() => {}}
    />,
    { queryClient },
  );
  return mounted.container;
}

const rows = (container: Element) =>
  Array.from(container.querySelectorAll('[data-testid="planner-proposal"]'));

const button = (container: Element, text: string) =>
  Array.from(container.querySelectorAll("button")).find((each) =>
    each.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fetchGoals.mockResolvedValue({
    year: 2026,
    today: "2026-11-10",
    current_week: "2026-11-09",
    north_star: null,
    weeks: [],
    goals: [
      {
        id: "goal-1",
        level: "week",
        period_start: "2026-11-09",
        pillar: "work",
        title: "Ship the invoice flow",
        lines: [],
        status: "active",
        note: null,
        result: null,
        sort_order: 0,
        created_at: "2026-11-09T08:00:00.000Z",
        updated_at: "2026-11-09T08:00:00.000Z",
      },
    ],
  } as never);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
});

describe("one card per answer", () => {
  it("groups proposals by the question they answer", () => {
    const early = action("a", { created_at: "2026-11-02T09:00:00.000Z" });
    const late = action("b", { created_at: "2026-11-02T11:00:00.000Z" });
    const later = action("c", { created_at: "2026-11-02T11:00:01.000Z" });
    expect(
      plannerGroupActions(
        [early, late, later],
        ["2026-11-02T08:00:00.000Z", "2026-11-02T10:30:00.000Z"],
      ).map((group) => group.map((each) => each.id)),
    ).toEqual([["a"], ["b", "c"]]);
  });

  it("accepts only the ticked rows, dismisses the rest, then undoes all", async () => {
    const rows = [action("a", {}), action("b", {}), action("c", {})];
    settleAction.mockImplementation(async (id, input) => ({
      action: {
        ...(rows.find((row) => row.id === id) as PlannerAgentActionDto),
        state: input.state,
      },
    }));
    revertAction.mockImplementation(async (id) => ({
      action: {
        ...(rows.find((row) => row.id === id) as PlannerAgentActionDto),
        state: "reverted",
      },
    }));
    const container = show(rows);
    await settle();

    const card = container.querySelector('[data-testid="planner-change-set"]');
    expect(card?.textContent).toContain("3 changes");
    expect(card?.textContent).toContain("Task a");
    // An empty value before reads "none", not "cleared".
    expect(card?.textContent).toContain("none →");
    expect(card?.textContent).not.toContain("cleared");
    const boxes = card?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(3);
    await act(async () => {
      boxes?.[1]?.click();
    });
    expect(button(container, "Accept 2")).toBeDefined();
    await act(async () => {
      button(container, "Accept 2")?.click();
    });
    await settle();
    expect(
      settleAction.mock.calls.map(([id, input]) => [id, input.state]),
    ).toEqual([
      ["a", "accepted"],
      ["c", "accepted"],
    ]);

    await act(async () => {
      button(container, "Dismiss the open one")?.click();
    });
    await settle();
    expect(settleAction).toHaveBeenLastCalledWith("b", {
      state: "dismissed",
      today: expect.any(String),
    });

    await act(async () => {
      button(container, "Undo all 2")?.click();
    });
    await settle();
    // Newest first.
    expect(revertAction.mock.calls.map(([id]) => id)).toEqual(["c", "a"]);
    expect(card?.textContent).toContain("Undone");
  });

  it("shows a refused row's reason on its own line and goes on with the others", async () => {
    const rows = [action("a", {}), action("b", {})];
    settleAction.mockImplementation(async (id, input) => {
      if (id === "a") {
        const { ApiError } = await import("@/api/client");
        throw new ApiError("This changed since the agent proposed it.", 400);
      }
      return {
        action: {
          ...(rows.find((row) => row.id === id) as PlannerAgentActionDto),
          state: input.state,
        },
      };
    });
    const container = show(rows);
    await settle();
    await act(async () => {
      button(container, "Accept 2")?.click();
    });
    await settle();
    expect(settleAction).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      "This changed since the agent proposed it.",
    );
  });

  it("keeps a single proposal as its own card, with Undo once accepted", async () => {
    const one = action("a", { state: "accepted" });
    revertAction.mockResolvedValue({ action: { ...one, state: "reverted" } });
    const container = show([one]);
    await settle();
    expect(
      container.querySelector('[data-testid="planner-change-set"]'),
    ).toBeNull();
    await act(async () => {
      button(container, "Undo")?.click();
    });
    await settle();
    expect(revertAction).toHaveBeenCalledWith("a", {
      today: expect.any(String),
    });
  });

  it("shows an accepted entry edit as the lines it removes and adds", async () => {
    expect(
      plannerLineDiff(
        "Went to the gym.\nFelt slow.",
        "Went to the gym.\nFelt strong.",
      ),
    ).toEqual([
      { kind: "same", text: "Went to the gym." },
      { kind: "gone", text: "Felt slow." },
      { kind: "new", text: "Felt strong." },
    ]);
    const container = show([
      action("e", {
        kind: "entry_edit",
        task_id: null,
        field: null,
        entry_id: "memos/e",
        state: "accepted",
        change: {
          entry_id: "memos/e",
          flag: "Felt slow, but the log says a PR",
          content: "Went to the gym.\nFelt strong.",
          was: "Went to the gym.\nFelt slow.",
        },
      }),
    ]);
    await settle();
    const diff = container.querySelector('[data-testid="planner-entry-diff"]');
    expect(diff?.querySelector('[data-kind="gone"]')?.textContent).toBe(
      "Felt slow.",
    );
    expect(diff?.querySelector('[data-kind="new"]')?.textContent).toBe(
      "Felt strong.",
    );
  });

  it("shows a place on the board and an entry link as rows", async () => {
    const container = show([
      action("p", {
        field: "place",
        change: {
          column: "todo",
          after_id: "tasks/q",
          was: { column: "backlog", board_rank: null },
          task_title: "Mover",
          anchor_title: "Anchor",
        },
      }),
      action("l", {
        kind: "entry_link",
        task_id: null,
        field: null,
        entry_id: "memos/l",
        change: {
          entry_id: "memos/l",
          related_entry_id: "memos/m",
          was: [],
          preview: "Slept badly. #sleep",
          related_preview: "Skipped the gym.",
        },
      }),
    ]);
    await settle();
    const card = container.querySelector('[data-testid="planner-change-set"]');
    expect(card?.textContent).toContain("Move on the board");
    expect(card?.textContent).toContain("Mover");
    // An open place is two fields: the column, and the agent's spot in it.
    const spot = card?.querySelector<HTMLSelectElement>(
      'select[aria-label="place"]',
    );
    expect(spot?.value).toBe("anchor");
    expect(spot?.selectedOptions[0]?.textContent).toBe("Below Anchor");
    expect(
      card?.querySelector<HTMLSelectElement>('select[aria-label="column"]')
        ?.value,
    ).toBe("todo");
    expect(card?.textContent).toContain("Link entries");
    expect(card?.textContent).toContain(
      "Slept badly. #sleep → Skipped the gym.",
    );
  });
  it("shows a memory correction, a forgotten memory and health rows", async () => {
    const base = { task_id: null, field: null, entry_id: null } as const;
    const container = show([
      action("m", {
        ...base,
        kind: "memory_change",
        change: {
          memory_id: "memories/m",
          action: "correct",
          content: "Lives in Leeds.",
          was: { content: "Lives in Hull.", status: "active" },
          label: "Lives in Hull.",
        },
      }),
      action("f", {
        ...base,
        kind: "memory_change",
        change: {
          memory_id: "memories/f",
          action: "forget",
          was: { content: "Hates mornings.", status: "active" },
          label: "Hates mornings.",
        },
      }),
      action("h", {
        ...base,
        kind: "health_change",
        change: {
          action: "fix",
          health_id: "h1",
          minutes: 45,
          day: "2026-11-03",
          was: { minutes: 30, day: "2026-11-02" },
          label: "2026-11-02 training",
        },
      }),
      action("a", {
        ...base,
        kind: "health_change",
        change: {
          action: "add",
          day: "2026-11-01",
          kind: "night_out",
          home_at: "02:30",
          label: "2026-11-01 night out",
        },
      }),
    ]);
    await settle();
    const text =
      container.querySelector('[data-testid="planner-change-set"]')
        ?.textContent ?? "";
    expect(text).toContain("Correct memory");
    expect(text).toContain("Lives in Hull. → Lives in Leeds.");
    expect(text).toContain("Forget memory");
    expect(text).toContain("Hates mornings.");
    expect(text).toContain("Fix health row");
    // The fix's minutes are a field; the day (no field) stays words.
    expect(text).toContain("minutes: 30 min →");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="minutes"]')
        ?.value,
    ).toBe("45");
    expect(text).toContain("day: 2026-11-02 → 2026-11-03");
    expect(text).toContain("Add health row");
    expect(text).toContain("2026-11-01 night out");
    expect(text).toContain("home 02:30");
  });
  it("shows a flagged new weekly goal and a flagged one, and settled goals with the owner's words", async () => {
    const base = { task_id: null, field: null, entry_id: null } as const;
    const container = show([
      action("g", {
        ...base,
        kind: "goal_change",
        change: {
          action: "add",
          period_start: "2026-11-09",
          pillar: "health",
          flag: "You wrote you'd train three times",
          week: "2026-11-09",
          label: "You wrote you'd train three times",
        },
      }),
      action("e", {
        ...base,
        kind: "goal_change",
        change: {
          action: "edit",
          goal_id: "goal-1",
          flag: "Dana reviews it; you don't send it",
          was: {
            title: "Ship the invoice flow",
            lines: [{ text: "Draft" }, { text: "Send" }],
            note: null,
            pillar: "work",
          },
          goal_title: "Ship the invoice flow",
          week: "2026-11-09",
          label: "Ship the invoice flow",
        },
      }),
      action("d", {
        ...base,
        kind: "goal_change",
        state: "accepted",
        change: {
          action: "edit",
          goal_id: "goal-1",
          title: "Ship invoices",
          was: {
            title: "Ship the invoice flow",
            lines: [{ text: "Draft" }],
            note: null,
            pillar: "work",
          },
          goal_title: "Ship the invoice flow",
          week: "2026-11-09",
        },
      }),
    ]);
    await settle();
    const [add, edit, done] = rows(container);
    expect(add?.textContent).toContain("New weekly goal");
    expect(add?.textContent).toContain("You wrote you'd train three times");
    const title = add?.querySelector<HTMLInputElement>(
      'input[aria-label="title"]',
    );
    expect(title?.value).toBe("");
    expect(title?.placeholder).toBe("Write the goal's title");
    expect(add?.textContent).toContain("Write a title to accept it");
    expect(edit?.textContent).toContain("Dana reviews it; you don't send it");
    expect(
      edit?.querySelector<HTMLInputElement>('input[aria-label="title"]')?.value,
    ).toBe("Ship the invoice flow");
    expect(
      edit?.querySelector<HTMLTextAreaElement>('textarea[aria-label="lines"]')
        ?.value,
    ).toBe("Draft\nSend");
    expect(done?.textContent).toContain(
      "title: Ship the invoice flow → Ship invoices",
    );
    // Both open rows wait on the owner's words: nothing to accept yet.
    expect(button(container, "Accept 0")?.disabled).toBe(true);
  });
});

// Edit before Accept (docs/fork-general-agent.md): every value on an open row is
// a field. A value that differs from the proposal marks the row Edited, Reset
// puts it back, and Accept sends only the edited values as `edit`.
describe("editing a card before Accept", () => {
  /** Picks an option the way React hears it: the native setter, then a change event. */
  function choose(select: HTMLSelectElement | null | undefined, value: string) {
    if (!select) throw new Error("There is no such select.");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const newTask = (id: string, title: string) =>
    action(id, {
      kind: "task_new",
      task_id: null,
      field: null,
      change: { title, column: "backlog", due_at: "2026-11-12" },
    });

  it("shows Edited on a changed row only, and Reset puts the proposal back", async () => {
    const container = show([action("a", {}), action("b", {})]);
    await settle();
    const [first, second] = rows(container);
    const due = first?.querySelector<HTMLInputElement>(
      'input[aria-label="due date"]',
    );
    expect(due).not.toBeNull();
    expect(first?.textContent).not.toContain("Edited");

    plannerTestType(due as HTMLInputElement, "2026-11-09");
    expect(rows(container)[0]?.textContent).toContain("Edited");
    expect(rows(container)[1]?.textContent).not.toContain("Edited");
    expect(
      rows(container)[0]?.querySelector<HTMLInputElement>(
        'input[aria-label="due date"]',
      )?.value,
    ).toBe("2026-11-09");

    await act(async () => {
      (
        button(rows(container)[0] as Element, "Reset") as HTMLButtonElement
      ).click();
    });
    expect(rows(container)[0]?.textContent).not.toContain("Edited");
    expect(
      rows(container)[0]?.querySelector<HTMLInputElement>(
        'input[aria-label="due date"]',
      )?.value,
    ).toBe("2026-11-07");
    expect(second).toBeDefined();
  });

  it("typing the proposed value back is not an edit", async () => {
    const container = show([action("a", {}), action("b", {})]);
    await settle();
    const due = () =>
      rows(container)[0]?.querySelector<HTMLInputElement>(
        'input[aria-label="due date"]',
      ) as HTMLInputElement;
    plannerTestType(due(), "2026-11-09");
    expect(rows(container)[0]?.textContent).toContain("Edited");
    plannerTestType(due(), "2026-11-07");
    expect(rows(container)[0]?.textContent).not.toContain("Edited");
  });

  it("sends only the edited values with Accept, and nothing for an untouched row", async () => {
    const rowsIn = [
      newTask("a", "Call the bank"),
      newTask("b", "Send the deck"),
    ];
    settleAction.mockImplementation(async (id, input) => ({
      action: {
        ...(rowsIn.find((row) => row.id === id) as PlannerAgentActionDto),
        state: input.state,
      },
    }));
    const container = show(rowsIn);
    await settle();
    const first = rows(container)[0] as Element;
    plannerTestType(
      first.querySelector<HTMLInputElement>(
        'input[aria-label="title"]',
      ) as HTMLInputElement,
      "Call the bank about the card",
    );
    choose(
      first.querySelector<HTMLSelectElement>('select[aria-label="column"]'),
      "todo",
    );
    // The goal picker lists this week's goals, and "No goal".
    const goal = rows(container)[0]?.querySelector<HTMLSelectElement>(
      'select[aria-label="goal"]',
    );
    expect(Array.from(goal?.options ?? []).map((o) => o.textContent)).toEqual([
      "No goal",
      "Ship the invoice flow",
    ]);
    choose(goal, "goal-1");
    expect(rows(container)[0]?.textContent).toContain("Edited");
    expect(rows(container)[1]?.textContent).not.toContain("Edited");

    await act(async () => {
      button(container, "Accept 2")?.click();
    });
    await settle();
    expect(settleAction.mock.calls).toEqual([
      [
        "a",
        {
          state: "accepted",
          today: expect.any(String),
          edit: {
            title: "Call the bank about the card",
            column: "todo",
            goal_id: "goal-1",
          },
        },
      ],
      ["b", { state: "accepted", today: expect.any(String) }],
    ]);
  });

  it("an unticked row stays skipped, edited or not", async () => {
    const rowsIn = [newTask("a", "One"), newTask("b", "Two")];
    settleAction.mockImplementation(async (id, input) => ({
      action: {
        ...(rowsIn.find((row) => row.id === id) as PlannerAgentActionDto),
        state: input.state,
      },
    }));
    const container = show(rowsIn);
    await settle();
    choose(
      rows(container)[0]?.querySelector<HTMLSelectElement>(
        'select[aria-label="column"]',
      ),
      "doing",
    );
    await act(async () => {
      rows(container)[0]
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click();
    });
    await act(async () => {
      button(container, "Accept 1")?.click();
    });
    await settle();
    expect(settleAction.mock.calls.map(([id]) => id)).toEqual(["b"]);
  });

  it("a lone card edits too, and sends the place as column and spot", async () => {
    const place = action("p", {
      field: "place",
      change: {
        column: "todo",
        before_id: "tasks/q",
        was: { column: "backlog", board_rank: null },
        task_title: "Mover",
        anchor_title: "Anchor",
      },
    });
    settleAction.mockResolvedValue({ action: { ...place, state: "accepted" } });
    const container = show([place]);
    await settle();
    const card = container.querySelector('[data-testid="planner-proposal"]');
    const spot = () =>
      card?.querySelector<HTMLSelectElement>('select[aria-label="place"]');
    expect(
      Array.from(spot()?.options ?? []).map((option) => option.textContent),
    ).toEqual(["Above Anchor", "Top of the column", "Bottom of the column"]);
    choose(
      card?.querySelector<HTMLSelectElement>('select[aria-label="column"]'),
      "doing",
    );
    // Another column has no agent's spot: the options are top and bottom.
    expect(spot()?.value).toBe("top");
    expect(
      Array.from(spot()?.options ?? []).map((option) => option.textContent),
    ).toEqual(["Top of the column", "Bottom of the column"]);
    choose(spot(), "bottom");
    await act(async () => {
      button(container, "Accept")?.click();
    });
    await settle();
    expect(settleAction).toHaveBeenCalledWith("p", {
      state: "accepted",
      today: expect.any(String),
      edit: { column: "doing", spot: "bottom" },
    });
  });

  it("offers a health add as kind, minutes and day, and an old entry edit as the owner's to rewrite", async () => {
    const health = action("h", {
      kind: "health_change",
      task_id: null,
      field: null,
      change: {
        action: "add",
        day: "2026-11-08",
        kind: "training",
        variant: "push",
        minutes: 30,
        label: "2026-11-08 training",
      },
    });
    const memory = action("m", {
      kind: "entry_edit",
      task_id: null,
      field: null,
      entry_id: "memos/m",
      change: { entry_id: "memos/m", content: "New text", was: "Old text" },
    });
    settleAction.mockResolvedValue({
      action: { ...health, state: "accepted" },
    });
    const container = show([health, memory]);
    await settle();
    const [healthRow, entryRow] = rows(container);
    choose(
      healthRow?.querySelector<HTMLSelectElement>('select[aria-label="Kind"]'),
      "breath:wim_hof",
    );
    plannerTestType(
      rows(container)[0]?.querySelector<HTMLInputElement>(
        'input[aria-label="minutes"]',
      ) as HTMLInputElement,
      "15",
    );
    // The heading follows the kind and day picked on the card.
    expect(rows(container)[0]?.textContent).toContain("2026-11-08 breath");
    expect(rows(container)[0]?.textContent).not.toContain("training");
    // An entry edit from before the flags: the field starts from the entry's
    // own text, never the agent's, and waits on the owner's rewrite.
    expect(
      entryRow?.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("Old text");
    expect(entryRow?.textContent).not.toContain("New text");
    expect(entryRow?.textContent).toContain("Rewrite the entry to accept it");
    await act(async () => {
      button(container, "Accept 1")?.click();
    });
    await settle();
    expect(settleAction.mock.calls[0]).toEqual([
      "h",
      {
        state: "accepted",
        today: expect.any(String),
        edit: { kind: "breath", variant: "wim_hof", minutes: 15 },
      },
    ]);
  });

  it("a flagged entry starts from its own text, and Accept waits for the owner's rewrite, then sends it", async () => {
    const flagged = action("f", {
      kind: "entry_edit",
      task_id: null,
      field: null,
      entry_id: "memos/f",
      change: {
        entry_id: "memos/f",
        flag: "Line 1 says Tuesday but the gym was Monday",
        quote: "Gym on Tuesday",
        was: "Gym on Tuesday.\nFelt slow.",
        preview: "Gym on Tuesday.",
      },
    });
    settleAction.mockResolvedValue({
      action: { ...flagged, state: "accepted" },
    });
    const container = show([flagged]);
    await settle();
    const card = container.querySelector('[data-testid="planner-proposal"]');
    expect(card?.textContent).toContain("Entry to fix");
    expect(card?.textContent).toContain(
      "Line 1 says Tuesday but the gym was Monday",
    );
    expect(card?.textContent).toContain("“Gym on Tuesday”");
    const area = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="The entry, as you want it to read"]',
      ) as HTMLTextAreaElement;
    expect(area().value).toBe("Gym on Tuesday.\nFelt slow.");
    const accept = () => button(container, "Accept") as HTMLButtonElement;
    expect(accept().disabled).toBe(true);
    plannerTestType(area(), "Gym on Monday.\nFelt slow.");
    expect(accept().disabled).toBe(false);
    // Typing it back to what it was is no rewrite.
    plannerTestType(area(), "Gym on Tuesday.\nFelt slow.");
    expect(accept().disabled).toBe(true);
    plannerTestType(area(), "Gym on Monday.\nFelt slow.");
    await act(async () => {
      accept().click();
    });
    await settle();
    expect(settleAction).toHaveBeenCalledWith("f", {
      state: "accepted",
      today: expect.any(String),
      edit: { text: "Gym on Monday.\nFelt slow." },
    });
  });

  it("sends the owner's title and lines for a flagged new goal", async () => {
    const goal = action("g", {
      kind: "goal_change",
      task_id: null,
      field: null,
      change: {
        action: "add",
        period_start: "2026-11-09",
        pillar: "health",
        flag: "You wrote you'd train three times",
        week: "2026-11-09",
      },
    });
    settleAction.mockResolvedValue({ action: { ...goal, state: "accepted" } });
    const container = show([goal]);
    await settle();
    const accept = () => button(container, "Accept") as HTMLButtonElement;
    expect(accept().disabled).toBe(true);
    plannerTestType(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="title"]',
      ) as HTMLInputElement,
      "Train three times",
    );
    plannerTestType(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="lines"]',
      ) as HTMLTextAreaElement,
      "Mon\n\nWed \nFri",
    );
    expect(accept().disabled).toBe(false);
    await act(async () => {
      accept().click();
    });
    await settle();
    expect(settleAction).toHaveBeenCalledWith("g", {
      state: "accepted",
      today: expect.any(String),
      edit: { title: "Train three times", lines: ["Mon", "Wed", "Fri"] },
    });
  });

  it("marks an accepted row Edited from what the server kept, with no controls", async () => {
    const container = show([
      {
        ...newTask("a", "Call the bank about the card"),
        state: "accepted",
        change: {
          title: "Call the bank about the card",
          column: "todo",
          proposed: { title: "Call the bank" },
          edited: { title: "Call the bank about the card" },
        },
      },
      { ...newTask("b", "Send the deck"), state: "accepted" },
    ]);
    await settle();
    const [first, second] = rows(container);
    expect(first?.textContent).toContain("Edited");
    expect(second?.textContent).not.toContain("Edited");
    expect(container.querySelectorAll("select, input[type=date]")).toHaveLength(
      0,
    );
  });
});
