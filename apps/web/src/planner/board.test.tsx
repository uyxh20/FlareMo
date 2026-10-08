// @vitest-environment jsdom
import type {
  PlannerBoardCard,
  PlannerBoardResponse,
} from "@flaremo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerBoard } from "./board";
import {
  type PlannerTestMount,
  plannerTestActions,
  plannerTestMount,
} from "./test-render";
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
    start_date: null,
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
  } = {},
) {
  return (
    <PlannerBoard
      actions={plannerTestActions()}
      board={data}
      entering={false}
      reveal={options.reveal ?? null}
      today={TODAY}
      onOpen={vi.fn()}
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

describe("the To Do column", () => {
  it("shows every To Do card, with no period to filter by", () => {
    const { container } = show(board());
    expect(
      container.querySelectorAll(
        '[data-column="todo"] [data-testid="planner-card"]',
      ),
    ).toHaveLength(3);
  });
});
