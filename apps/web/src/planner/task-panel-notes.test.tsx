// @vitest-environment jsdom
import type {
  PlannerTaskDetailResponse,
  PlannerTaskPlanResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { plannerUpdateTaskRequest } from "./api";
import { plannerQueryKeys } from "./query-keys";
import { PlannerTaskNotes } from "./task-panel-notes";
import {
  type PlannerTestMount,
  plannerTestBlur,
  plannerTestClick,
  plannerTestFocus,
  plannerTestMount,
  plannerTestPageHide,
  plannerTestRestoreVisibility,
  plannerTestSetVisibility,
  plannerTestType,
} from "./test-render";

// The task panel's notes box (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): it saves by itself
// about 800 ms after typing stops (never sooner than 5 s after the previous save
// began) and when it loses focus, says "Saving…" and "Saved", and keeps the words
// when a save fails. The timing rules themselves are in
// use-planner-autosave.test.ts; this is the box as a person meets it, with the
// network replaced and fake timers.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUpdateTaskRequest: vi.fn(),
}));

const update = vi.mocked(plannerUpdateTaskRequest);

const TODAY = "2026-10-07";
const TASK_ID = "tasks/t1";

const TASK: TaskDto = {
  id: TASK_ID,
  project_id: null,
  source_memo_id: null,
  title: "Write the launch announcement",
  notes: "Draft in the doc",
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

const DETAIL: PlannerTaskDetailResponse = {
  task: TASK,
  plan: null,
  project: null,
  comments: [],
};

/** The server's answer to saving `notes`. */
function answer(notes: string | null): PlannerTaskPlanResponse {
  return {
    task: { ...TASK, notes, updated_at: "2026-10-07T09:00:00.000Z" },
    plan: null,
  };
}

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  // Date too: the box measures the 5 s between its saves with the clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(plannerQueryKeys.detail(TASK_ID), DETAIL);
  update.mockImplementation(async (_id, input) =>
    answer((input.notes as string | null | undefined) ?? null),
  );
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  plannerTestRestoreVisibility();
  queryClient.clear();
  vi.useRealTimers();
});

function show(notes: string | null = "Draft in the doc") {
  const ui = (value: string | null) => (
    <PlannerTaskNotes notes={value} taskId={TASK_ID} today={TODAY} />
  );
  mounted = plannerTestMount(ui(notes), { queryClient });
  const root = mounted.container;
  return {
    root,
    rerender: (value: string | null) => mounted?.rerender(ui(value)),
    box: () => root.querySelector("textarea") as HTMLTextAreaElement,
    status: () =>
      root.querySelector('[data-testid="planner-notes-status"]')?.textContent ??
      "",
    retry: () =>
      Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry",
      ),
  };
}

