import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Memo } from "@/api";
import { updateMemo } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/error";
import { getMemoResourceId } from "@/lib/memo";
import { forkLocalInputToIso, forkLocalInputValue } from "./memo-date";

// Fork add-on (docs/fork-customizations.md, "Edit a memo's created time"):
// the dialog behind the ⋯ menu's "Edit date and time". Backdates (or moves)
// a memo; the server keeps the very first time in the memo payload.

type MemoDateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memo: Memo;
};

export function ForkMemoDateDialog({
  open,
  onOpenChange,
  memo,
}: MemoDateDialogProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(() =>
    forkLocalInputValue(memo.create_time),
  );
  const [saving, setSaving] = useState(false);

  // Start from the memo's current time each time the dialog opens.
  useEffect(() => {
    if (open) setValue(forkLocalInputValue(memo.create_time));
  }, [open, memo.create_time]);

  const iso = forkLocalInputToIso(value);
  const unchanged =
    iso === null || iso === new Date(memo.create_time).toISOString();
  const inFuture = iso !== null && new Date(iso).getTime() > Date.now();

  const save = async () => {
    if (iso === null || unchanged || inFuture || saving) return;
    setSaving(true);
    try {
      await updateMemo(getMemoResourceId(memo), { created_at: iso });
      toast.success("Date and time updated");
      onOpenChange(false);
      await Promise.all(
        [
          ["memos"],
          ["memo-stats"],
          ["memo-context"],
          ["memo-related"],
          ["health"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the date"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit date and time</DialogTitle>
          <DialogDescription>
            Moves this note on the timeline, the calendar, the health tracker
            and the weekly review. The original time is kept.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Created date and time"
          max={forkLocalInputValue(new Date().toISOString())}
          type="datetime-local"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {inFuture && (
          <p className="text-xs text-destructive">
            A note cannot be dated in the future.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={unchanged || inFuture || saving} onClick={save}>
            {saving && <Loader2Icon className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
