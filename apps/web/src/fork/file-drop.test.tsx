// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkDropOverlay, useForkFileDrop } from "./file-drop";
import { type ForkTestMount, forkTestMount } from "./test-render";

// Drop files anywhere they upload (file-drop.tsx): the area lights up only
// while files are dragged on it, stays lit as the pointer crosses children,
// and hands the files on unless something inside took the drop.

let mounted: ForkTestMount | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function Area({
  onFiles,
  enabled = true,
}: {
  onFiles: (files: File[]) => void;
  enabled?: boolean;
}) {
  const drop = useForkFileDrop(onFiles, enabled);
  return (
    <div className="relative" data-testid="area" {...drop.props}>
      <ForkDropOverlay label="Drop to attach" show={drop.over} />
      <span data-testid="child">inside</span>
    </div>
  );
}

const fire = async (
  target: Element,
  type: string,
  data: { types?: string[]; files?: File[] },
  before?: (event: Event) => void,
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: data.types ?? [],
      files: data.files ?? [],
      dropEffect: "none",
    },
  });
  before?.(event);
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};

const overlay = (root: HTMLElement) =>
  root.querySelector('[data-testid="fork-drop-overlay"]');

describe("useForkFileDrop", () => {
  it("lights up for files, holds over children, and drops them", async () => {
    const onFiles = vi.fn();
    mounted = forkTestMount(<Area onFiles={onFiles} />);
    const area = mounted.container.querySelector(
      '[data-testid="area"]',
    ) as Element;
    const child = mounted.container.querySelector(
      '[data-testid="child"]',
    ) as Element;
    const files = { types: ["Files"] };
    await fire(area, "dragenter", files);
    await fire(child, "dragenter", files);
    await fire(area, "dragleave", files);
    expect(overlay(mounted.container)?.textContent).toBe("Drop to attach");
    const file = new File(["x"], "contract.pdf", { type: "application/pdf" });
    const drop = await fire(child, "drop", { types: ["Files"], files: [file] });
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(overlay(mounted.container)).toBeNull();
  });

  it("ignores text drags and a drop something inside took", async () => {
    const onFiles = vi.fn();
    mounted = forkTestMount(<Area onFiles={onFiles} />);
    const area = mounted.container.querySelector(
      '[data-testid="area"]',
    ) as Element;
    await fire(area, "dragenter", { types: ["text/plain"] });
    expect(overlay(mounted.container)).toBeNull();
    const file = new File(["x"], "a.png", { type: "image/png" });
    await fire(area, "drop", { types: ["Files"], files: [file] }, (event) =>
      event.preventDefault(),
    );
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("does nothing when off", async () => {
    const onFiles = vi.fn();
    mounted = forkTestMount(<Area enabled={false} onFiles={onFiles} />);
    const area = mounted.container.querySelector(
      '[data-testid="area"]',
    ) as Element;
    await fire(area, "dragenter", { types: ["Files"] });
    expect(overlay(mounted.container)).toBeNull();
    await fire(area, "drop", {
      types: ["Files"],
      files: [new File(["x"], "a.txt")],
    });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
