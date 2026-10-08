// @vitest-environment jsdom
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
} from "@flaremo/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannerBoard } from "./board";
import { plannerPendingCard, plannerPendingCardId } from "./board-model";
import {
  type PlannerTestMount,
  plannerTestActions,
  plannerTestBlur,
  plannerTestClick,
  plannerTestKey,
  plannerTestMount,
  plannerTestType,
} from "./test-render";
import type { PlannerActions } from "./use-planner-actions";

// What a person can do to the board with a pointer and a keyboard (fork-owned
// add-on, docs/planning-cockpit-implementation-plan.md, section 13): open a card
// by clicking it without a drag doing the same, and add a task from the "+" in a
// column's header. The reveal and the filter chips are in board.test.tsx.

// Wednesday 7 October 2026.
const TODAY = "2026-10-07";

function card(
  id: string,
  title: string,
  overrides: Partial<PlannerBoardCard> = {},
): PlannerBoardCard {
  return {
    id,
    project_id: null,
    project_name: null,
    title,
    status: "todo",
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    horizon: null,
    period_start: null,
    carry_count: 0,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    ...overrides,
  };
}

function board(
  columns: Partial<PlannerBoardResponse["columns"]> = {},
): PlannerBoardResponse {
  return {
    columns: {
      backlog: [card("tasks/backlog", "Sketch the newsletter")],
      todo: [
        card("tasks/today", "Reply to design feedback", {
          horizon: "day",
          period_start: TODAY,
        }),
      ],
      doing: [
        card("tasks/doing", "Migrate comments", { status: "in_progress" }),
      ],
      done: [card("tasks/done", "Order a keyboard", { status: "done" })],
      other: [],
      ...columns,
    },
    today: TODAY,
    periods: { day: TODAY, week: "2026-10-05", month: "2026-10-01" },
    history: "ok",
    truncated: false,
  };
}

let mounted: PlannerTestMount | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/** The board with its actions and open handler in hand, to check what reached them. */
function show(
  data: PlannerBoardResponse,
  options: {
    actions?: ReturnType<typeof plannerTestActions>;
    onOpen?: (card: PlannerBoardCard) => void;
  } = {},
) {
  const actions = options.actions ?? plannerTestActions();
  const onOpen = options.onOpen ?? vi.fn();
  mounted = plannerTestMount(
    <PlannerBoard
      actions={actions as PlannerActions}
      board={data}
      entering={false}
      reveal={null}
      today={TODAY}
      onOpen={onOpen}
      onRequest={vi.fn()}
    />,
  );
  return { container: mounted.container, actions, onOpen };
}

const columnOf = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`[data-column="${name}"]`) as HTMLElement;

const cardElement = (root: HTMLElement, title: string) =>
  Array.from(
    root.querySelectorAll<HTMLElement>('[data-testid="planner-card"]'),
  ).find((entry) => entry.textContent?.includes(title)) as HTMLElement;

const titleButtonOf = (root: HTMLElement, title: string) =>
  Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'),
  ).find((button) => button.textContent === title) as HTMLButtonElement;

// ---------------------------------------------------------------------------

