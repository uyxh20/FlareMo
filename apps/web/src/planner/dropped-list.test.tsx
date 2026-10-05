// @vitest-environment jsdom
import type { PlannerBoardCard } from "@flaremo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannerDroppedList } from "./dropped-list";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
} from "./test-render";
import type { PlannerActions } from "./use-planner-actions";

const HOUR = 3_600_000;

function dropped(
  id: string,
  title: string,
  agoMs: number,
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
    horizon: "week",
    period_start: "2026-10-05",
    carry_count: 0,
    dropped_at: new Date(Date.now() - agoMs).toISOString(),
    ...overrides,
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

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function show(props: Partial<Parameters<typeof PlannerDroppedList>[0]> = {}) {
  const actions = actionsStub();
  const onRequest = vi.fn();
  const onRetry = vi.fn();
  mounted = plannerTestMount(
    <PlannerDroppedList
      actions={actions}
      cards={[]}
      failed={false}
      isRetrying={false}
      onRequest={onRequest}
      onRetry={onRetry}
      {...props}
    />,
  );
  return { actions, onRequest, onRetry, root: mounted.container };
}

describe("PlannerDroppedList", () => {
  it("lists every dropped task on one line with when it was dropped", () => {
    const { root } = show({
      cards: [
        dropped("tasks/a", "Learn Rust this weekend", 2 * 24 * HOUR),
        dropped("tasks/b", "Reorganise the garage", 3 * HOUR),
      ],
    });
    const rows = root.querySelectorAll('[data-testid="planner-dropped-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Learn Rust this weekend");
    expect(rows[0]?.textContent).toContain("Dropped 2 days ago");
    expect(rows[1]?.textContent).toContain("Reorganise the garage");
    expect(rows[1]?.textContent).toContain("Dropped 3 hours ago");
    // The header says what it is and how many.
    const section = root.querySelector('[data-testid="planner-dropped"]');
    expect(section?.getAttribute("aria-label")).toBe("Dropped");
    expect(section?.querySelector("h2")?.textContent).toBe("Dropped");
    expect(section?.querySelector("header")?.textContent).toContain("2");
  });

  it("gives each task an Undrop button that undrops that task", () => {
    const first = dropped("tasks/a", "Learn Rust this weekend", HOUR);
    const second = dropped("tasks/b", "Reorganise the garage", HOUR);
    const { root, actions } = show({ cards: [first, second] });
    const undrop = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent === "Undrop");
    expect(undrop).toHaveLength(2);
    plannerTestClick(undrop[1]);
    expect(actions.undrop).toHaveBeenCalledTimes(1);
    expect(actions.undrop).toHaveBeenCalledWith(second);
    plannerTestClick(undrop[0]);
    expect(actions.undrop).toHaveBeenLastCalledWith(first);
  });

  it("names the task on its buttons, so a screen reader can tell them apart", () => {
    const { root } = show({
      cards: [dropped("tasks/a", "Learn Rust this weekend", HOUR)],
    });
    expect(
      root.querySelector(
        'button[aria-label="Undrop: Learn Rust this weekend"]',
      ),
    ).not.toBeNull();
    expect(
      root.querySelector(
        'button[aria-label="History: Learn Rust this weekend"]',
      ),
    ).not.toBeNull();
  });

  it("opens the history of a dropped task", () => {
    const card = dropped("tasks/a", "Learn Rust this weekend", HOUR);
    const { root, onRequest } = show({ cards: [card] });
    plannerTestClick(
      root.querySelector('button[aria-label^="History"]') as HTMLElement,
    );
    expect(onRequest).toHaveBeenCalledWith({ kind: "history", card });
  });

  it("keeps a long title from widening the list past the screen", () => {
    const { root } = show({
      cards: [
        dropped(
          "tasks/a",
          "Read: Designing Data-Intensive Applications, chapter seven, and then the notes",
          HOUR,
        ),
      ],
    });
    const list = root.querySelector("ul");
    // An `auto` column grows to its widest title; `grid-cols-1` is
    // minmax(0, 1fr), so the title truncates and the buttons stay in view.
    expect(list?.classList.contains("grid-cols-1")).toBe(true);
    expect(
      root.querySelector('[data-testid="planner-dropped-item"] p')?.className,
    ).toContain("truncate");
  });

  it("says so when nothing has been dropped", () => {
    const { root } = show({ cards: [] });
    expect(root.textContent).toContain("Nothing has been dropped.");
    expect(
      root.querySelector('[data-testid="planner-dropped-item"]'),
    ).toBeNull();
  });

  it("shows a placeholder while the list is on its way", () => {
    const { root } = show({ cards: undefined });
    expect(
      root
        .querySelector('[data-testid="planner-dropped-loading"]')
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    // No count to show yet.
    expect(root.querySelector("header")?.textContent).toBe("Dropped");
  });

  it("offers a retry when the list could not be loaded", () => {
    const { root, onRetry } = show({ cards: undefined, failed: true });
    expect(
      root.querySelector('[data-testid="planner-dropped-loading"]'),
    ).toBeNull();
    const retry = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    plannerTestClick(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps showing a list it has, even if a later refresh failed", () => {
    const { root } = show({
      cards: [dropped("tasks/a", "Learn Rust this weekend", HOUR)],
      failed: true,
    });
    expect(
      root.querySelectorAll('[data-testid="planner-dropped-item"]'),
    ).toHaveLength(1);
  });
});
