import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

/**
 * Renders `ui` into a fresh element of the page. Pass a `queryClient` for a
 * component that reads or writes the query cache (the task panel does).
 */
export function plannerTestMount(
  ui: ReactNode,
  options: { queryClient?: QueryClient } = {},
): PlannerTestMount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const { queryClient } = options;
  const wrap = (node: ReactNode) => {
    const inner = <I18nProvider>{node}</I18nProvider>;
    return queryClient ? (
      <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>
    ) : (
      inner
    );
  };
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
 * Types into an input or a textarea the way React hears it: through the native
 * value setter, then an `input` event. Setting `.value` alone would be invisible
 * to a controlled field.
 */
export function plannerTestType(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * A key press on an element. Returns whether the page's handlers left the event
 * alone (false when one of them called `preventDefault`, as Enter does in a field
 * that sends on Enter).
 */
export function plannerTestKey(
  element: Element,
  key: string,
  init: KeyboardEventInit = {},
): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return !event.defaultPrevented;
}

/** Moves focus into an element, inside `act`. */
export function plannerTestFocus(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

/** Takes focus away from an element, inside `act`, so its blur handlers run. */
export function plannerTestBlur(element: HTMLElement): void {
  act(() => {
    element.blur();
  });
}

/**
 * Puts the page in the background or brings it back, as a browser does when the
 * person switches tab or app: `document.visibilityState` changes and a
 * `visibilitychange` event follows. Undo it with `plannerTestRestoreVisibility`.
 */
export function plannerTestSetVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Gives `document.visibilityState` back to the page, whatever a test set it to. */
export function plannerTestRestoreVisibility(): void {
  Reflect.deleteProperty(document, "visibilityState");
}

/** The browser's `pagehide`: the page is being left or closed. */
export function plannerTestPageHide(): void {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
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
    setStartDate: vi.fn(),
    createIn: vi.fn(),
  } satisfies PlannerActions;
}
