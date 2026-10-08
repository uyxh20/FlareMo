import { plannerIsValidDayKey } from "@flaremo/contracts";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePlannerStrings } from "./strings";

// The one-date dialog of the cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): the card menu's
// "Set due date…" asks for a day here. (The plan menu is gone, section 13.x.)

/**
 * One date, asked for in a small dialog. A plan cannot start before today, so
 * "Pick a day…" passes `min`; a due date can be any day.
 */
export function PlannerDayDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  initial,
  min,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  initial: string | null;
  min?: string;
  onConfirm: (day: string) => void;
}) {
  const strings = usePlannerStrings();
  const [day, setDay] = useState(initial ?? "");

  // Start from the card's current value every time the dialog opens.
  useEffect(() => {
    if (open) setDay(initial ?? "");
  }, [open, initial]);

  const valid = plannerIsValidDayKey(day) && (min === undefined || day >= min);
  const confirm = () => {
    if (!valid) return;
    onConfirm(day);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label={strings.dayDialog.dayLabel}>
          <Input
            min={min}
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                confirm();
              }
            }}
          />
        </Field>
        <DialogFooter>
          <Button disabled={!valid} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
