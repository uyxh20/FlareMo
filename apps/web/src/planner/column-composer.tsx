import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePlannerStrings } from "./strings";

// The inline composer a column's "+" opens (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): a card at the top of
// the column with a title field, where Notion puts its new card. Enter adds the
// task and keeps the composer open and focused for the next one, so a run of
// tasks is typed without touching the mouse. Esc closes it, and so does leaving
// the field while it is empty; a field with text in it stays, so a stray click
// elsewhere never throws a half-typed title away.
//
// The field empties and keeps focus the moment the request goes out, so the next
// task can be typed while the last one is still being saved. If the add fails the
// text comes back, unless something new was typed meanwhile.

export function PlannerColumnComposer({
  label,
  onSubmit,
  onClose,
}: {
  /** The field's name for a screen reader: "New task in Doing". */
  label: string;
  /** Adds the task. Resolves true when it was created. */
  onSubmit: (title: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const strings = usePlannerStrings();
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Ready to type the moment it opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    setTitle("");
    inputRef.current?.focus();
    void onSubmit(text).then((created) => {
      if (!created) setTitle((current) => (current === "" ? text : current));
    });
  };

  return (
    <Card
      className="gap-0 py-2 shadow-xs ring-brand-400/40 motion-safe:animate-rise"
      data-testid="planner-composer"
    >
      <CardContent className="flex flex-col gap-0.5 px-3">
        <Input
          aria-label={label}
          className="h-8 border-transparent bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          enterKeyHint="done"
          maxLength={2000}
          placeholder={strings.columnAdd.placeholder}
          ref={inputRef}
          value={title}
          onBlur={() => {
            if (title.trim() === "") onClose();
          }}
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
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          {strings.columnAdd.hint}
        </p>
      </CardContent>
    </Card>
  );
}
