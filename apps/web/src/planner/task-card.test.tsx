// @vitest-environment jsdom
import type { PlannerBoardCard } from "@flaremo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerPendingCard, plannerPendingCardId } from "./board-model";
import { PlannerTaskCard, plannerClickOpensCard } from "./task-card";
import {
  type PlannerTestMount,
  plannerTestActions,
  plannerTestClick,
  plannerTestMount,
} from "./test-render";

// Wednesday 7 October 2026.
const TODAY = "2026-10-07";

function card(overrides: Partial<PlannerBoardCard> = {}): PlannerBoardCard {
  return {
    id: "tasks/reply",
    project_id: "projects/web",
    project_name: "Website relaunch",
    title: "Reply to design feedback",
    status: "todo",
    priority: "medium",
    due_at: "2026-10-09",
    sort_order: 0,
    completed_at: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    horizon: "day",
    period_start: TODAY,
    carry_count: 1,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    goal_id: null,
    ...overrides,
  };
}

let mounted: PlannerTestMount | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  for (const leftover of Array.from(document.body.children)) leftover.remove();
});

function show(entry: PlannerBoardCard, options: { overlay?: boolean } = {}) {
  const actions = plannerTestActions();
  const onOpen = vi.fn();
  const onRequest = vi.fn();
  mounted = plannerTestMount(
    <PlannerTaskCard
      actions={actions}
      card={entry}
      overlay={options.overlay}
      today={TODAY}
      onOpen={onOpen}
      onRequest={onRequest}
    />,
  );
  const root = mounted.container;
  return {
    actions,
    onOpen,
    onRequest,
    root,
    cardElement: root.querySelector<HTMLElement>('[data-slot="card"]'),
    titleButton: () =>
      root.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]') ??
      null,
  };
}

// ---------------------------------------------------------------------------

describe("plannerClickOpensCard", () => {
  /** A card element with one of everything inside it, and an element outside it. */
  function tree() {
    const root = document.createElement("div");
    root.innerHTML = `
      <div id="card">
        <p id="text"><span id="word">Title</span></p>
        <span id="chip">Today</span>
        <button id="button"><svg id="icon"></svg></button>
        <a id="link" href="/somewhere"><span id="linktext">link</span></a>
        <input id="field" />
        <label id="label">label</label>
        <div id="menuitem" role="menuitem"><span id="itemtext">item</span></div>
        <div id="menu" role="menu"><span id="menutext">menu</span></div>
        <div id="fakebutton" role="button"><span id="fakebuttontext">x</span></div>
        <div id="optout"><span id="optouttext">x</span></div>
      </div>
      <div id="outside"><span id="outsidetext">in a portal</span></div>`;
    document.body.appendChild(root);
    const get = (id: string) => root.querySelector(`#${id}`) as Element;
    return { root, get, card: get("card") };
  }
  const clickOn = (currentTarget: Element, target: EventTarget | null) =>
    plannerClickOpensCard({ currentTarget, target });

  afterEach(() => {
    for (const leftover of Array.from(document.body.children)) {
      leftover.remove();
    }
  });

  it("opens for a click on the card's own text, chips and padding", () => {
    const { get, card: cardElement } = tree();
    for (const id of ["text", "word", "chip"]) {
      expect(clickOn(cardElement, get(id)), id).toBe(true);
    }
    // The card element itself, as a click on its padding is.
    expect(clickOn(cardElement, cardElement)).toBe(true);
  });

  it("leaves a click on a button, a link, a field or a menu to that control", () => {
    const { get, card: cardElement } = tree();
    for (const id of [
      "button",
      "icon",
      "link",
      "linktext",
      "field",
      "label",
      "menuitem",
      "itemtext",
      "menu",
      "menutext",
      "fakebutton",
      "fakebuttontext",
    ]) {
      expect(clickOn(cardElement, get(id)), id).toBe(false);
    }
  });

  it("does not open for a click that did not start inside the card", () => {
    // A menu's items are React children of the card but DOM children of the
    // page, so their clicks reach the card's handler through React with a target
    // outside it.
    const { get, card: cardElement } = tree();
    expect(clickOn(cardElement, get("outside"))).toBe(false);
    expect(clickOn(cardElement, get("outsidetext"))).toBe(false);
  });

  it("does not open for a target that is not an element", () => {
    const { card: cardElement } = tree();
    expect(clickOn(cardElement, null)).toBe(false);
    expect(clickOn(cardElement, document)).toBe(false);
    expect(clickOn(cardElement, window)).toBe(false);
  });

  it("is not fooled by a control that wraps the whole card", () => {
    // If the card itself sits inside a button-like ancestor, a click on its text
    // still belongs to the card: only controls inside it count.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "button");
    wrapper.innerHTML = `<div id="inner"><span id="innertext">Title</span></div>`;
    document.body.appendChild(wrapper);
    const inner = wrapper.querySelector("#inner") as Element;
    const text = wrapper.querySelector("#innertext") as Element;
    expect(clickOn(inner, text)).toBe(true);
  });
});

