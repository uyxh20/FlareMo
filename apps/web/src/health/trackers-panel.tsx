import {
  type HealthTrackerColor,
  type HealthTrackerDraft,
  type HealthTrackerDto,
  type HealthTrackerMeasure,
  type HealthTrackerPreviewResponse,
  type HealthTrackerTestResponse,
  healthLocalMoment,
  healthNormaliseTrackerWord,
  healthTrackerColors,
  healthTrackerMeasures,
  type PlannerGoalDto,
} from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { plannerFetchGoalsYear } from "@/planner/goals-api";
import {
  healthArchiveTrackerRequest,
  healthCreateTrackerRequest,
  healthPreviewTrackerRequest,
  healthSaveTrackerRequest,
  healthTestTrackerRequest,
} from "./api";
import { healthDayShort } from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import { healthKindClass, useHealthTrackers } from "./trackers";

// The trackers panel on the Health page (fork-owned add-on,
// docs/fork-health-tracker.md, "Trackers"): the owner edits which words each
// tracker looks for, adds a tracker for a new habit, and links it to a goal.
// Targets live on the goal, not here. A change is previewed against the whole
// diary before it is applied; applying re-reads the diary on the server.

const t = healthStrings.trackers;

type Draft = {
  label: string;
  color: HealthTrackerColor;
  measure: HealthTrackerMeasure;
  words: string[];
  blocked: string[];
  goalId: string | null;
};

