// @vitest-environment jsdom
import type {
  PlannerCommentDto,
  PlannerTaskDetailResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  plannerAddCommentRequest,
  plannerDeleteCommentRequest,
  plannerUpdateCommentRequest,
} from "./api";
import { plannerQueryKeys } from "./query-keys";
import { PlannerTaskComments } from "./task-panel-comments";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestFocus,
  plannerTestKey,
  plannerTestMount,
  plannerTestType,
} from "./test-render";

// The task panel's comments (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): adding, editing and
// deleting, each shown at once and put back, with a toast, when the server
// refuses. The network and the toasts are replaced; the list lives in the real
// query cache, as it does in the panel.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerAddCommentRequest: vi.fn(),
  plannerUpdateCommentRequest: vi.fn(),
  plannerDeleteCommentRequest: vi.fn(),
}));

const add = vi.mocked(plannerAddCommentRequest);
const edit = vi.mocked(plannerUpdateCommentRequest);
const remove = vi.mocked(plannerDeleteCommentRequest);

const TASK_ID = "tasks/t1";

const TASK: TaskDto = {
  id: TASK_ID,
  project_id: null,
  source_memo_id: null,
  title: "Write the launch announcement",
  notes: null,
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function comment(
  id: string,
  body: string,
  createdMinutesAgo: number,
  overrides: Partial<PlannerCommentDto> = {},
): PlannerCommentDto {
  // One reading of the clock: two would differ by a millisecond now and then,
  // and a comment whose updated_at is later than its created_at counts as edited.
  const at = minutesAgo(createdMinutesAgo);
  return {
    id,
    task_id: TASK_ID,
    body,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

/** Oldest first, as the server sends them. */
const FIRST = comment("c-1", "Check the copy with Dana", 180);
const SECOND = comment("c-2", "Design is signed off", 30);
// Two and a half minutes, so a slow run still reads "2 minutes ago".
const THIRD = comment("c-3", "Waiting on the legal review", 2.5);

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;

/** Lets promises that are already settled, and the code waiting on them, run. */
async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A request the test settles by hand, so the state in between can be looked at. */
function pendingRequest<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
  for (const leftover of Array.from(document.body.children)) leftover.remove();
});

/** The comments as the panel holds them: in the cached detail, read by the page. */
function Section() {
  const { data } = useQuery({
    queryKey: plannerQueryKeys.detail(TASK_ID),
    queryFn: (): Promise<PlannerTaskDetailResponse> =>
      Promise.reject(new Error("The test seeds this.")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data ? (
    <PlannerTaskComments comments={data.comments} taskId={TASK_ID} />
  ) : null;
}

async function show(comments: PlannerCommentDto[] = []) {
  const detail: PlannerTaskDetailResponse = {
    task: TASK,
    plan: null,
    project: null,
    comments,
  };
  queryClient.setQueryData(plannerQueryKeys.detail(TASK_ID), detail);
  mounted = plannerTestMount(<Section />, { queryClient });
  await settle();
  const root = mounted.container;
  return {
    root,
    composer: () =>
      root.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Write a comment"]',
      ) as HTMLTextAreaElement,
    send: () =>
      root.querySelector<HTMLButtonElement>(
        'button[aria-label="Send"]',
      ) as HTMLButtonElement,
    items: () =>
      Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="planner-comment"]'),
      ),
    bodies: () =>
      Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="planner-comment"]'),
      ).map((item) => item.querySelector("p")?.textContent),
    /** What the cache holds, which is what the page is drawn from. */
    cached: () =>
      queryClient
        .getQueryData<PlannerTaskDetailResponse>(
          plannerQueryKeys.detail(TASK_ID),
        )
        ?.comments.map((entry) => entry.body),
  };
}

const buttonIn = (scope: ParentNode, label: string) =>
  scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

// ---------------------------------------------------------------------------