describe("PlannerTaskCard", () => {
  it("opens the panel when the card is clicked, on its text, its chips or its edge", () => {
    const entry = card();
    const { root, onOpen, cardElement } = show(entry);
    const chips = Array.from(root.querySelectorAll("span")).find(
      (element) => element.textContent === "Medium",
    );
    expect(chips).toBeDefined();
    plannerTestClick(chips);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith(entry);

    plannerTestClick(cardElement);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("opens exactly once for a click on the title, which is a button of its own", () => {
    const entry = card();
    const { titleButton, onOpen } = show(entry);
    const button = titleButton();
    expect(button).not.toBeNull();
    // A real button: Enter and Space open it with no key handling of ours.
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.textContent).toBe("Reply to design feedback");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");

    plannerTestClick(button);
    // The click reaches the card too, which ignores clicks that start in a
    // button: one click is one open.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(entry);
  });

  it("keeps the status icon's own job: it advances the task and opens nothing", () => {
    const entry = card();
    const { root, actions, onOpen } = show(entry);
    const advance = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Start"]',
    );
    expect(advance).not.toBeNull();
    plannerTestClick(advance);
    expect(actions.move).toHaveBeenCalledWith(entry, "doing");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the menu button's own job and opens nothing", () => {
    const { root, onOpen } = show(card());
    const menu = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Task actions"]',
    );
    expect(menu).not.toBeNull();
    plannerTestClick(menu);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("is a plain, unclickable copy while it is dragged", () => {
    const entry = card();
    const { root, onOpen, cardElement, titleButton } = show(entry, {
      overlay: true,
    });
    // No title button, status button or menu: nothing to click or tab to.
    expect(titleButton()).toBeNull();
    expect(root.querySelectorAll("button")).toHaveLength(0);
    plannerTestClick(cardElement);
    expect(onOpen).not.toHaveBeenCalled();
    expect(cardElement?.className).not.toContain("cursor-pointer");
    expect(root.textContent).toContain("Reply to design feedback");
  });

  it("is inert while the server has not answered for it: dimmed, busy, nothing to open", () => {
    const waiting = plannerPendingCard({
      id: plannerPendingCardId(1),
      title: "Writing it down",
      column: "doing",
      plan: null,
      now: new Date("2026-10-07T09:00:00.000Z"),
    });
    const { root, onOpen, cardElement, titleButton } = show(waiting);
    expect(titleButton()).toBeNull();
    expect(root.querySelectorAll("button")).toHaveLength(0);
    expect(cardElement?.getAttribute("aria-busy")).toBe("true");
    expect(cardElement?.className).toContain("opacity-70");
    expect(cardElement?.className).not.toContain("cursor-pointer");
    plannerTestClick(cardElement);
    expect(onOpen).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Writing it down");
  });

  it("shows a finished task struck through and still opens it", () => {
    const done = card({ status: "done", completed_at: "2026-10-06T09:00:00Z" });
    const { titleButton, onOpen } = show(done);
    const button = titleButton();
    expect(button?.className).toContain("line-through");
    plannerTestClick(button);
    expect(onOpen).toHaveBeenCalledWith(done);
  });

  it("marks a card the pointer can click", () => {
    const { cardElement } = show(card());
    expect(cardElement?.className).toContain("cursor-pointer");
    expect(cardElement?.getAttribute("aria-busy")).toBeNull();
  });
});
