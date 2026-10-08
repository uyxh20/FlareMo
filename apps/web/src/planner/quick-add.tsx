import { PlusIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlannerStrings } from "./strings";
import type { PlannerActions } from "./use-planner-actions";

// Quick add (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 5): a title, added to the Backlog. Enter adds. The field empties and keeps
// focus the moment the request goes out, so the next task can be typed while the
// last one is still being saved; if it fails, the text comes back (unless something
// new was typed meanwhile). There is no period to choose (section 13.x): a task
// moves on from the Backlog by its column.

export function PlannerQuickAdd({
  actions,
  inputRef,
}: {
  actions: PlannerActions;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const strings = usePlannerStrings();
  const [title, setTitle] = useState("");
  const canAdd = title.trim().length > 0;

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    setTitle("");
    inputRef.current?.focus();
    void actions
      .createIn({ title: text, column: "backlog", plan: null })
      .then((created) => {
        if (!created) setTitle((current) => (current === "" ? text : current));
      });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={strings.quickAdd.label}
        className="h-9 min-w-[10rem] flex-1 basis-48"
        maxLength={2000}
        placeholder={strings.quickAdd.placeholder}
        ref={inputRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          // Enter that confirms an IME candidate must not add the task.
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <Button
        className="h-9 shrink-0 max-sm:w-9 max-sm:px-0"
        disabled={!canAdd}
        type="button"
        onClick={submit}
      >
        <PlusIcon data-icon="inline-start" />
        {/* On a phone the label gives way to the icon so the row stays one line. */}
        <span className="max-sm:sr-only">{strings.quickAdd.add}</span>
      </Button>
    </div>
  );
}