describe("the comments list", () => {
  it("invites the first comment when there are none", async () => {
    const { root, items, composer, send } = await show();
    expect(root.querySelector("h3")?.textContent).toBe("Comments");
    expect(root.textContent).toContain("No comments yet.");
    expect(items()).toHaveLength(0);
    expect(composer().placeholder).toBe("Add a comment…");
    // Nothing to send yet.
    expect(send().disabled).toBe(true);
  });

  it("lists them oldest first, with a count", async () => {
    const { root, bodies } = await show([FIRST, SECOND, THIRD]);
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Design is signed off",
      "Waiting on the legal review",
    ]);
    expect(root.querySelector("h3")?.textContent).toBe("Comments3");
    expect(root.textContent).not.toContain("No comments yet.");
  });

  it("shows who said it and how long ago, with the exact time for hover and screen readers", async () => {
    const { items } = await show([FIRST, THIRD]);
    const [first, third] = items();
    expect(first.textContent).toContain("You");
    expect(first.textContent).toContain("3 hours ago");
    expect(third.textContent).toContain("2 minutes ago");

    const time = first.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(FIRST.created_at);
    // The exact moment follows the relative one for a screen reader.
    expect(time?.querySelector(".sr-only")?.textContent).toMatch(
      /^ \(.*\d{4}.*\)$/,
    );
  });

  it("marks a comment that has been edited", async () => {
    const { items } = await show([
      FIRST,
      comment("c-2", "Design is signed off", 30, {
        updated_at: minutesAgo(10),
      }),
    ]);
    const [first, second] = items();
    expect(first.textContent).not.toContain("edited");
    expect(second.textContent).toContain("edited");
  });

  it("keeps line breaks in a comment", async () => {
    const { items } = await show([
      comment("c-1", "First line\nSecond line", 5),
    ]);
    const body = items()[0].querySelector("p") as HTMLElement;
    expect(body.textContent).toBe("First line\nSecond line");
    expect(body.className).toContain("whitespace-pre-wrap");
  });
});

// ---------------------------------------------------------------------------