/** Lets time pass, and the saves that finish in it. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------

describe("the notes box", () => {
  it("shows the task's notes under a Notes heading, with nothing said about saving", () => {
    const { root, box, status } = show();
    expect(root.querySelector("h3")?.textContent).toBe("Notes");
    expect(box().value).toBe("Draft in the doc");
    expect(box().getAttribute("aria-labelledby")).toBe(
      root.querySelector("h3")?.id,
    );
    expect(status()).toBe("");
  });

  it("invites notes when there are none", () => {
    const { box } = show(null);
    expect(box().value).toBe("");
    expect(box().placeholder).toBe("Add notes…");
  });

  it("saves about 800 ms after typing stops, saying Saving… and then Saved", async () => {
    const { box, status } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Draft in the doc, then ship it");

    await wait(799);
    expect(update).not.toHaveBeenCalled();
    expect(status()).toBe("");

    let finish!: (value: PlannerTaskPlanResponse) => void;
    update.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await wait(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      notes: "Draft in the doc, then ship it",
    });
    expect(status()).toBe("Saving…");

    await act(async () => {
      finish(answer("Draft in the doc, then ship it"));
    });
    expect(status()).toBe("Saved");
  });

  it("starts the wait again with every key, and saves only the latest text", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "One");
    await wait(500);
    plannerTestType(box(), "One two");
    await wait(500);
    // 1000 ms after the first key, 500 after the second: still waiting.
    expect(update).not.toHaveBeenCalled();
    await wait(300);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      notes: "One two",
    });
  });

  it("holds a second save until 5 s after the first began, so typing leaves room in the rate limit", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "One");
    await wait(800);
    expect(update).toHaveBeenCalledTimes(1);

    plannerTestType(box(), "One two");
    await wait(800);
    // The pause ran out 1.6 s in, inside the gap: held, not dropped.
    expect(update).toHaveBeenCalledTimes(1);
    await wait(4_199);
    expect(update).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(TASK_ID, {
      today: TODAY,
      notes: "One two",
    });
  });

  it("saves at once on a blur inside the gap, and the held pause sends nothing more", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "One");
    await wait(800);

    plannerTestType(box(), "One two");
    plannerTestBlur(box());
    await wait(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(TASK_ID, {
      today: TODAY,
      notes: "One two",
    });
    await wait(10_000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("saves at once when the page is hidden, even inside the gap, asking for a request that outlives the page", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "One");
    await wait(800);
    expect(update).toHaveBeenCalledTimes(1);
    // The typing timer's save is an ordinary one: no options.
    expect(update).toHaveBeenLastCalledWith(TASK_ID, {
      today: TODAY,
      notes: "One",
    });

    plannerTestType(box(), "One two");
    plannerTestSetVisibility("hidden");
    await wait(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(
      TASK_ID,
      { today: TODAY, notes: "One two" },
      { keepalive: true },
    );

    // Coming back to the page sends nothing, and the held pause sends no copy.
    plannerTestSetVisibility("visible");
    await wait(10_000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("saves at once on pagehide too, and sends nothing when everything is saved", async () => {
    const { box } = show();
    plannerTestPageHide();
    plannerTestSetVisibility("hidden");
    await wait(0);
    expect(update).not.toHaveBeenCalled();

    plannerTestFocus(box());
    plannerTestType(box(), "Typed just before the tab closed");
    plannerTestPageHide();
    await wait(0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(
      TASK_ID,
      { today: TODAY, notes: "Typed just before the tab closed" },
      { keepalive: true },
    );
  });

  it("saves what is left when the panel goes away inside the gap", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "One");
    await wait(800);

    plannerTestType(box(), "One two");
    mounted?.unmount();
    mounted = undefined;
    await wait(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(TASK_ID, {
      today: TODAY,
      notes: "One two",
    });
  });

  it("saves at once when the box loses focus", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Quick note");
    plannerTestBlur(box());
    await wait(0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      notes: "Quick note",
    });
    // And not a second time when the timer would have run out.
    await wait(1000);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("saves empty notes as none", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "   ");
    plannerTestBlur(box());
    await wait(0);
    expect(update).toHaveBeenCalledWith(TASK_ID, { today: TODAY, notes: null });
  });

  it("does not save a change the server would not keep: trailing space is not an edit", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Draft in the doc  ");
    plannerTestBlur(box());
    await wait(1000);
    expect(update).not.toHaveBeenCalled();
  });

  it("puts the server's answer in the panel's cache, and refreshes upstream's lists and the history", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Rewritten");
    plannerTestBlur(box());
    await wait(0);

    const cached = queryClient.getQueryData<PlannerTaskDetailResponse>(
      plannerQueryKeys.detail(TASK_ID),
    );
    expect(cached?.task.notes).toBe("Rewritten");
    expect(cached?.task.updated_at).toBe("2026-10-07T09:00:00.000Z");
    expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
      ["tasks"],
      plannerQueryKeys.history(TASK_ID),
    ]);
  });

  it("saves what is left when the panel goes away mid-sentence", async () => {
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Half a sentence");
    expect(update).not.toHaveBeenCalled();
    mounted?.unmount();
    mounted = undefined;
    await wait(0);
    expect(update).toHaveBeenCalledWith(TASK_ID, {
      today: TODAY,
      notes: "Half a sentence",
    });
  });

  it("follows the server's notes while nothing is unsaved", async () => {
    const { box, rerender } = show();
    rerender("Changed by an agent");
    await wait(0);
    expect(box().value).toBe("Changed by an agent");
  });

  it("does not replace what is being typed with the server's notes", async () => {
    const { box, rerender } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "My own words");
    rerender("Changed by an agent");
    await wait(0);
    expect(box().value).toBe("My own words");
  });
});

describe("a save that fails", () => {
  it("keeps the words, says Couldn't save, and toasts why", async () => {
    update.mockRejectedValue(new ApiError("Notes are too long.", 400));
    const { box, status, retry } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "These words must not vanish");
    plannerTestBlur(box());
    await wait(0);

    expect(box().value).toBe("These words must not vanish");
    expect(status()).toContain("Couldn't save");
    expect(retry()).toBeDefined();
    expect(toast.error).toHaveBeenCalledWith("Notes are too long.", {
      id: "planner-edit",
    });
  });

  it("uses its own wording when the failure has no message", async () => {
    update.mockRejectedValue(new TypeError(""));
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Words");
    plannerTestBlur(box());
    await wait(0);
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the notes", {
      id: "planner-edit",
    });
  });

  it("explains a throttled save in its own words", async () => {
    update.mockRejectedValue(new ApiError("Too many requests.", 429));
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Words");
    plannerTestBlur(box());
    await wait(0);
    expect(toast.error).toHaveBeenCalledWith(
      "Too many changes at once. Your edit was undone; try again in a moment.",
      { id: "planner-edit" },
    );
  });

  it("tries again with Retry, and says Saved when that works", async () => {
    update.mockRejectedValueOnce(new ApiError("Server error", 500));
    const { box, status, retry } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Second try");
    plannerTestBlur(box());
    await wait(0);
    expect(status()).toContain("Couldn't save");

    plannerTestClick(retry());
    await wait(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(TASK_ID, {
      today: TODAY,
      notes: "Second try",
    });
    expect(status()).toBe("Saved");
    expect(retry()).toBeUndefined();
  });

  it("leaves the panel's cache alone", async () => {
    update.mockRejectedValue(new ApiError("Server error", 500));
    const { box } = show();
    plannerTestFocus(box());
    plannerTestType(box(), "Lost in transit");
    plannerTestBlur(box());
    await wait(0);
    expect(
      queryClient.getQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(TASK_ID),
      )?.task.notes,
    ).toBe("Draft in the doc");
  });
});
