import { UploadIcon } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Drag and drop for every place that takes a file (fork-owned, see
// docs/fork-customizations.md, "Drop files anywhere they upload"): the note
// composer and its full-screen canvas, Ask, a task's files and the review's
// answer box. One hook keeps the drop state right and one overlay shows it.
//
// - Only a drag that carries files lights the area up; dragging text or a
//   link inside the page does nothing.
// - The browser sends dragleave each time the pointer crosses a child, so the
//   hook counts enters and leaves instead of trusting one leave.
// - A drop that something inside already handled (the note editor puts a
//   dropped image where it lands) is left alone; the area only clears.

const carriesFiles = (event: DragEvent<HTMLElement>) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

export type ForkFileDrop = {
  /** A file is being dragged over the area. */
  over: boolean;
  /** Spread on the element that takes the drop. */
  props: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
};

export function useForkFileDrop(
  onFiles: (files: File[]) => void,
  enabled = true,
): ForkFileDrop {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  return {
    over: enabled && over,
    props: {
      onDragEnter: (event) => {
        if (!enabled || !carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event) => {
        if (!enabled || !carriesFiles(event)) return;
        // Without this the browser opens the file instead of dropping it.
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event) => {
        const handled = event.defaultPrevented;
        reset();
        if (!enabled || handled) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        onFiles(files);
      },
    },
  };
}

/**
 * The highlight over an area while a file is dragged on it: a dashed brand
 * border and one line saying what a drop does. Its parent must be positioned
 * (`relative`); `className` can place it otherwise.
 */
export function ForkDropOverlay({
  show,
  label,
  className,
}: {
  show: boolean;
  label: string;
  className?: string;
}) {
  if (!show) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-brand-500 bg-brand-500/10 backdrop-blur-[1px] dark:border-brand-400",
        className,
      )}
      data-testid="fork-drop-overlay"
    >
      <span className="flex items-center gap-2 rounded-full bg-background/95 px-3.5 py-1.5 text-sm font-medium text-foreground shadow-sm">
        <UploadIcon className="size-4 text-brand-600 dark:text-brand-400" />
        {label}
      </span>
    </div>
  );
}

/** The note composer's drop line, in the app's language (Chinese or English). */
export function forkNoteDropLabel(locale: string): string {
  return locale.startsWith("zh")
    ? "松开即可添加到笔记"
    : "Drop to attach to the note";
}
