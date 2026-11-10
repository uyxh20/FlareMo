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
import { type PlannerTestMount, plannerTestMount } from "./test-render";

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

const button = (container: Element, text: string) =>
  Array.from(container.querySelectorAll("button")).find((each) =>
    each.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
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

  it("shows an entry edit as the lines it removes and adds", async () => {
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
        change: {
          entry_id: "memos/e",
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
    expect(card?.textContent).toContain("below Anchor");
    expect(card?.textContent).toContain("Link entries");
    expect(card?.textContent).toContain(
      "Slept badly. #sleep → Skipped the gym.",
    );
  });
});
