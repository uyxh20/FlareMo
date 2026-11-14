import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { HealthBreakdownRow } from "./model";
import { healthStrings } from "./strings";

// The pop-up behind a family row (fork-owned add-on, docs/fork-health-tracker.md,
// "Families and sub-types"): the four rows (Fitness, Breath, Out, own trackers)
// stay calm everywhere, and tapping one shows its sub-types, most first.

export type HealthBreakdown = {
  title: string;
  kindClass: string;
  /** "Days" or "Nights", with how many had a row. */
  totalLabel: string;
  total: number;
  rows: HealthBreakdownRow[];
};

export function HealthBreakdownDialog({
  breakdown,
  onClose,
}: {
  breakdown: HealthBreakdown | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={breakdown !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="health-breakdown">
        {breakdown && (
          <>
            <DialogHeader>
              <DialogTitle
                className={cn("flex items-center gap-2", breakdown.kindClass)}
              >
                <span
                  aria-hidden="true"
                  className="health-swatch size-2.5 rounded-full"
                />
                {breakdown.title}
              </DialogTitle>
            </DialogHeader>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium">{breakdown.totalLabel}</dt>
              <dd className="text-right font-medium tabular-nums">
                {breakdown.total}
              </dd>
              {breakdown.rows.map((row) => (
                <div
                  className="contents"
                  data-testid="health-breakdown-row"
                  key={row.key}
                >
                  <dt className="truncate pl-3 text-muted-foreground">
                    {row.label}
                  </dt>
                  <dd className="text-right tabular-nums text-muted-foreground">
                    {row.count}
                  </dd>
                </div>
              ))}
            </dl>
            {breakdown.rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {healthStrings.breakdown.none}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
