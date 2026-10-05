// @vitest-environment jsdom
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
} from "@flaremo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerBoard } from "./board";
import { type PlannerTestMount, plannerTestMount } from "./test-render";
import type { PlannerHorizonFilter } from "./todo-filter";
import type { PlannerActions } from "./use-planner-actions";
import type { PlannerReveal } from "./use-planner-reveal";

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
    ...overrides,
  };
}

const day = (id: string, title: string, date: string) =>
  card(id, title, { horizon: "day", period_start: date });

function board(
  columns: Partial<PlannerBoardResponse["columns"]> = {},
): PlannerBoardResponse {
  return {
    columns: {
      backlog: [card("tasks/backlog", "Sketch the newsletter")],
      todo: [
        day("tasks/today", "Reply to design feedback", TODAY),
        day("tasks/tomorrow", "Prep the Friday review", "2026-10-08"),
        card("tasks/week", "Review open pull requests", {
          horizon: "week",
          period_start: "2026-10-05",
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

function actionsStub() {
  return {
    move: vi.fn(),
    plan: vi.fn(),
    setDue: vi.fn(),
    drop: vi.fn(),
    undrop: vi.fn(),
    create: vi.fn(),
  } satisfies PlannerActions;
}

let mounted: PlannerTestMount | undefined;
let scrolled: { element: HTMLElement; options: ScrollIntoViewOptions }[];

beforeEach(() => {
  scrolled = [];
  // jsdom has no layout and no scrollIntoView; record who asked to scroll.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options: ScrollIntoViewOptions) {
      scrolled.push({ element: this, options });
    },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function element(
  data: PlannerBoardResponse,
  options: {
    reveal?: PlannerReveal | null;
    filter?: PlannerHorizonFilter;
  } = {},
) {
  return (
    <PlannerBoard
      actions={actionsStub()}
      board={data}
      entering={false}
      filter={options.filter ?? "all"}
      reveal={options.reveal ?? null}
      today={TODAY}
      onRequest={vi.fn()}
    />
  );
}

function show(
  data: PlannerBoardResponse,
  options: Parameters<typeof element>[1] = {},
) {
  mounted = plannerTestMount(element(data, options));
  return mounted;
}

const cards = (root: HTMLElement) =>
  Array.from(
    root.querySelectorAll<HTMLElement>('[data-testid="planner-card"]'),
  );
const cardTitled = (root: HTMLElement, title: string) =>
  cards(root).find((entry) => entry.textContent?.includes(title));
const rings = (root: HTMLElement) =>
  Array.from(
    root.querySelectorAll<HTMLElement>('[data-testid="planner-reveal"]'),
  );

describe("the reveal on the board", () => {
  it("scrolls the card the person acted on into view and rings it", () => {
    const { container } = show(board(), {
      reveal: { id: "tasks/doing", stamp: 1 },
    });
    const doing = cardTitled(container, "Migrate comments");

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element).toBe(doing);
    expect(scrolled[0]?.options).toEqual({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
    expect(rings(container)).toHaveLength(1);
    expect(doing?.contains(rings(container)[0] ?? null)).toBe(true);
  });

  it("rings the card in Ember without catching clicks or being read out", () => {
    const { container } = show(board(), {
      reveal: { id: "tasks/doing", stamp: 1 },
    });
    const ring = rings(container)[0];
    expect(ring?.getAttribute("aria-hidden")).toBe("true");
    expect(ring?.className).toContain("pointer-events-none");
    expect(ring?.className).toContain("ring-brand-500");
  });

  it("leaves the board alone when nothing was acted on", () => {
    const { container } = show(board());
    expect(scrolled).toHaveLength(0);
    expect(rings(container)).toHaveLength(0);
  });

  it("does not point at a card that is not on the board", () => {
    const { container } = show(board(), {
      reveal: { id: "tasks/missing", stamp: 1 },
    });
    expect(scrolled).toHaveLength(0);
    expect(rings(container)).toHaveLength(0);
  });

  it("does not point at a card a filter chip hides", () => {
    // Today shows one card; the Tomorrow card is out of the filtered list.
    const { container } = show(board(), {
      filter: "day",
      reveal: { id: "tasks/tomorrow", stamp: 1 },
    });
    expect(cardTitled(container, "Prep the Friday review")).toBeUndefined();
    expect(scrolled).toHaveLength(0);
  });

  it("scrolls to a card that arrives in its new column after the request", () => {
    const reveal = { id: "tasks/new", stamp: 1 };
    const view = show(board(), { reveal });
    expect(scrolled).toHaveLength(0);

    // The optimistic edit lands: the card now exists, in Doing.
    const moved = card("tasks/new", "Just moved", { status: "in_progress" });
    view.rerender(
      element(
        board({ doing: [moved, card("tasks/doing", "Migrate comments")] }),
        {
          reveal,
        },
      ),
    );

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element).toBe(cardTitled(view.container, "Just moved"));
    expect(rings(view.container)).toHaveLength(1);
  });

  it("scrolls a card again, and restarts its ring, for a renewed request", () => {
    const view = show(board(), { reveal: { id: "tasks/doing", stamp: 1 } });
    const firstRing = rings(view.container)[0];

    view.rerender(
      element(board(), { reveal: { id: "tasks/doing", stamp: 2 } }),
    );

    expect(scrolled).toHaveLength(2);
    const secondRing = rings(view.container)[0];
    expect(rings(view.container)).toHaveLength(1);
    expect(secondRing).not.toBe(firstRing);
  });

  it("does not scroll again when the board only refreshes under the same request", () => {
    const reveal = { id: "tasks/doing", stamp: 1 };
    const view = show(board(), { reveal });
    view.rerender(element(board(), { reveal }));
    view.rerender(element(board(), { reveal }));
    expect(scrolled).toHaveLength(1);
  });

  it("takes the ring away when the request ends", () => {
    const view = show(board(), { reveal: { id: "tasks/doing", stamp: 1 } });
    view.rerender(element(board(), { reveal: null }));
    expect(rings(view.container)).toHaveLength(0);
    expect(scrolled).toHaveLength(1);
  });

  it("jumps instead of gliding for someone who prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
    }));
    show(board(), { reveal: { id: "tasks/doing", stamp: 1 } });
    expect(scrolled[0]?.options.behavior).toBe("auto");
  });
});

describe("the To Do column and the filter chips", () => {
  const titles = (root: HTMLElement) =>
    Array.from(
      root.querySelectorAll(
        '[data-column="todo"] [data-testid="planner-card"]',
      ),
    ).map((entry) => entry.textContent ?? "");

  it("shows every To Do card under All", () => {
    const { container } = show(board());
    expect(titles(container)).toHaveLength(3);
  });

  it("shows only today's cards under Today, not Tomorrow's or the week's", () => {
    const { container } = show(board(), { filter: "day" });
    const shown = titles(container);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Reply to design feedback");
  });

  it("shows today's, tomorrow's and this week's cards under This week", () => {
    const { container } = show(board(), { filter: "week" });
    expect(titles(container)).toHaveLength(3);
  });

  it("leaves the other columns alone whatever the chip", () => {
    const { container } = show(board(), { filter: "day" });
    for (const column of ["backlog", "doing", "done"]) {
      expect(
        container.querySelectorAll(
          `[data-column="${column}"] [data-testid="planner-card"]`,
        ),
      ).toHaveLength(1);
    }
  });

  it("says which period is empty when a chip hides every card", () => {
    const data = board({
      todo: [day("tasks/tomorrow", "Prep the Friday review", "2026-10-08")],
    });
    const { container } = show(data, { filter: "day" });
    expect(titles(container)).toHaveLength(0);
    expect(container.textContent).toContain(
      "Nothing planned for today. Pick All to see everything.",
    );
  });
});
