import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { I18nProvider } from "@/i18n";
import type { PlannerActions } from "./use-planner-actions";

// A small way to put a cockpit component in a jsdom page and click it, for the
// tests (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 6). It is not imported by the app. The page is wrapped in the real
// I18nProvider (English unless the test says otherwise), so no test needs to
// mock the app's language.

// React only batches updates made inside `act` without a warning when the
// environment says it is a test one.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export type PlannerTestMount = {
  /** The element the UI was rendered into. */
  container: HTMLElement;
  /** Renders something else in the same root, as a state change would. */
  rerender: (ui: ReactNode) => void;
  /** Takes the UI down and removes its element. Call it at the end of a test. */
  unmount: () => void;
};

export function plannerTestMount(ui: ReactNode): PlannerTestMount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (node: ReactNode) => <I18nProvider>{node}</I18nProvider>;
  act(() => {
    root.render(wrap(ui));
  });
  return {
    container,
    rerender: (next) => {
      act(() => {
        root.render(wrap(next));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Clicks an element the way a person would, inside `act`. */
export function plannerTestClick(element: Element | null | undefined): void {
  if (!element) throw new Error("There is nothing to click.");
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

/**
 * Every cockpit action as a spy, so a test can render a board, a card or a panel
 * and check which action a click reached. `satisfies` keeps the list honest: a new
 * action added to `PlannerActions` fails the type check here, in one place.
 */
export function plannerTestActions() {
  return {
    move: vi.fn(),
    plan: vi.fn(),
    setDue: vi.fn(),
    drop: vi.fn(),
    undrop: vi.fn(),
    setTitle: vi.fn(),
    setPriority: vi.fn(),
    setProject: vi.fn(),
    setEffort: vi.fn(),
    create: vi.fn(),
    createIn: vi.fn(),
  } satisfies PlannerActions;
}
