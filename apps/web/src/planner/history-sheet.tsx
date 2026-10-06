import type { PlannerBoardCard } from "@flaremo/contracts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PlannerHistoryTimeline } from "./history-timeline";
import { usePlannerStrings } from "./strings";

// One task's timeline in a sheet (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): the card menu's
// "History". The timeline itself, with its loading, error and empty states, is
// history-timeline.tsx, which the task panel's History section shares.

export function PlannerHistorySheet({
  card,
  open,
  onOpenChange,
}: {
  card: PlannerBoardCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const strings = usePlannerStrings();
  const taskId = card?.id ?? "";

  // `outline-none` on the sheet: opening it focuses the sheet itself, and when
  // that happens without a pointer (a keyboard open) the browser outlines the
  // whole panel. The task panel does the same here; the shared sheet component is
  // upstream's, so the class is passed in rather than added there.
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 outline-none sm:max-w-md"
        side="right"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>{strings.history.title}</SheetTitle>
          <SheetDescription className="line-clamp-2 break-words">
            {card?.title ?? strings.history.description}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <PlannerHistoryTimeline enabled={open} taskId={taskId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