describe("adding a comment", () => {
  it("sends on Enter, at once empties the box and keeps it focused", async () => {
    const request = pendingRequest<{ comment: PlannerCommentDto }>();
    add.mockReturnValue(request.promise);
    const { composer, items, bodies, cached } = await show([FIRST]);

    plannerTestFocus(composer());
    plannerTestType(composer(), "  Shipping it Friday  ");
    const kept = plannerTestKey(composer(), "Enter");
    await settle();

    // Enter sent it: no line break was typed.
    expect(kept).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(TASK_ID, "Shipping it Friday");
    expect(composer().value).toBe("");
    expect(document.activeElement).toBe(composer());

    // On the list before the server has answered, dimmed, with no actions.
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Shipping it Friday",
    ]);
    const waiting = items()[1];
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    expect(waiting.className).toContain("opacity-60");
    expect(buttonIn(waiting, "Edit comment")).toBeNull();
    expect(buttonIn(waiting, "Delete comment")).toBeNull();
    expect(cached()).toEqual([
      "Check the copy with Dana",
      "Shipping it Friday",
    ]);

    request.resolve({
      comment: comment("c-9", "Shipping it Friday", 0),
    });
    await settle();
    // The server's own copy has replaced it: same place, no longer dimmed.
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Shipping it Friday",
    ]);
    expect(items()[1].getAttribute("aria-busy")).toBeNull();
    expect(items()[1].className).not.toContain("opacity-60");
    expect(buttonIn(items()[1], "Edit comment")).not.toBeNull();
  });

  it("sends with the Send button too", async () => {
    add.mockResolvedValue({ comment: comment("c-9", "Via the button", 0) });
    const { composer, send, bodies } = await show();
    plannerTestType(composer(), "Via the button");
    expect(send().disabled).toBe(false);
    plannerTestClick(send());
    await settle();
    expect(add).toHaveBeenCalledWith(TASK_ID, "Via the button");
    expect(bodies()).toEqual(["Via the button"]);
  });

  it("adds a line on Shift+Enter and sends nothing", async () => {
    const { composer } = await show();
    plannerTestType(composer(), "Line one");
    const kept = plannerTestKey(composer(), "Enter", { shiftKey: true });
    await settle();
    // The page left the key alone, so the browser types the line break.
    expect(kept).toBe(true);
    expect(add).not.toHaveBeenCalled();
    expect(composer().value).toBe("Line one");
  });

  it("does not send the Enter that confirms an input-method candidate", async () => {
    const { composer } = await show();
    plannerTestType(composer(), "你好");
    expect(plannerTestKey(composer(), "Enter", { isComposing: true })).toBe(
      true,
    );
    expect(plannerTestKey(composer(), "Enter", { keyCode: 229 })).toBe(true);
    await settle();
    expect(add).not.toHaveBeenCalled();
    expect(composer().value).toBe("你好");
  });

  it("sends nothing for an empty box", async () => {
    const { composer, send } = await show();
    plannerTestKey(composer(), "Enter");
    plannerTestType(composer(), "   \n  ");
    expect(send().disabled).toBe(true);
    plannerTestKey(composer(), "Enter");
    plannerTestClick(send());
    await settle();
    expect(add).not.toHaveBeenCalled();
  });

  it("takes the comment away, hands the words back and says why when the server refuses", async () => {
    add.mockRejectedValue(new ApiError("Comments are off.", 400));
    const { composer, bodies, cached } = await show([FIRST]);
    plannerTestType(composer(), "Do not lose me");
    plannerTestKey(composer(), "Enter");
    await settle();

    expect(bodies()).toEqual(["Check the copy with Dana"]);
    expect(cached()).toEqual(["Check the copy with Dana"]);
    // What was typed is back in the box, ready to send again.
    expect(composer().value).toBe("Do not lose me");
    expect(toast.error).toHaveBeenCalledWith("Comments are off.", {
      id: "planner-edit",
    });
  });

  it("does not overwrite something new that was typed while the failed comment was going", async () => {
    const request = pendingRequest<{ comment: PlannerCommentDto }>();
    add.mockReturnValue(request.promise);
    const { composer } = await show();
    plannerTestType(composer(), "The first one");
    plannerTestKey(composer(), "Enter");
    plannerTestType(composer(), "Already writing the next");
    request.reject(new ApiError("Nope", 500));
    await settle();
    expect(composer().value).toBe("Already writing the next");
  });

  it("falls back to its own wording, and explains a throttled add", async () => {
    add.mockRejectedValueOnce(new TypeError(""));
    const { composer } = await show();
    plannerTestType(composer(), "One");
    plannerTestKey(composer(), "Enter");
    await settle();
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't add the comment", {
      id: "planner-edit",
    });

    add.mockRejectedValueOnce(new ApiError("Too many requests.", 429));
    plannerTestKey(composer(), "Enter");
    await settle();
    expect(toast.error).toHaveBeenLastCalledWith(
      "Too many changes at once. Your edit was undone; try again in a moment.",
      { id: "planner-edit" },
    );
  });

  it("refreshes the task's history once the comment is saved", async () => {
    add.mockResolvedValue({ comment: comment("c-9", "Noted", 0) });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { composer } = await show();
    plannerTestType(composer(), "Noted");
    plannerTestKey(composer(), "Enter");
    await settle();
    expect(
      invalidate.mock.calls.map((call) => call[0]?.queryKey),
    ).toContainEqual(plannerQueryKeys.history(TASK_ID));
  });
});

// ---------------------------------------------------------------------------

