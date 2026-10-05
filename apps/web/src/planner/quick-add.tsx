import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  type PlannerQuickAddChoice,
  plannerQuickAddChoices,
} from "./plan-targets";
import { usePlannerStrings } from "./strings";
import type { PlannerActions } from "./use-planner-actions";

// Quick add (fork-owned add-on, docs/planning-cockpit-implementation-plan.md,
// section 5): a title and where to plan it, Today unless told otherwise. Enter
// adds. The field empties and keeps focus the moment the request goes out, so
// the next task can be typed while the last one is still being saved; if it
// fails, the text comes back (unless something new was typed meanwhile).

export function PlannerQuickAdd({
  actions,
  inputRef,
}: {
  actions: PlannerActions;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const strings = usePlannerStrings();
  const [title, setTitle] = useState("");
  const [choice, setChoice] = useState<PlannerQuickAddChoice>("day");

  const choiceLabel = strings.horizon[choice];
  const canAdd = title.trim().length > 0;

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    setTitle("");
    inputRef.current?.focus();
    void actions.create({ title: text, choice }).then((created) => {
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`${strings.quickAdd.planFor}: ${choiceLabel}`}
              className="h-9 shrink-0"
              variant="outline"
            >
              {choiceLabel}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-40">
          {/* Plain items with their own tick, not the library's radio items:
              their indicator is always mounted, so every row would show one. */}
          {plannerQuickAddChoices.map((option) => (
            <DropdownMenuItem
              aria-checked={option === choice}
              key={option}
              role="menuitemradio"
              onClick={() => setChoice(option)}
            >
              {strings.horizon[option]}
              {option === choice && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
