import {
  PLANNER_FLYWHEEL_MIN_SAMPLE,
  type PlannerFlywheelMetric,
  type PlannerFlywheelOrigin,
  type PlannerFlywheelResponse,
  type PlannerMetricWeekDto,
  plannerFlywheelHeadline,
  plannerFlywheelMetrics,
  plannerTuningNoteMax,
} from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  plannerFetchFlywheel,
  plannerSaveTuningNoteRequest,
  plannerSettleTuningRequest,
} from "./flywheel-api";
import {
  type PlannerFlywheelStrings,
  usePlannerFlywheelStrings,
} from "./flywheel-strings";
import { plannerQueryKeys } from "./query-keys";

// The weekly review's scorecard card (fork-owned add-on,
// docs/fork-flywheel.md), in Look back's side panel: three numbers on the
// agent's week against the week before, the one question "What should the
// agent do differently?", and, when there is one, a version four weeks on to
// keep or roll back. The "Proposed change to the agent" block and its
// "Suggest a change" button were removed at the owner's request (2026-11-12); the
// server routes stay, so a later change can bring them back. Nothing here
// changes the agent without the owner's press.

export type PlannerFlywheelTile = {
  metric: PlannerFlywheelMetric;
  label: string;
  /** "62%", or "too few (4)". */
  value: string;
  /** Whether `value` is a real number (else it reads muted). */
  shown: boolean;
  /** "8 of 13 · +6 vs last week", or "". */
  detail: string;
  /** The cases behind the value this week. */
  den: number;
};

function metricIn(
  week: PlannerMetricWeekDto | undefined,
  metric: PlannerFlywheelMetric,
  origin: PlannerFlywheelOrigin,
) {
  return week?.values.find(
    (value) => value.metric === metric && value.origin === origin,
  );
}

/** A metric's value as the card prints it. */
export function plannerFlywheelFormat(
  metric: PlannerFlywheelMetric,
  value: number,
): string {
  switch (plannerFlywheelMetrics[metric].unit) {
    case "share":
      return `${Math.round(value * 100)}%`;
    case "cents":
      return `$${(value / 100).toFixed(2)}`;
    default:
      return String(Math.round(value));
  }
}

/** The three headline numbers for the reviewed week, against the week before. */
export function plannerFlywheelTiles(
  response: PlannerFlywheelResponse,
  strings: PlannerFlywheelStrings,
): PlannerFlywheelTile[] {
  const [thisWeek, lastWeek] = [
    response.weeks.find((week) => week.week_start === response.week_start),
    response.weeks.find((week) => week.week_start < response.week_start),
  ];
  return plannerFlywheelHeadline.map(({ metric, origin }) => {
    const now = metricIn(thisWeek, metric, origin);
    const before = metricIn(lastWeek, metric, origin);
    const label = strings.metric[metric];
    const den = now?.den ?? 0;
    if (!now || now.value === null || den < PLANNER_FLYWHEEL_MIN_SAMPLE) {
      return {
        metric,
        label,
        value: strings.tooFew(den),
        shown: false,
        detail: "",
        den,
      };
    }
    const parts = [strings.outOf(now.num, now.den)];
    if (
      before &&
      before.value !== null &&
      before.den >= PLANNER_FLYWHEEL_MIN_SAMPLE
    ) {
      parts.push(
        strings.delta(Math.round(now.value * 100 - before.value * 100)),
      );
    }
    return {
      metric,
      label,
      value: plannerFlywheelFormat(metric, now.value),
      shown: true,
      detail: parts.join(" · "),
      den,
    };
  });
}

function Heading({ children }: { children: string }) {
  return (
    <h4 className="mb-1.5 text-sm font-semibold leading-snug">{children}</h4>
  );
}

function NoteBlock({
  response,
  strings,
  saving,
  onSave,
}: {
  response: PlannerFlywheelResponse;
  strings: PlannerFlywheelStrings;
  saving: boolean;
  onSave: (note: string | null) => void;
}) {
  const answered = response.note !== null || response.note_skipped;
  const [editing, setEditing] = useState(!answered);
  const [text, setText] = useState(response.note ?? "");
  useEffect(() => {
    setText(response.note ?? "");
    setEditing(response.note === null && !response.note_skipped);
  }, [response.note, response.note_skipped]);

  return (
    <div className="border-t border-border pt-3">
      <Heading>{strings.question}</Heading>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) onSave(text.trim());
          }}
        >
          <Textarea
            aria-label={strings.question}
            className="min-h-14 text-sm"
            data-testid="planner-flywheel-note"
            maxLength={plannerTuningNoteMax}
            placeholder={strings.notePlaceholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button disabled={saving || !text.trim()} size="sm" type="submit">
              {strings.save}
            </Button>
            <Button
              disabled={saving}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => onSave(null)}
            >
              {strings.skip}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-2 text-sm">
          <p className="min-w-0 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {response.note ?? (
              <span className="text-muted-foreground">{strings.skipped}</span>
            )}
          </p>
          <button
            className="flex-none cursor-pointer text-sm text-muted-foreground underline underline-offset-[3px] hover:text-foreground"
            type="button"
            onClick={() => setEditing(true)}
          >
            {strings.edit}
          </button>
        </div>
      )}
    </div>
  );
}