describe("editing a comment", () => {
  const editorIn = (root: HTMLElement) =>
    root.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit comment"]',
    );

  it("turns the comment into a box with its text, to type over", async () => {
    const { root, items } = await show([FIRST, SECOND]);
    plannerTestClick(buttonIn(items()[1], "Edit comment"));
    await settle();
    const editor = editorIn(root);
    expect(editor?.value).toBe("Design is signed off");
    // The other comment is untouched.
    expect(items()[0].querySelector("p")?.textContent).toBe(
      "Check the copy with Dana",
    );
    // While editing there are no edit and delete buttons beside it.
    expect(buttonIn(items()[1], "Edit comment")).toBeNull();
  });

  it("saves on Enter: the new text at once, the server's copy when it answers", async () => {
    const request = pendingRequest<{ comment: PlannerCommentDto }>();
    edit.mockReturnValue(request.promise);
    const { root, items, bodies } = await show([FIRST, SECOND]);
    plannerTestClick(buttonIn(items()[1], "Edit comment"));
    await settle();
    plannerTestType(
      editorIn(root) as HTMLTextAreaElement,
      "Design is approved",
    );
    expect(plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter")).toBe(
      false,
    );
    await settle();

    expect(edit).toHaveBeenCalledWith("c-2", "Design is approved");
    expect(editorIn(root)).toBeNull();
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Design is approved",
    ]);

    request.resolve({
      comment: {
        ...SECOND,
        body: "Design is approved",
        updated_at: minutesAgo(0),
      },
    });
    await settle();
    expect(bodies()[1]).toBe("Design is approved");
    expect(items()[1].textContent).toContain("edited");
  });

  it("saves with the Save button", async () => {
    edit.mockResolvedValue({
      comment: { ...SECOND, body: "Changed", updated_at: minutesAgo(0) },
    });
    const { root, items } = await show([SECOND]);
    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    plannerTestType(editorIn(root) as HTMLTextAreaElement, "Changed");
    const save = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    plannerTestClick(save);
    await settle();
    expect(edit).toHaveBeenCalledWith("c-2", "Changed");
  });

  it("adds a line on Shift+Enter and saves nothing", async () => {
    const { root, items } = await show([SECOND]);
    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    expect(
      plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter", {
        shiftKey: true,
      }),
    ).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    expect(editorIn(root)).not.toBeNull();
  });

  it("goes back to the comment on Escape or Cancel, saving nothing", async () => {
    const { root, items, bodies } = await show([SECOND]);
    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    plannerTestType(editorIn(root) as HTMLTextAreaElement, "Never mind");
    plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Escape");
    await settle();
    expect(editorIn(root)).toBeNull();
    expect(bodies()).toEqual(["Design is signed off"]);

    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    // The box starts from the saved text again, not the abandoned edit.
    expect(editorIn(root)?.value).toBe("Design is signed off");
    plannerTestType(editorIn(root) as HTMLTextAreaElement, "Never mind");
    const cancel = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    );
    plannerTestClick(cancel);
    await settle();
    expect(editorIn(root)).toBeNull();
    expect(bodies()).toEqual(["Design is signed off"]);
    expect(edit).not.toHaveBeenCalled();
  });

  it("does not save an empty comment, and does not save one that did not change", async () => {
    const { root, items } = await show([SECOND]);
    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    const save = () =>
      Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent === "Save",
      ) as HTMLButtonElement;

    plannerTestType(editorIn(root) as HTMLTextAreaElement, "   ");
    expect(save().disabled).toBe(true);
    plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter");
    await settle();
    expect(edit).not.toHaveBeenCalled();
    // Still editing: nothing was lost.
    expect(editorIn(root)).not.toBeNull();

    plannerTestType(
      editorIn(root) as HTMLTextAreaElement,
      "Design is signed off ",
    );
    plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter");
    await settle();
    expect(edit).not.toHaveBeenCalled();
    expect(editorIn(root)).toBeNull();
  });

  it("puts the old text back and says why when the server refuses", async () => {
    edit.mockRejectedValue(new ApiError("Can't edit that.", 400));
    const { root, items, bodies, cached } = await show([FIRST, SECOND]);
    plannerTestClick(buttonIn(items()[1], "Edit comment"));
    await settle();
    plannerTestType(editorIn(root) as HTMLTextAreaElement, "Rewritten");
    plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter");
    await settle();

    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Design is signed off",
    ]);
    expect(cached()).toEqual([
      "Check the copy with Dana",
      "Design is signed off",
    ]);
    expect(items()[1].textContent).not.toContain("edited");
    expect(toast.error).toHaveBeenCalledWith("Can't edit that.", {
      id: "planner-edit",
    });
  });

  it("falls back to its own wording for a failure with no message", async () => {
    edit.mockRejectedValue(new TypeError(""));
    const { root, items } = await show([SECOND]);
    plannerTestClick(buttonIn(items()[0], "Edit comment"));
    await settle();
    plannerTestType(editorIn(root) as HTMLTextAreaElement, "Rewritten");
    plannerTestKey(editorIn(root) as HTMLTextAreaElement, "Enter");
    await settle();
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the comment", {
      id: "planner-edit",
    });
  });
});