function draftOf(tracker: HealthTrackerDto | null): Draft {
  return {
    label: tracker?.label ?? "",
    color: tracker?.color ?? "green",
    measure: tracker?.measure ?? "days",
    words: tracker?.words ?? [],
    blocked: tracker?.blocked ?? [],
    goalId: tracker?.goal_id ?? null,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function wireDraft(
  tracker: HealthTrackerDto | null,
  draft: Draft,
): HealthTrackerDraft {
  return {
    id: tracker?.id,
    measure: draft.measure,
    words: draft.words,
    blocked: draft.blocked,
  };
}

// --- Small parts --------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function WordChips({
  words,
  kindClass,
  onRemove,
  dashed,
}: {
  words: readonly string[];
  kindClass?: string;
  onRemove?: (word: string) => void;
  dashed?: boolean;
}) {
  if (words.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {words.map((word) => (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full py-0.5 pl-2.5 font-mono text-xs",
            onRemove ? "pr-1" : "pr-2.5",
            dashed
              ? "border border-dashed border-border text-muted-foreground"
              : kindClass
                ? cn("health-word", kindClass)
                : "border border-border bg-background",
          )}
          data-testid="health-word"
          key={word}
        >
          {word}
          {onRemove && (
            <button
              aria-label={t.removeWord(word)}
              className="relative inline-flex size-4 items-center justify-center rounded-full opacity-70 outline-none after:absolute after:-inset-1.5 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              type="button"
              onClick={() => onRemove(word)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function WordAdder({
  placeholder,
  onAdd,
  testId,
}: {
  placeholder: string;
  onAdd: (word: string) => void;
  testId: string;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    const word = healthNormaliseTrackerWord(value);
    if (word.length >= 2 && word !== "#") onAdd(word);
    setValue("");
  };
  return (
    <div className="flex gap-1.5">
      <Input
        aria-label={placeholder}
        className="h-7 max-w-64 text-sm"
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
      />
      <Button size="sm" type="button" variant="outline" onClick={add}>
        {t.addButton}
      </Button>
    </div>
  );
}

function goalName(goal: PlannerGoalDto): string {
  const text = goal.title || goal.lines[0]?.text || "";
  const start = goal.period_start ?? "";
  const month = Number(start.slice(5, 7));
  const prefix =
    goal.level === "quarter"
      ? `Q${Math.floor((month - 1) / 3) + 1}`
      : goal.level === "month"
        ? healthDayShort(start).split(" ")[1]
        : start.slice(0, 4);
  return `${prefix} · ${text}`;
}

function GoalPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (goalId: string | null) => void;
}) {
  const today = healthLocalMoment(new Date()).day;
  const year = Number(today.slice(0, 4));
  const goals = useQuery({
    queryKey: ["health", "goals", year],
    queryFn: () => plannerFetchGoalsYear({ year, today }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const options = (goals.data?.goals ?? []).filter(
    (goal) =>
      (goal.level === "quarter" ||
        goal.level === "month" ||
        goal.level === "year") &&
      goal.status === "active" &&
      (goal.title || goal.lines[0]?.text),
  );
  return (
    <select
      aria-label={t.goal}
      className="h-7 max-w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/18 dark:bg-input/30"
      data-testid="health-goal-picker"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{t.noGoal}</option>
      {options.map((goal) => (
        <option key={goal.id} value={goal.id}>
          {goalName(goal)}
        </option>
      ))}
      {value && !options.some((goal) => goal.id === value) && (
        <option value={value}>{t.goal}</option>
      )}
    </select>
  );
}

function Tester({ draft, id }: { draft: Draft; id?: string }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<HealthTrackerTestResponse | null>(null);
  const wire = JSON.stringify({ text, draft });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wire` stands for text and draft.
  useEffect(() => {
    if (!text.trim() || draft.words.length === 0) {
      setResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      healthTestTrackerRequest(text, {
        id,
        measure: draft.measure,
        words: draft.words,
        blocked: draft.blocked,
      })
        .then((response) => live && setResult(response))
        .catch(() => live && setResult(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wire, id]);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3"
      data-testid="health-tester"
    >
      <Input
        aria-label={t.test}
        className="h-7 text-sm"
        placeholder={t.testPlaceholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {result && (
        <p className="text-xs" data-testid="health-test-result" role="status">
          {result.reason === "counted" ? (
            <>
              <span className="font-medium text-foreground">
                {t.testReason.counted}
              </span>
              <span className="text-muted-foreground">
                {" · "}
                {result.match}
                {result.minutes
                  ? ` · ${draft.measure === "hours" ? t.hours(result.minutes) : healthStrings.chip.minutes(result.minutes)}`
                  : ""}
                {" · "}
                {t.testDay(result.day_offset ?? 0)}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {t.testReason[result.reason]}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function PreviewResult({
  preview,
  kindClass,
}: {
  preview: HealthTrackerPreviewResponse;
  kindClass: string;
}) {
  const total = preview.added + preview.removed + preview.kept;
  return (
    <div
      className={cn("flex flex-col gap-2", kindClass)}
      data-testid="health-preview"
    >
      <span className="text-xs text-muted-foreground">
        {t.previewTitle(preview.memos)}
      </span>
      {total === 0 ? (
        <p className="text-sm">{t.previewNone}</p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="flex h-2 gap-0.5 overflow-hidden rounded-full"
          >
            {preview.added > 0 && (
              <i
                className="health-diff-added"
                style={{ flex: preview.added }}
              />
            )}
            {preview.removed > 0 && (
              <i
                className="health-diff-removed"
                style={{ flex: preview.removed }}
              />
            )}
            {preview.kept > 0 && (
              <i
                className="bg-muted-foreground/40"
                style={{ flex: preview.kept }}
              />
            )}
          </div>
          <p className="text-sm tabular-nums">
            {[
              preview.added > 0 && t.previewAdded(preview.added),
              preview.removed > 0 && t.previewRemoved(preview.removed),
              preview.kept > 0 && t.previewKept(preview.kept),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}

// --- The editor ----------------------------------------------------------------------

function Editor({
  tracker,
  trackers,
  onClose,
}: {
  /** null for a new tracker. */
  tracker: HealthTrackerDto | null;
  trackers: readonly HealthTrackerDto[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const initial = draftOf(tracker);
  const [draft, setDraft] = useState<Draft>(initial);
  const [testing, setTesting] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const builtin = tracker?.builtin ?? false;
  const kindClass = tracker
    ? healthKindClass(tracker.kind, trackers)
    : `health-kind-t-${draft.color}`;
  const liveClass = builtin ? kindClass : `health-kind-t-${draft.color}`;
  const dirty = !sameDraft(draft, initial);
  const problem =
    !builtin && !draft.label.trim()
      ? t.needsName
      : !builtin && draft.words.length === 0
        ? t.needsWord
        : null;

  const preview = useMutation({
    mutationFn: () => healthPreviewTrackerRequest(wireDraft(tracker, draft)),
    onError: () => toast.error(t.failed),
  });
  // Any edit makes a shown preview stale.
  const stamp = JSON.stringify(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every edit.
  useEffect(() => {
    preview.reset();
  }, [stamp]);

  const done = (created: number, removed: number) => {
    toast.success(t.saved(created, removed));
    void queryClient.invalidateQueries({ queryKey: healthQueryKeys.all });
    onClose();
  };
  const apply = useMutation({
    mutationFn: () => {
      if (builtin && tracker) {
        return healthSaveTrackerRequest(tracker.id, {
          words: draft.words,
          blocked: draft.blocked,
        });
      }
      const body = {
        label: draft.label.trim(),
        color: draft.color,
        measure: draft.measure,
        words: draft.words,
        blocked: draft.blocked,
        goal_id: draft.goalId,
      };
      return tracker
        ? healthSaveTrackerRequest(tracker.id, body)
        : healthCreateTrackerRequest(body);
    },
    onSuccess: (result) => done(result.rescan.created, result.rescan.removed),
    onError: () => toast.error(t.failed),
  });
  const archive = useMutation({
    mutationFn: () => healthArchiveTrackerRequest(tracker?.id ?? ""),
    onSuccess: (result) => done(result.rescan.created, result.rescan.removed),
    onError: () => toast.error(t.failed),
  });

  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const addTo = (field: "words" | "blocked", word: string) =>
    setDraft((current) => {
      const other = field === "words" ? "blocked" : "words";
      return {
        ...current,
        [field]: current[field].includes(word)
          ? current[field]
          : [...current[field], word],
        [other]: current[other].filter((existing) => existing !== word),
      };
    });
  const removeFrom = (field: "words" | "blocked", word: string) =>
    setDraft((current) => ({
      ...current,
      [field]: current[field].filter((existing) => existing !== word),
    }));

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border/60 bg-card/60 p-4",
        liveClass,
      )}
      data-testid="health-tracker-editor"
    >
      {builtin ? (
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="health-swatch size-2.5 rounded-full"
          />
          <span className="text-sm font-semibold">{tracker?.label}</span>
          <span className="text-xs text-muted-foreground">{t.builtin}</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field label={t.name}>
            <Input
              aria-label={t.name}
              className="h-7 w-48 text-sm"
              data-testid="health-tracker-name"
              maxLength={40}
              placeholder={t.newName}
              value={draft.label}
              onChange={(event) => set({ label: event.target.value })}
            />
          </Field>
          <Field label={t.color}>
            <div className="flex h-7 items-center gap-1.5">
              {healthTrackerColors.map((color) => (
                <button
                  aria-label={t.colorName(color)}
                  aria-pressed={draft.color === color}
                  className={cn(
                    "health-swatch size-5 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring/50",
                    `health-kind-t-${color}`,
                    draft.color === color && "ring-2 ring-foreground/70",
                  )}
                  key={color}
                  type="button"
                  onClick={() => set({ color })}
                />
              ))}
            </div>
          </Field>
          <Field label={t.counts}>
            <div className="inline-flex h-7 overflow-hidden rounded-lg border border-border">
              {healthTrackerMeasures.map((measure) => (
                <button
                  aria-pressed={draft.measure === measure}
                  className={cn(
                    "px-2.5 text-xs outline-none focus-visible:bg-muted",
                    draft.measure === measure
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  key={measure}
                  type="button"
                  onClick={() => set({ measure })}
                >
                  {t.measures[measure]}
                </button>
              ))}
            </div>
          </Field>
        </div>
      )}

      {builtin && tracker && (
        <Field label={t.fixedWords}>
          <WordChips dashed words={tracker.fixed_words} />
        </Field>
      )}

      <Field label={t.words}>
        <WordChips
          kindClass={liveClass}
          words={draft.words}
          onRemove={(word) => removeFrom("words", word)}
        />
        <WordAdder
          placeholder={t.addWord}
          testId="health-add-word"
          onAdd={(word) => addTo("words", word)}
        />
      </Field>

      <Field label={t.blocked}>
        <WordChips
          words={draft.blocked}
          onRemove={(word) => removeFrom("blocked", word)}
        />
        <WordAdder
          placeholder={t.addBlocked}
          testId="health-add-blocked"
          onAdd={(word) => addTo("blocked", word)}
        />
      </Field>

      {!builtin && (
        <Field label={t.goal}>
          <div className="flex flex-wrap items-center gap-2">
            <GoalPicker
              value={draft.goalId}
              onChange={(goalId) => set({ goalId })}
            />
            <span className="text-xs text-muted-foreground">{t.goalHint}</span>
          </div>
        </Field>
      )}

      {testing ? (
        <Tester draft={draft} id={tracker?.id} />
      ) : (
        <button
          className="self-start text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
          data-testid="health-open-tester"
          type="button"
          onClick={() => setTesting(true)}
        >
          {t.test}
        </button>
      )}

      {preview.data && (
        <PreviewResult kindClass={liveClass} preview={preview.data} />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        {tracker &&
          !builtin &&
          (confirmArchive ? (
            <span className="flex flex-wrap items-center gap-2 text-xs">
              {t.archiveConfirm}
              <Button
                disabled={archive.isPending}
                size="xs"
                type="button"
                variant="destructive"
                onClick={() => archive.mutate()}
              >
                {t.archiveYes}
              </Button>
              <Button
                size="xs"
                type="button"
                variant="ghost"
                onClick={() => setConfirmArchive(false)}
              >
                {t.cancel}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setConfirmArchive(true)}
            >
              {t.archive}
            </Button>
          ))}
        <span className="flex-1" />
        {problem && dirty && (
          <span className="text-xs text-muted-foreground">{problem}</span>
        )}
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          {t.cancel}
        </Button>
        {preview.data ? (
          <Button
            data-testid="health-apply"
            disabled={apply.isPending}
            size="sm"
            type="button"
            onClick={() => apply.mutate()}
          >
            {apply.isPending && (
              <Loader2Icon
                className="motion-safe:animate-spin"
                data-icon="inline-start"
              />
            )}
            {apply.isPending ? t.applying : t.apply}
          </Button>
        ) : (
          // Shown only once something changed, so an untouched panel stays calm.
          dirty && (
            <Button
              data-testid="health-preview-button"
              disabled={problem !== null || preview.isPending}
              size="sm"
              type="button"
              onClick={() => preview.mutate()}
            >
              {preview.isPending && (
                <Loader2Icon
                  className="motion-safe:animate-spin"
                  data-icon="inline-start"
                />
              )}
              {preview.isPending ? t.previewing : t.preview}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

// --- The panel ------------------------------------------------------------------------

export function HealthTrackersPanel() {
  const query = useHealthTrackers();
  const [open, setOpen] = useState<string | null>(null);
  const trackers = query.data?.trackers ?? [];
  if (!query.data) return null;
  const selected =
    open === "new"
      ? null
      : (trackers.find((tracker) => tracker.id === open) ?? null);
  return (
    <section
      className="flex flex-col gap-3 motion-safe:animate-rise"
      data-testid="health-trackers"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold tracking-tight">{t.title}</h2>
        <p className="text-xs text-muted-foreground">{t.hint}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {trackers.map((tracker) => (
          <button
            aria-pressed={open === tracker.id}
            className={cn(
              "health-chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              healthKindClass(tracker.kind, trackers),
              open === tracker.id && "ring-2 ring-[color:var(--k)]",
            )}
            data-testid="health-tracker-pill"
            key={tracker.id}
            type="button"
            onClick={() => setOpen(open === tracker.id ? null : tracker.id)}
          >
            <span
              aria-hidden="true"
              className="health-swatch size-2 rounded-full"
            />
            {tracker.label}
          </button>
        ))}
        <Button
          aria-pressed={open === "new"}
          data-testid="health-new-tracker"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setOpen(open === "new" ? null : "new")}
        >
          <PlusIcon data-icon="inline-start" />
          {t.add}
        </Button>
      </div>
      {open && (
        <Editor
          key={open}
          tracker={selected}
          trackers={trackers}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
