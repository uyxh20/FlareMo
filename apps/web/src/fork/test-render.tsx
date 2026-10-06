import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/i18n";

// A small way to put a component in a jsdom page for the fork's tests
// (docs/fork-customizations.md). It is not imported by the app. The page is
// wrapped in the real I18nProvider (English), so no test mocks the language.

// React only batches updates made inside `act` without a warning when the
// environment says it is a test one.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export type ForkTestMount = {
  /** The element the UI was rendered into. */
  container: HTMLElement;
  /** Renders something else in the same root, as a state change would. */
  rerender: (ui: ReactNode) => void;
  /** Takes the UI down and removes its element. Call it at the end of a test. */
  unmount: () => void;
};

export function forkTestMount(ui: ReactNode): ForkTestMount {
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

/** A mouse move with the pointer travel a real one carries (none: a synthetic one). */
export function mouseMove(movement: { x: number; y: number }): MouseEvent {
  return new MouseEvent("mousemove", {
    bubbles: true,
    cancelable: true,
    movementX: movement.x,
    movementY: movement.y,
  });
}