// ---------------------------------------------------------------------------

describe("deleting a comment", () => {
  const dialog = () =>
    document.body.querySelector<HTMLElement>(
      '[data-slot="alert-dialog-content"]',
    );
  const dialogButton = (name: string) =>
    Array.from(dialog()?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === name,
    );

  it("asks first, and keeps the comment if the answer is Cancel", async () => {
    const { items, bodies } = await show([FIRST, SECOND]);
    plannerTestClick(buttonIn(items()[0], "Delete comment"));
    await settle();
    expect(dialog()?.textContent).toContain("Delete this comment?");
    expect(dialog()?.textContent).toContain(
      "It is removed from this task. This can't be undone.",
    );
    expect(remove).not.toHaveBeenCalled();

    plannerTestClick(dialogButton("Cancel"));
    await settle();
    expect(dialog()).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Design is signed off",
    ]);
  });

  it("removes it at once when confirmed, and asks the server", async () => {
    const request = pendingRequest<{ ok: true }>();
    remove.mockReturnValue(request.promise);
    const { items, bodies, cached } = await show([FIRST, SECOND, THIRD]);
    plannerTestClick(buttonIn(items()[1], "Delete comment"));
    await settle();
    plannerTestClick(dialogButton("Delete"));
    await settle();

    expect(remove).toHaveBeenCalledWith("c-2");
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Waiting on the legal review",
    ]);
    expect(cached()).toEqual([
      "Check the copy with Dana",
      "Waiting on the legal review",
    ]);

    request.resolve({ ok: true });
    await settle();
    expect(bodies()).toHaveLength(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("puts it back in its own place and says why when the server refuses", async () => {
    remove.mockRejectedValue(new ApiError("Can't delete that.", 400));
    const { items, bodies } = await show([FIRST, SECOND, THIRD]);
    plannerTestClick(buttonIn(items()[1], "Delete comment"));
    await settle();
    plannerTestClick(dialogButton("Delete"));
    await settle();

    // In the middle where it was, not at the end: the list is oldest first.
    expect(bodies()).toEqual([
      "Check the copy with Dana",
      "Design is signed off",
      "Waiting on the legal review",
    ]);
    expect(toast.error).toHaveBeenCalledWith("Can't delete that.", {
      id: "planner-edit",
    });
  });

  it("goes back to the empty state after the last comment is deleted", async () => {
    remove.mockResolvedValue({ ok: true });
    const { root, items } = await show([FIRST]);
    plannerTestClick(buttonIn(items()[0], "Delete comment"));
    await settle();
    plannerTestClick(dialogButton("Delete"));
    await settle();
    expect(items()).toHaveLength(0);
    expect(root.textContent).toContain("No comments yet.");
    expect(root.querySelector("h3")?.textContent).toBe("Comments");
  });
});
