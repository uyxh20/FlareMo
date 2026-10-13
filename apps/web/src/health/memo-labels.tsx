import type { HealthEntryDto } from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Memo } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  healthDismissRequest,
  healthLoadMemoEntries,
  healthPatchEntryRequest,
} from "./api";
import { healthChipText, healthChipTitle } from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import "./health.css";

// The labels under a memo card (fork-owned add-on, docs/fork-health-tracker.md):
// small chips such as "Gym · Back", "Wim Hof · 10 min" and "Night out · Fri · home
// 03:30 · 1", each with an x that removes the label. A night out still waiting
// for its home time shows "home when?" and four buttons that answer it.
//
// Every card on a page asks for its labels in the same moment, and
// `healthLoadMemoEntries` sends those asks as ONE request. The query key carries
// the memo's update time, so a saved memo asks again by itself, and the server has
// already re-read it by the time the saved memo reaches the page.

/** What the card hands over: just enough to name the memo and notice an edit. */
type LabelMemo = Pick<Memo, "name" | "update_time" | "state">;

function useLabelWrites(memo: LabelMemo) {
  const queryClient = useQueryClient();
  const key = healthQueryKeys.memo(memo.name, memo.update_time);
  const settle = (next: (entries: HealthEntryDto[]) => HealthEntryDto[]) => {
    queryClient.setQueryData<HealthEntryDto[]>(key, (entries) =>
      next(entries ?? []),
    );
    // The strip and the page count the same rows.
    void queryClient.invalidateQueries({ queryKey: healthQueryKeys.stripAll });
    void queryClient.invalidateQueries({ queryKey: ["health", "week"] });
    void queryClient.invalidateQueries({ queryKey: ["health", "year"] });
  };
  const fail = () => toast.error(healthStrings.chip.failed);
  const answer = useMutation({
    mutationFn: (input: { id: string; homeAt: string }) =>
      healthPatchEntryRequest(input.id, { home_at: input.homeAt }),
    onSuccess: ({ entry }) =>
      settle((entries) => entries.map((e) => (e.id === entry.id ? entry : e))),
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => healthDismissRequest(id),
    onSuccess: ({ entry }) =>
      settle((entries) => entries.filter((e) => e.id !== entry.id)),
    onError: fail,
  });
  return { answer, dismiss };
}

function Chip({
  entry,
  busy,
  onDismiss,
}: {
  entry: HealthEntryDto;
  busy: boolean;
  onDismiss: () => void;
}) {
  const text = healthChipText(entry);
  return (
    <span
      className={cn(
        "health-chip inline-flex max-w-full items-center gap-0.5 rounded-full py-0.5 pr-1 pl-2.5 text-xs font-medium",
        `health-kind-${entry.kind}`,
      )}
      data-kind={entry.kind}
      data-testid="health-chip"
      title={healthChipTitle(entry)}
    >
      <span className="min-w-0 truncate">{text}</span>
      <button
        aria-label={healthStrings.chip.remove(text)}
        className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-70 outline-none after:absolute after:-inset-1.5 hover:bg-black/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none dark:hover:bg-white/15"
        disabled={busy}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

/** The four buttons that answer "home when?". */
export function HealthHomeAnswers({
  busy,
  onAnswer,
}: {
  busy: boolean;
  onAnswer: (homeAt: string) => void;
}) {
  return (
    <fieldset
      className="m-0 flex min-w-0 basis-full flex-wrap items-center gap-1.5 border-0 p-0"
      data-testid="health-home-answers"
    >
      <legend className="sr-only">{healthStrings.chip.homeWhen}</legend>
      {healthStrings.answers.map((answer) => (
        <Button
          disabled={busy}
          key={answer.homeAt}
          size="xs"
          type="button"
          variant="outline"
          onClick={(event) => {
            event.stopPropagation();
            onAnswer(answer.homeAt);
          }}
        >
          {answer.label}
        </Button>
      ))}
    </fieldset>
  );
}

export function HealthMemoLabels({ memo }: { memo: LabelMemo }) {
  const query = useQuery({
    queryKey: healthQueryKeys.memo(memo.name, memo.update_time),
    queryFn: () => healthLoadMemoEntries(memo.name),
    enabled: memo.state !== "trashed",
    staleTime: 5 * 60_000,
    // A failed label read must never become a storm of retries on every card.
    retry: false,
  });
  const { answer, dismiss } = useLabelWrites(memo);
  const entries = query.data ?? [];
  if (entries.length === 0) return null;
  const busy = answer.isPending || dismiss.isPending;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="health-labels"
    >
      {entries.map((entry) => (
        <Chip
          busy={busy}
          entry={entry}
          key={entry.id}
          onDismiss={() => dismiss.mutate(entry.id)}
        />
      ))}
      {entries
        .filter((entry) => entry.kind === "night_out" && entry.needs_check)
        .map((entry) => (
          <HealthHomeAnswers
            busy={busy}
            key={entry.id}
            onAnswer={(homeAt) => answer.mutate({ id: entry.id, homeAt })}
          />
        ))}
    </div>
  );
}
