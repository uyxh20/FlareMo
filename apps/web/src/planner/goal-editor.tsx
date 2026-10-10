import {
  type PlannerGoalDto,
  type PlannerGoalLevel,
  type PlannerGoalResult,
  type PlannerGoalStatus,
  type PlannerPillar,
  plannerGoalResults,
  plannerGoalStatuses,
  plannerPillars,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { plannerErrorMessage } from "./api";
import { plannerPillarClass } from "./goal-cards";
import {
  plannerCreateGoalRequest,
  plannerDeleteGoalRequest,
  plannerUpdateGoalRequest,
} from "./goals-api";
import { usePlannerGoalsStrings } from "./goals-strings";
import { PlannerChoice } from "./goals-ui";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// Writing a goal on the Goals page (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): its objective, a title, points under it
// (each with an optional short note, or struck through), its status, its result
// and a note. A new goal is created under the client's own UUID, so a retried save
// never makes two. Every planner query refreshes after a save: the Goals page,
// the review and the cockpit's goal cards all read goals.

/** What the editor is open on: a goal, or a new one at a level and period. */
export type PlannerGoalEditorTarget =
  | { kind: "edit"; goal: PlannerGoalDto }
  | {
      kind: "new";
      level: PlannerGoalLevel;
      periodStart: string | null;
      pillar: PlannerPillar | null;
    };

type Line = { text: string; note: string; struck: boolean };

const NO_PILLAR = "none";
const NO_RESULT = "none";

export function PlannerGoalEditor({
  target,
  onClose,
}: {
  target: PlannerGoalEditorTarget | null;
  onClose: () => void;
}) {
  const strings = usePlannerGoalsStrings();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target?.kind === "edit"
              ? strings.editor.editTitle
              : strings.editor.newTitle}
          </DialogTitle>
        </DialogHeader>
        {target && (
          <GoalForm
            key={target.kind === "edit" ? target.goal.id : "new"}
            target={target}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({
  target,
  onDone,
}: {
  target: PlannerGoalEditorTarget;
  onDone: () => void;
}) {
  const strings = usePlannerGoalsStrings();
  const cockpit = usePlannerStrings();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const ids = useId();
  const goal = target.kind === "edit" ? target.goal : null;
  const level = goal?.level ?? (target.kind === "new" ? target.level : "year");
  const northStar = level === "north_star";

  const [pillar, setPillar] = useState<PlannerPillar | null>(
    goal ? goal.pillar : target.kind === "new" ? target.pillar : null,
  );
  const [title, setTitle] = useState(goal?.title ?? "");
  const [lines, setLines] = useState<Line[]>(
    (goal?.lines ?? []).map((line) => ({
      text: line.text,
      note: line.note ?? "",
      struck: line.struck ?? false,
    })),
  );
  const [status, setStatus] = useState<PlannerGoalStatus>(
    goal?.status ?? "active",
  );
  const [result, setResult] = useState<PlannerGoalResult | null>(
    goal?.result ?? null,
  );
  const [note, setNote] = useState(goal?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanLines = lines
    .map((line) => ({
      text: line.text.trim(),
      note: line.note.trim(),
      struck: line.struck,
    }))
    .filter((line) => line.text)
    .map((line) => ({
      text: line.text,
      ...(line.note ? { note: line.note } : {}),
      ...(line.struck ? { struck: true } : {}),
    }));

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: plannerQueryKeys.all });

  const save = async () => {
    if (!title.trim() && cleanLines.length === 0) {
      setError(strings.editor.needsText);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (goal) {
        await plannerUpdateGoalRequest(goal.id, {
          ...(northStar ? {} : { pillar, status, result }),
          title: title.trim(),
          lines: cleanLines,
          note: note.trim() || null,
        });
      } else if (target.kind === "new") {
        await plannerCreateGoalRequest({
          id: crypto.randomUUID(),
          level: target.level,
          period_start: target.periodStart,
          ...(northStar ? {} : { pillar, status, result }),
          title: title.trim(),
          lines: cleanLines,
          note: note.trim() || null,
        });
      }
      await refresh();
      toast.success(strings.editor.saved);
      onDone();
    } catch (failure) {
      toast.error(
        plannerErrorMessage(
          failure,
          strings.editor.saveFailed,
          cockpit.toast.rateLimited,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!goal) return;
    setBusy(true);
    try {
      await plannerDeleteGoalRequest(goal.id);
      await refresh();
      toast.success(strings.editor.deleted);
      onDone();
    } catch (failure) {
      toast.error(
        plannerErrorMessage(
          failure,
          strings.editor.saveFailed,
          cockpit.toast.rateLimited,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line, at) => (at === index ? { ...line, ...patch } : line)),
    );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!northStar && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {strings.editor.objective}
          </span>
          <PlannerChoice
            label={strings.editor.objective}
            options={[
              ...plannerPillars.map((value) => ({
                value,
                className: plannerPillarClass(value),
                label: (
                  <>
                    <i aria-hidden="true" className="planner-dot" />
                    {strings.pillarShort[value]}
                  </>
                ),
              })),
              { value: NO_PILLAR, label: strings.noPillar },
            ]}
            value={pillar ?? NO_PILLAR}
            onChange={(value) =>
              setPillar(value === NO_PILLAR ? null : (value as PlannerPillar))
            }
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`${ids}-title`}
        >
          {strings.editor.titleLabel}
        </label>
        <Textarea
          className="min-h-14"
          id={`${ids}-title`}
          maxLength={1000}
          placeholder={strings.editor.titlePlaceholder}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
          {strings.editor.lines}
        </legend>
        {lines.map((line, index) => (
          <div
            className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: the points are an ordered list without ids
            key={index}
          >
            <div className="flex items-center gap-1.5">
              <Input
                aria-label={strings.editor.lineText}
                className={line.struck ? "line-through" : undefined}
                maxLength={500}
                value={line.text}
                onChange={(event) =>
                  setLine(index, { text: event.target.value })
                }
              />
              <Button
                aria-label={strings.editor.removeLine}
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  setLines((current) => current.filter((_, at) => at !== index))
                }
              >
                <XIcon />
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <Input
                aria-label={strings.editor.lineNote}
                className="h-7 text-xs md:text-xs"
                maxLength={200}
                placeholder={strings.editor.lineNote}
                value={line.note}
                onChange={(event) =>
                  setLine(index, { note: event.target.value })
                }
              />
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  checked={line.struck}
                  className="size-3.5 accent-current"
                  type="checkbox"
                  onChange={(event) =>
                    setLine(index, { struck: event.target.checked })
                  }
                />
                {strings.editor.struck}
              </label>
            </div>
          </div>
        ))}
        <Button
          className="self-start"
          size="sm"
          type="button"
          variant="outline"
          onClick={() =>
            setLines((current) => [
              ...current,
              { text: "", note: "", struck: false },
            ])
          }
        >
          <PlusIcon data-icon="inline-start" />
          {strings.editor.addLine}
        </Button>
      </fieldset>

      {!northStar && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {strings.editor.statusLabel}
            </span>
            <PlannerChoice
              label={strings.editor.statusLabel}
              options={plannerGoalStatuses.map((value) => ({
                value,
                label: strings.status[value],
              }))}
              value={status}
              onChange={setStatus}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {strings.editor.resultLabel}
            </span>
            <PlannerChoice
              label={strings.editor.resultLabel}
              options={[
                { value: NO_RESULT, label: strings.editor.noResult },
                ...plannerGoalResults.map((value) => ({
                  value,
                  label: strings.result[value],
                })),
              ]}
              value={result ?? NO_RESULT}
              onChange={(value) =>
                setResult(
                  value === NO_RESULT ? null : (value as PlannerGoalResult),
                )
              }
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`${ids}-note`}
        >
          {strings.editor.note}
        </label>
        <Textarea
          className="min-h-14"
          id={`${ids}-note`}
          maxLength={2000}
          placeholder={strings.editor.notePlaceholder}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter className="items-center sm:justify-between">
        {goal ? (
          confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">{strings.editor.deleteConfirm}</span>
              <Button
                disabled={busy}
                size="sm"
                type="button"
                variant="destructive"
                onClick={() => void remove()}
              >
                {strings.editor.delete}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              disabled={busy}
              type="button"
              variant="ghost"
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon data-icon="inline-start" />
              {strings.editor.delete}
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} type="submit">
            {strings.editor.save}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