describe("clicking a card and dragging it", () => {
  // The board's mouse sensor lifts a card only after the pointer has moved 6px, and
  // dnd-kit swallows the click that ends a drag. These tests use the real library,
  // so a change in either shows up here instead of as a panel that pops open
  // mid-drag.

  const mouse = (
    target: Element | Document,
    type: "mousedown" | "mousemove" | "mouseup" | "click",
    x: number,
  ) =>
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
          clientY: 100,
        }),
      );
    });

  /** A press, a move of `distance` pixels, a release and the click that follows. */
  function gesture(target: Element, distance: number) {
    mouse(target, "mousedown", 100);
    if (distance > 0) {
      // In two steps, as a hand moves; the sensor reads each one.
      mouse(document, "mousemove", 100 + Math.ceil(distance / 2));
      mouse(document, "mousemove", 100 + distance);
    }
    mouse(document, "mouseup", 100 + distance);
    // The browser sends the click right after the release.
    mouse(target, "click", 100 + distance);
  }

  it("opens a card for a click: a press and release in place", () => {
    const { container, onOpen } = show(board());
    gesture(titleButtonOf(container, "Migrate comments"), 0);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tasks/doing" }),
    );
  });

  it("opens a card for a click anywhere on it, not only on its title", () => {
    const { container, onOpen } = show(board());
    const body = cardElement(container, "Migrate comments").querySelector(
      '[data-slot="card"]',
    ) as Element;
    gesture(body, 0);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("still opens it when the hand slips a few pixels before it lets go", () => {
    const { container, onOpen } = show(board());
    // The sensor needs 6px to start a drag: 4 is a click with a shaky hand.
    gesture(titleButtonOf(container, "Migrate comments"), 4);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not open a card that was dragged, and does not count it as a click", async () => {
    const { container, onOpen, actions } = show(board());
    const title = titleButtonOf(container, "Migrate comments");
    const shown = () => container.querySelectorAll('[data-slot="card"]').length;
    const before = shown();

    // Prove the drag really starts, so the test cannot pass for lack of one: past
    // 6px dnd-kit lifts the card, which draws a second copy under the pointer.
    mouse(title, "mousedown", 100);
    mouse(document, "mousemove", 103);
    expect(shown()).toBe(before);
    mouse(document, "mousemove", 140);
    expect(shown()).toBe(before + 1);

    mouse(document, "mouseup", 140);
    mouse(title, "click", 140);
    expect(onOpen).not.toHaveBeenCalled();
    // The overlay copy leaves once the drag's own bookkeeping has settled.
    await act(async () => {});
    expect(shown()).toBe(before);
    // The drop landed on no column (jsdom has no layout), so nothing moved.
    expect(actions.move).not.toHaveBeenCalled();
  });

  it("would open the card if the click that ends a drag were not swallowed", async () => {
    // The mirror of the test above: a click that arrives after dnd-kit has stopped
    // swallowing them is an ordinary click. Without this, a swallow that never
    // lifts would hide a card that cannot be opened at all.
    const { container, onOpen } = show(board());
    const title = titleButtonOf(container, "Migrate comments");
    mouse(title, "mousedown", 100);
    mouse(document, "mousemove", 140);
    mouse(document, "mouseup", 140);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    mouse(title, "click", 140);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the next card normally once the drag is over", async () => {
    const { container, onOpen } = show(board());
    gesture(titleButtonOf(container, "Migrate comments"), 40);
    expect(onOpen).not.toHaveBeenCalled();
    // dnd-kit stops swallowing clicks a moment after the drag; then it is a click again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    gesture(titleButtonOf(container, "Order a keyboard"), 0);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tasks/done" }),
    );
  });

  it("opens only the card that was clicked", () => {
    const { container, onOpen } = show(board());
    gesture(titleButtonOf(container, "Sketch the newsletter"), 0);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tasks/backlog" }),
    );
  });

  it("lets the status icon advance a card without opening it", () => {
    const { container, onOpen, actions } = show(board());
    const advance = cardElement(
      container,
      "Migrate comments",
    ).querySelector<HTMLButtonElement>('button[aria-label="Complete"]');
    expect(advance).not.toBeNull();
    gesture(advance as Element, 0);
    expect(actions.move).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tasks/doing" }),
      "done",
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cannot open or drag a card the server has not answered for", () => {
    const waiting = plannerPendingCard({
      id: plannerPendingCardId(1),
      title: "Just added",
      column: "doing",
      plan: null,
      now: new Date("2026-10-07T09:00:00.000Z"),
    });
    const { container, onOpen } = show(board({ doing: [waiting] }));
    const body = cardElement(container, "Just added").querySelector(
      '[data-slot="card"]',
    ) as Element;
    expect(body.getAttribute("aria-busy")).toBe("true");
    gesture(body, 0);
    gesture(body, 40);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("lifting a card with the keyboard", () => {
  // A card is a focusable group. Space or Enter pressed ON the card lifts it (the
  // keyboard sensor with sortable coordinates then moves it with the arrows);
  // the same keys pressed on the buttons inside it keep their own meaning.
  const key = (target: Element | Document, code: string) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { code, key: code, bubbles: true }),
      );
    });

  it("makes every card a labelled, focusable group, and leaves a waiting card out of the tab order", () => {
    const waiting = plannerPendingCard({
      id: plannerPendingCardId(1),
      title: "Just added",
      column: "doing",
      plan: null,
      now: new Date("2026-10-07T09:00:00.000Z"),
    });
    const { container } = show(board({ doing: [waiting] }));
    const migrate = cardElement(container, "Reply to design feedback");
    expect(migrate.getAttribute("role")).toBe("group");
    expect(migrate.getAttribute("aria-label")).toBe("Reply to design feedback");
    expect(migrate.tabIndex).toBe(0);
    expect(migrate.getAttribute("aria-roledescription")).toBe("sortable");
    const justAdded = cardElement(container, "Just added");
    expect(justAdded.getAttribute("tabindex")).toBeNull();
    expect(justAdded.getAttribute("aria-roledescription")).toBeNull();
  });

  it("lifts a card on Space and puts it down again on Escape, saying so", async () => {
    const { container } = show(board());
    const migrate = cardElement(container, "Migrate comments");
    key(migrate, "Space");
    expect(document.body.textContent).toContain("Picked up Migrate comments.");
    // The sensor starts listening for the next key one tick after it lifts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    key(document, "Escape");
    expect(document.body.textContent).toContain(
      "Moving Migrate comments was cancelled.",
    );
  });

  it("does not lift a card for a key pressed on the buttons inside it", () => {
    const { container, onOpen } = show(board());
    key(titleButtonOf(container, "Migrate comments"), "Enter");
    key(titleButtonOf(container, "Migrate comments"), "Space");
    expect(document.body.textContent).not.toContain("Picked up");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("the + in a column's header", () => {
  const addButton = (root: HTMLElement, column: string) =>
    root.querySelector<HTMLButtonElement>(
      `[data-column="${column}"] header button`,
    );
  const inputIn = (root: HTMLElement, label: string) =>
    root.querySelector<HTMLInputElement>(
      `input[aria-label="New task in ${label}"]`,
    ) as HTMLInputElement;

  it("is on Backlog, To Do, Doing and Done, named for its column", () => {
    const { container } = show(board());
    for (const [column, label] of [
      ["backlog", "Backlog"],
      ["todo", "To Do"],
      ["doing", "Doing"],
      ["done", "Done"],
    ] as const) {
      expect(
        addButton(container, column)?.getAttribute("aria-label"),
        column,
      ).toBe(`Add to ${label}`);
    }
  });

  it("is not on the Other column, which is no place to add a task to", () => {
    const odd = card("tasks/odd", "A task with an odd status", {
      status: "someday",
    });
    const { container } = show(board({ other: [odd] }));
    expect(columnOf(container, "other")).not.toBeNull();
    expect(addButton(container, "other")).toBeNull();
  });

  it("opens a composer at the top of its column, focused, and says what to do", () => {
    const { container } = show(board());
    const doing = columnOf(container, "doing");
    expect(doing.querySelector('[data-testid="planner-composer"]')).toBeNull();

    plannerTestClick(addButton(container, "doing"));

    const composer = doing.querySelector('[data-testid="planner-composer"]');
    expect(composer).not.toBeNull();
    expect(document.activeElement).toBe(inputIn(container, "Doing"));
    expect(composer?.textContent).toContain("Enter to add, Esc to cancel");
    // At the top: before the column's first card.
    const list = composer?.parentElement;
    expect(list?.firstElementChild).toBe(composer);
    expect(addButton(container, "doing")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("adds into its column on Enter, keeps the composer open and empties the field", async () => {
    const actions = plannerTestActions();
    actions.createIn.mockResolvedValue(true);
    const { container } = show(board(), { actions });
    plannerTestClick(addButton(container, "doing"));
    const input = inputIn(container, "Doing");

    plannerTestType(input, "  Draft the changelog ");
    const untouched = plannerTestKey(input, "Enter");
    await act(async () => {});

    expect(untouched).toBe(false); // Enter was ours: no form, no newline
    expect(actions.createIn).toHaveBeenCalledTimes(1);
    expect(actions.createIn).toHaveBeenCalledWith({
      title: "Draft the changelog",
      column: "doing",
      plan: null,
    });
    expect(input.value).toBe("");
    expect(inputIn(container, "Doing")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("lets a run of tasks be typed without leaving the field", async () => {
    const actions = plannerTestActions();
    actions.createIn.mockResolvedValue(true);
    const { container } = show(board(), { actions });
    plannerTestClick(addButton(container, "backlog"));
    const input = inputIn(container, "Backlog");
    for (const title of ["one", "two", "three"]) {
      plannerTestType(input, title);
      plannerTestKey(input, "Enter");
    }
    await act(async () => {});
    expect(actions.createIn.mock.calls.map((call) => call[0].title)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("adds nothing for blank text or an Enter that confirms an IME candidate", async () => {
    const actions = plannerTestActions();
    actions.createIn.mockResolvedValue(true);
    const { container } = show(board(), { actions });
    plannerTestClick(addButton(container, "todo"));
    const input = inputIn(container, "To Do");

    plannerTestKey(input, "Enter");
    plannerTestType(input, "   ");
    plannerTestKey(input, "Enter");
    plannerTestType(input, "composing");
    plannerTestKey(input, "Enter", { isComposing: true });
    plannerTestKey(input, "Enter", { keyCode: 229 });
    await act(async () => {});

    expect(actions.createIn).not.toHaveBeenCalled();
    expect(input.value).toBe("composing");
  });

  it("puts the text back when the add fails, unless something new was typed meanwhile", async () => {
    const actions = plannerTestActions();
    const settle: Array<(created: boolean) => void> = [];
    actions.createIn.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle.push(resolve);
        }),
    );
    const { container } = show(board(), { actions });
    plannerTestClick(addButton(container, "doing"));
    const input = inputIn(container, "Doing");

    plannerTestType(input, "will fail");
    plannerTestKey(input, "Enter");
    expect(input.value).toBe("");
    await act(async () => settle[0]?.(false));
    expect(input.value).toBe("will fail");

    // A second failure after a new title was started: the new one is kept.
    plannerTestKey(input, "Enter");
    expect(input.value).toBe("");
    plannerTestType(input, "something new");
    await act(async () => settle[1]?.(false));
    expect(input.value).toBe("something new");
  });

  it("does not bring text back for an add that worked", async () => {
    const actions = plannerTestActions();
    actions.createIn.mockResolvedValue(true);
    const { container } = show(board(), { actions });
    plannerTestClick(addButton(container, "doing"));
    const input = inputIn(container, "Doing");
    plannerTestType(input, "worked");
    plannerTestKey(input, "Enter");
    await act(async () => {});
    expect(input.value).toBe("");
  });

  it("closes on Escape, and when focus leaves an empty field", () => {
    const { container } = show(board());
    const composerIn = () =>
      container.querySelector('[data-testid="planner-composer"]');

    plannerTestClick(addButton(container, "doing"));
    plannerTestKey(inputIn(container, "Doing"), "Escape");
    expect(composerIn()).toBeNull();

    plannerTestClick(addButton(container, "doing"));
    plannerTestBlur(inputIn(container, "Doing"));
    expect(composerIn()).toBeNull();
  });

  it("stays open when focus leaves a field with text in it, so a stray click loses nothing", () => {
    const { container } = show(board());
    plannerTestClick(addButton(container, "doing"));
    const input = inputIn(container, "Doing");
    plannerTestType(input, "half a thought");
    plannerTestBlur(input);
    expect(
      container.querySelector('[data-testid="planner-composer"]'),
    ).not.toBeNull();
    expect(input.value).toBe("half a thought");
  });

  it("takes the place of an empty column's hint while it is open", () => {
    const { container } = show(board({ doing: [] }));
    const doing = columnOf(container, "doing");
    const hint = "Drag a card here when you start it.";
    expect(doing.textContent).toContain(hint);
    plannerTestClick(addButton(container, "doing"));
    expect(doing.textContent).not.toContain(hint);
    plannerTestKey(inputIn(container, "Doing"), "Escape");
    expect(doing.textContent).toContain(hint);
  });

  describe("what each column adds", () => {
    async function addIn(column: string, label: string) {
      const actions = plannerTestActions();
      actions.createIn.mockResolvedValue(true);
      const { container } = show(board(), { actions });
      plannerTestClick(addButton(container, column));
      const input = inputIn(container, label);
      plannerTestType(input, "A task");
      plannerTestKey(input, "Enter");
      await act(async () => {});
      mounted?.unmount();
      mounted = undefined;
      return actions.createIn.mock.calls[0]?.[0];
    }

    it("Backlog: no plan", async () => {
      expect(await addIn("backlog", "Backlog")).toEqual({
        title: "A task",
        column: "backlog",
        plan: null,
      });
    });

    it("To Do: the marker for today, which nothing shows", async () => {
      expect(await addIn("todo", "To Do")).toEqual({
        title: "A task",
        column: "todo",
        plan: { horizon: "day", day: TODAY },
      });
    });

    it("Doing and Done: no plan", async () => {
      for (const [column, label] of [
        ["doing", "Doing"],
        ["done", "Done"],
      ] as const) {
        expect((await addIn(column, label))?.plan, column).toBeNull();
      }
    });
  });
});
