// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerTagSuggestions } from "@/components/composer/composer-suggestion-lists";
import type { TagSuggestion } from "@/lib/tag-autocomplete";
import { type ForkTestMount, forkTestMount, mouseMove } from "./test-render";
import { measureTagPicker, visibleBounds } from "./use-tag-picker-list";

const tags: TagSuggestion[] = Array.from({ length: 30 }, (_, index) => ({
  name: `tag${String(index).padStart(2, "0")}`,
  count: 30 - index,
}));

let mounted: ForkTestMount | undefined;
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  // jsdom has no scrollIntoView; the list calls it on the highlighted row.
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  // @ts-expect-error: remove the stub so no test leans on another's.
  delete Element.prototype.scrollIntoView;
  stubViewport(null);
  vi.unstubAllGlobals();
});

type ListProps = Parameters<typeof ComposerTagSuggestions>[0];

function list(props: Partial<ListProps> = {}) {
  return (
    <ComposerTagSuggestions
      visible
      suggestions={tags}
      onAccept={() => undefined}
      {...props}
    />
  );
}

function show(props: Partial<ListProps> = {}) {
  mounted = forkTestMount(list(props));
  return mounted;
}

const listbox = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="composer-tag-suggestions"]',
  );
const options = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

describe("ComposerTagSuggestions", () => {
  it("renders every row instead of the top six", () => {
    show();
    expect(options()).toHaveLength(30);
    expect(options()[29]?.textContent).toContain("tag29");
  });

  it("keeps the usage count on the right of each row", () => {
    show({ suggestions: [{ name: "carlsberg", count: 7 }] });
    const [row] = options();
    expect(row?.textContent).toBe("#carlsberg7");
    expect(row?.lastElementChild?.textContent).toBe("7");
  });

  it("renders nothing while hidden", () => {
    show({ visible: false });
    expect(listbox()).toBeNull();
  });

  it("is a named listbox of options", () => {
    show();
    const box = listbox();
    expect(box?.getAttribute("role")).toBe("listbox");
    expect(box?.getAttribute("aria-label")).toBe("Tags");
    expect(options().every((row) => row.tagName === "BUTTON")).toBe(true);
  });

  it("scrolls inside itself and never hands the scroll to the page", () => {
    show();
    const classes = listbox()?.className ?? "";
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overscroll-contain");
    expect(classes).toContain("max-h-72");
  });

  it("marks only the highlighted row as selected", () => {
    show({ activeIndex: 3 });
    const selected = options().map((row) => row.getAttribute("aria-selected"));
    expect(selected.filter((value) => value === "true")).toHaveLength(1);
    expect(selected[3]).toBe("true");
    expect(selected[2]).toBe("false");
    expect(options()[3]?.className).toContain("bg-accent");
    expect(options()[2]?.className).not.toContain("bg-accent");
  });

  it("marks no row while nothing is highlighted", () => {
    show({ activeIndex: -1 });
    expect(
      options().every((row) => row.getAttribute("aria-selected") === "false"),
    ).toBe(true);
  });

  it("keeps the rows out of the tab order, the editor keeps focus", () => {
    show();
    expect(options().every((row) => row.tabIndex === -1)).toBe(true);
  });

  it("scrolls the highlighted row into view when the highlight changes", () => {
    const view = show({ activeIndex: -1 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(list({ activeIndex: 12 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(options()[12]);

    view.rerender(list({ activeIndex: 12 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(list({ activeIndex: 13 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(options()[13]);
  });

  it("does not scroll when the list opens on the first row", () => {
    show({ activeIndex: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("starts a new set of matches at the top", () => {
    const view = show({ activeIndex: -1 });
    const box = listbox();
    if (!box) throw new Error("no list");
    box.scrollTop = 200;
    view.rerender(list({ suggestions: tags.slice(0, 5), activeIndex: 0 }));
    expect(box.scrollTop).toBe(0);
  });

  it("stops a mouse press from taking focus, wherever on the list it lands", () => {
    show();
    const box = listbox();
    if (!box) throw new Error("no list");
    // The padding and the scrollbar belong to the container, not to a row.
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("accepts a row on mousedown without moving focus", () => {
    const onAccept = vi.fn();
    show({ onAccept });
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      options()[4]?.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledExactlyOnceWith("tag04");
  });

  it("moves the highlight when the pointer travels onto another row", () => {
    const onActiveIndexChange = vi.fn();
    show({ activeIndex: 1, onActiveIndexChange });
    act(() => {
      options()[6]?.dispatchEvent(mouseMove({ x: 2, y: 5 }));
    });
    expect(onActiveIndexChange).toHaveBeenCalledExactlyOnceWith(6);
  });

  it("ignores moves with no travel, which a scrolling list makes under a resting pointer", () => {
    const onActiveIndexChange = vi.fn();
    show({ activeIndex: 1, onActiveIndexChange });
    act(() => {
      options()[6]?.dispatchEvent(mouseMove({ x: 0, y: 0 }));
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it("does not report the row that is already highlighted", () => {
    const onActiveIndexChange = vi.fn();
    show({ activeIndex: 6, onActiveIndexChange });
    act(() => {
      options()[6]?.dispatchEvent(mouseMove({ x: 4, y: 4 }));
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it("hangs below the timeline composer by default and above the canvas toolbar", () => {
    show();
    expect(listbox()?.className).toContain("top-full");
    expect(listbox()?.className).not.toContain("bottom-12");
    mounted?.unmount();
    show({ anchor: "canvas" });
    expect(listbox()?.className).toContain("bottom-12");
    expect(listbox()?.className).not.toContain("top-full");
  });
});

// A test DOM has no layout, so these hand the list a host box and a viewport.
function giveLayout(
  host: { top: number; bottom: number },
  options: { clips?: boolean } = {},
) {
  const box = document.createElement("div");
  // The focus canvas hangs its list inside a scrolling area.
  if (options.clips) box.style.overflowY = "auto";
  box.getBoundingClientRect = () =>
    ({
      top: host.top,
      bottom: host.bottom,
      left: 0,
      right: 400,
      width: 400,
      height: host.bottom - host.top,
      x: 0,
      y: host.top,
      toJSON: () => ({}),
    }) satisfies DOMRect;
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(box);
}

type ViewportStub = {
  offsetTop?: number;
  height: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

// The list reads the window of its own document, which in vitest's jsdom is
// not `globalThis`, so the stub goes on that window.
function stubViewport(viewport: ViewportStub | null) {
  Object.defineProperty(window.document.defaultView, "visualViewport", {
    configurable: true,
    value: viewport && {
      offsetTop: 0,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      ...viewport,
    },
  });
}

describe("ComposerTagSuggestions placement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens below the composer and caps its height to the room there", () => {
    stubViewport({ height: 600 });
    giveLayout({ top: 100, bottom: 400 });
    show();
    expect(listbox()?.className).toContain("top-full");
    // 600 - 400 - gap(6) - edge(8)
    expect(listbox()?.style.maxHeight).toBe("186px");
  });

  it("opens above the composer when there is no room below", () => {
    stubViewport({ height: 600 });
    giveLayout({ top: 420, bottom: 560 });
    show();
    expect(listbox()?.className).toContain("bottom-full");
    expect(listbox()?.className).not.toContain("top-full");
    expect(listbox()?.style.maxHeight).toBe("288px");
  });

  it("follows the on-screen keyboard, not the layout viewport", () => {
    // window.innerHeight is 768 in jsdom; the keyboard leaves 330 visible.
    stubViewport({ height: 330 });
    giveLayout({ top: 100, bottom: 200 });
    show();
    expect(listbox()?.className).toContain("top-full");
    // 330 - 200 - 14
    expect(listbox()?.style.maxHeight).toBe("116px");
  });

  it("keeps the canvas list above its toolbar and caps it to the scroll area", () => {
    stubViewport({ height: 900 });
    giveLayout({ top: 60, bottom: 260 }, { clips: true });
    show({ anchor: "canvas" });
    expect(listbox()?.className).toContain("bottom-12");
    // 260 - 48 (bottom-12) - 60 (area top) - 8 (edge)
    expect(listbox()?.style.maxHeight).toBe("144px");
  });

  it("measures again when the viewport resizes while it is open", () => {
    const listeners = new Set<() => void>();
    stubViewport({
      height: 600,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    });
    giveLayout({ top: 100, bottom: 400 });
    show();
    expect(listbox()?.style.maxHeight).toBe("186px");
    stubViewport({ height: 500 });
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(listbox()?.style.maxHeight).toBe("86px");
  });

  it("measures again when the composer changes size, and stops when the list closes", () => {
    const observed: Element[] = [];
    let notify: () => void = () => undefined;
    let disconnected = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {
          disconnected += 1;
        }
      },
    );
    stubViewport({ height: 600 });
    const host = { top: 100, bottom: 400 };
    giveLayout(host);
    const view = show();
    expect(observed).toHaveLength(1);
    expect(listbox()?.style.maxHeight).toBe("186px");

    // The composer grew a few lines while the list was open.
    host.bottom = 450;
    act(() => notify());
    expect(listbox()?.style.maxHeight).toBe("136px");

    view.rerender(list({ visible: false }));
    expect(disconnected).toBe(1);
  });

  it("lifts the composer above the notes under the list while it is open, and puts it back", () => {
    stubViewport({ height: 600 });
    const host = document.createElement("div");
    host.style.zIndex = "5";
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      host,
    );
    const view = show();
    expect(host.style.zIndex).toBe("30");
    view.rerender(list({ visible: false }));
    expect(host.style.zIndex).toBe("5");
  });

  it("leaves the focus canvas's own area alone", () => {
    stubViewport({ height: 600 });
    const host = document.createElement("div");
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      host,
    );
    show({ anchor: "canvas" });
    expect(host.style.zIndex).toBe("");
  });

  it("leaves the CSS defaults alone where there is no layout to measure", () => {
    show();
    expect(listbox()?.style.maxHeight).toBe("");
    expect(listbox()?.className).toContain("top-full");
  });
});

describe("visibleBounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the visual viewport when nothing clips", () => {
    stubViewport({ offsetTop: 20, height: 400 });
    const element = document.createElement("div");
    document.body.appendChild(element);
    expect(visibleBounds(element)).toEqual({ top: 20, bottom: 420 });
    element.remove();
  });

  it("falls back to the window height without a visual viewport", () => {
    stubViewport(null);
    const element = document.createElement("div");
    document.body.appendChild(element);
    expect(visibleBounds(element)).toEqual({
      top: 0,
      bottom: window.innerHeight,
    });
    element.remove();
  });

  it("is narrowed by a scrolling ancestor, such as the page body under a sticky header", () => {
    stubViewport({ height: 800 });
    const scroller = document.createElement("main");
    scroller.style.overflowY = "auto";
    scroller.getBoundingClientRect = () =>
      ({ top: 56, bottom: 700 }) as DOMRect;
    const child = document.createElement("form");
    scroller.appendChild(child);
    document.body.appendChild(scroller);
    expect(visibleBounds(child)).toEqual({ top: 56, bottom: 700 });
    scroller.remove();
  });

  it("counts the element itself when it clips its own children", () => {
    stubViewport({ height: 800 });
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.getBoundingClientRect = () =>
      ({ top: 70, bottom: 500 }) as DOMRect;
    document.body.appendChild(scroller);
    expect(visibleBounds(scroller)).toEqual({ top: 70, bottom: 500 });
    scroller.remove();
  });
});

describe("measureTagPicker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is null without a box to hang from", () => {
    const orphan = document.createElement("div");
    expect(measureTagPicker(orphan, "composer")).toBeNull();
  });
});
