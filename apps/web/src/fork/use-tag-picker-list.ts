import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TagSuggestion } from "@/lib/tag-autocomplete";
import {
  fitTagPickerHeight,
  placeTagPicker,
  TAG_PICKER_CANVAS_OFFSET,
  TAG_PICKER_EDGE,
  type TagPickerAnchor,
  type TagPickerPlacement,
} from "./tag-picker";

// Fork-owned (docs/fork-customizations.md): what the "#" tag list does in the
// DOM that its markup cannot say: where it opens so nothing clips it, and
// keeping the highlighted row in view. ComposerTagSuggestions (upstream) keeps
// the markup and calls this hook for the rest.

/**
 * The area an element can be seen in: the viewport as an on-screen keyboard
 * leaves it (`visualViewport`, which shrinks when the keyboard opens even where
 * the layout viewport does not), narrowed by every ancestor that clips it. In
 * the timeline that ancestor is the scrolling page body, so the sticky header
 * above it is never counted as room.
 */
export function visibleBounds(element: Element): {
  top: number;
  bottom: number;
} {
  const view = element.ownerDocument.defaultView;
  const viewport = view?.visualViewport;
  let top = viewport ? viewport.offsetTop : 0;
  let bottom = viewport
    ? viewport.offsetTop + viewport.height
    : (view?.innerHeight ?? 0);
  if (!view) return { top, bottom };
  const root = element.ownerDocument.documentElement;
  for (
    let node: Element | null = element;
    node && node !== root;
    node = node.parentElement
  ) {
    // (A test DOM can answer "" for a style nobody set.)
    const overflow = view.getComputedStyle(node).overflowY;
    if (overflow === "visible" || overflow === "") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

/**
 * Where the list should open and how tall it may be, measured from the box it
 * is absolutely positioned in. Null when there is no layout to measure (a test
 * DOM has none), and the list then keeps its CSS defaults.
 */
export function measureTagPicker(
  list: HTMLElement,
  anchor: TagPickerAnchor,
): TagPickerPlacement | null {
  const host = list.offsetParent;
  if (!(host instanceof HTMLElement)) return null;
  const box = host.getBoundingClientRect();
  const bounds = visibleBounds(host);
  if (anchor === "canvas") {
    // The canvas keeps its list above its own toolbar; only the height adapts,
    // so a short window does not push the top rows out of the scroll area.
    return {
      side: "above",
      maxHeight: fitTagPickerHeight(
        box.bottom - TAG_PICKER_CANVAS_OFFSET - bounds.top - TAG_PICKER_EDGE,
      ),
    };
  }
  return placeTagPicker({
    anchor: { top: box.top, bottom: box.bottom },
    bounds,
  });
}

/** Position classes for the list's root; `top-full`/`bottom-full` need the host to be `relative`. */
function positionClass(
  anchor: TagPickerAnchor,
  placement: TagPickerPlacement | null,
): string {
  if (anchor === "canvas") return "bottom-12";
  return placement?.side === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5";
}

export type UseTagPickerListOptions = {
  /** The list is on screen. */
  visible: boolean;
  anchor: TagPickerAnchor;
  suggestions: TagSuggestion[];
  /** Highlighted row, -1 for none. */
  activeIndex: number;
};

export type TagPickerListBehaviour = {
  /** Goes on the list's root element; its direct children are the rows. */
  listRef: RefObject<HTMLDivElement | null>;
  /** Where the list sits: below or above its host. */
  positionClass: string;
  /** The measured height cap (undefined until measured, then the CSS cap rules). */
  style: CSSProperties | undefined;
};

/**
 * Placement is measured when the list opens (and again if the viewport
 * resizes while it is open, e.g. a phone's keyboard or a rotation). The
 * highlighted row is scrolled into view when it changes, and a new set of
 * matches starts at the top.
 */
export function useTagPickerList({
  visible,
  anchor,
  suggestions,
  activeIndex,
}: UseTagPickerListOptions): TagPickerListBehaviour {
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<TagPickerPlacement | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !list) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const next = measureTagPicker(list, anchor);
      // Keep the old object when nothing moved, so a resize that changes
      // nothing costs no render.
      setPlacement((previous) =>
        previous &&
        next &&
        previous.side === next.side &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    measure();
    const view = list.ownerDocument.defaultView;
    view?.addEventListener("resize", measure);
    view?.visualViewport?.addEventListener("resize", measure);

    const host =
      list.offsetParent instanceof HTMLElement ? list.offsetParent : null;
    // The composer is still opening when the list can be (its editor grows
    // from one line over 200ms on focus) and grows as it fills, so measure
    // again whenever its box changes size. A test DOM has no ResizeObserver.
    const resize =
      host && typeof ResizeObserver === "function"
        ? new ResizeObserver(measure)
        : null;
    if (host) resize?.observe(host);

    // The timeline composer is a stacking context (its entrance animation
    // leaves a transform on it), so a list hanging below it would paint under
    // the notes that follow, however high its own z-index. Lift the composer
    // above them while the list is open. The focus canvas has nothing under it.
    const lifted = anchor === "composer" ? host : null;
    const before = lifted?.style.zIndex ?? "";
    if (lifted) lifted.style.zIndex = "30";

    return () => {
      view?.removeEventListener("resize", measure);
      view?.visualViewport?.removeEventListener("resize", measure);
      resize?.disconnect();
      if (lifted) lifted.style.zIndex = before;
    };
  }, [visible, anchor]);

  const matchesKey = `${suggestions.length}:${suggestions[0]?.name ?? ""}`;
  const seen = useRef({ matchesKey, activeIndex });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || !list) return;
    const before = seen.current;
    seen.current = { matchesKey, activeIndex };
    const newMatches = before.matchesKey !== matchesKey;
    if (newMatches) list.scrollTop = 0;
    if (
      activeIndex >= 0 &&
      (newMatches || before.activeIndex !== activeIndex)
    ) {
      // Optional call: a test DOM has no scrollIntoView.
      list.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [visible, activeIndex, matchesKey]);

  return {
    listRef,
    positionClass: positionClass(anchor, placement),
    style: placement ? { maxHeight: placement.maxHeight } : undefined,
  };
}