function VerdictBlock({
  response,
  strings,
  saving,
  onSettle,
}: {
  response: PlannerFlywheelResponse;
  strings: PlannerFlywheelStrings;
  saving: boolean;
  onSettle: (id: string, decision: "keep" | "roll_back") => void;
}) {
  const verdict = response.verdict;
  if (!verdict) return null;
  const print = (value: number | null, enough: boolean) =>
    value === null || !enough
      ? strings.tooFew(enough ? 0 : verdict.after_den)
      : plannerFlywheelFormat(verdict.metric, value);
  return (
    <div
      className="border-t border-border pt-3"
      data-testid="planner-flywheel-verdict"
    >
      <Heading>{strings.verdictTitle(verdict.tuning.version ?? 0)}</Heading>
      <p className="mb-2 text-sm text-muted-foreground">
        {strings.metric[verdict.metric]}
      </p>
      <div className="mb-2 grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-muted-foreground">{strings.before}</div>
          <div className="text-lg font-semibold tabular-nums">
            {print(verdict.before, true)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">{strings.after}</div>
          <div className="text-lg font-semibold tabular-nums">
            {print(
              verdict.after,
              verdict.after_den >= PLANNER_FLYWHEEL_MIN_SAMPLE ||
                plannerFlywheelMetrics[verdict.metric].unit !== "share",
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          disabled={saving}
          size="sm"
          onClick={() => onSettle(verdict.tuning.id, "keep")}
        >
          {strings.keep}
        </Button>
        <Button
          disabled={saving}
          size="sm"
          variant="outline"
          onClick={() => onSettle(verdict.tuning.id, "roll_back")}
        >
          {strings.rollBack}
        </Button>
      </div>
    </div>
  );
}

/** The card itself; `week` is the Monday of the week Look back reviews. */
export function PlannerFlywheelCard({
  week,
  today,
}: {
  week: string;
  today: string;
}) {
  const strings = usePlannerFlywheelStrings();
  const queryClient = useQueryClient();
  const key = plannerQueryKeys.flywheel(week);
  const query = useQuery({
    queryKey: key,
    queryFn: () => plannerFetchFlywheel(week, today),
    staleTime: 60_000,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (run: () => Promise<PlannerFlywheelResponse>) => run(),
    onMutate: () => setFailure(null),
    onSuccess: (response) => queryClient.setQueryData(key, response),
  });
  const run = (
    request: () => Promise<PlannerFlywheelResponse>,
    message = strings.failed,
  ) => mutation.mutate(request, { onError: () => setFailure(message) });

  const response = query.data;
  if (!response) return null;
  const saving = mutation.isPending;
  const tiles = plannerFlywheelTiles(response, strings);
  const nothingCounted = tiles.every((tile) => tile.den === 0);
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
      data-testid="planner-flywheel-card"
    >
      <h3 className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {strings.title}
      </h3>
      <dl className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <div className="min-w-0" key={tile.metric}>
            <dt className="text-sm leading-tight text-muted-foreground">
              {tile.label}
            </dt>
            <dd
              className={
                tile.shown
                  ? "text-xl font-semibold tabular-nums"
                  : "pt-1 text-sm text-muted-foreground"
              }
            >
              {tile.value}
            </dd>
            {tile.detail && (
              <dd className="text-xs leading-tight text-muted-foreground tabular-nums">
                {tile.detail}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {nothingCounted && (
        <p className="text-sm text-muted-foreground">{strings.noNumbers}</p>
      )}
      {response.proposing_paused && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-snug">
          {strings.paused}
        </p>
      )}
      <VerdictBlock
        response={response}
        saving={saving}
        strings={strings}
        onSettle={(id, decision) =>
          run(() => plannerSettleTuningRequest(week, id, decision))
        }
      />
      <NoteBlock
        response={response}
        saving={saving}
        strings={strings}
        onSave={(note) => run(() => plannerSaveTuningNoteRequest(week, note))}
      />
      {response.current ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">
            {strings.current(response.current.version ?? 0)}
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {response.current.instructions}
          </p>
        </details>
      ) : (
        <p className="text-sm text-muted-foreground">{strings.noCurrent}</p>
      )}
      {failure && (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
