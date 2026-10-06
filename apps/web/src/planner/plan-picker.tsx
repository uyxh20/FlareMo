import type { PlannerBoardCard } from "@flaremo/contracts";
import { plannerIsValidDayKey } from "@flaremo/contracts";
import { CalendarPlusIcon, CheckIcon } from "lucide-react";
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
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { plannerHasPlan } from "./board-model";
import {
  plannerPlanOptionKeys,
  plannerPlanOptionOf,
  plannerPlanTarget,
} from "./plan-targets";
import { usePlannerStrings } from "./strings";
import type { PlannerActions } from "./use-planner-actions";

// Choosing where a task is planned (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5): the card menu's Plan
// submenu, and the small dialog behind "Pick a day…" and "Set due date…". The
// targets themselves come from plan-targets.ts, which counts from the local
// today with the shared period helpers.

/**
 * The choices of the Plan menu: Today, Tomorrow, This week, Next week, This month,
 * Next month, Pick a day…, Clear plan. The plan the card has now is marked. They
 * are the body of two menus, the card menu's Plan submenu and the task panel's
 * Plan control, so the two always offer the same.
 */
export function PlannerPlanMenuItems({
  card,
  today,
  actions,
  onPickDay,
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
  onPickDay: () => void;
}) {
  const strings = usePlannerStrings();
  const current = plannerPlanOptionOf(card, today);

  return (
    <>
      {plannerPlanOptionKeys.map((key) => (
        <DropdownMenuItem
          key={key}
          onClick={() => {
            if (key !== current) {
              actions.plan(card, plannerPlanTarget(key, today));
            }
          }}
        >
          {strings.planOption[key]}
          {key === current && <CheckIcon className="ml-auto" />}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onPickDay}>
        {strings.planOption.pickDay}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!plannerHasPlan(card)}
        onClick={() => actions.plan(card, null)}
      >
        {strings.planOption.clear}
      </DropdownMenuItem>
    </>
  );
}

/** The card menu's Plan submenu. */
export function PlannerPlanSubmenu({
  card,
  today,
  actions,
  onPickDay,
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
  onPickDay: () => void;
}) {
  const strings = usePlannerStrings();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CalendarPlusIcon />
        {strings.menu.plan}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-44">
        <PlannerPlanMenuItems
          actions={actions}
          card={card}
          today={today}
          onPickDay={onPickDay}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

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
