import type { PlannerHappened as PlannerHappenedDto } from "@flaremo/contracts";
import { PlannerPillarLabel } from "./goal-cards";
import type { PlannerGoalsStrings } from "./goals-strings";
import type { PlannerPeriodStrings } from "./period-strings";

// The review's audit trail (fork-owned, docs/planning-cockpit-goals-review.md
// and docs/planning-cockpit-period-review.md): what the review reads, counted,
// above its start button, and what happened under the recap, where every
// claim carries the owner's own words, found and checked by the server. The
// weekly Look back (review-page.tsx) and the month, quarter and year chapters
// (period-chat.tsx) show the same two blocks.

/** What the review reads, counted: "3 diary entries", "2 tasks done", ... */
export function PlannerReads({
  items,
  strings,
  testId,
}: {
  items: readonly string[];
  strings: PlannerPeriodStrings;
  testId: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2" data-testid={testId}>
      <span className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {strings.chat.reads}
      </span>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {items.map((item) => (
          <li
            className="rounded-[10px] border border-border bg-background px-3 py-2 text-sm tabular-nums"
            key={item}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlannerHappened({
  happened,
  dropped,
  label,
  strings,
  goalsStrings,
  testId = "planner-period-happened",
}: {
  happened: readonly PlannerHappenedDto[];
  dropped: number;
  label: string;
  strings: PlannerPeriodStrings;
  goalsStrings: PlannerGoalsStrings;
  testId?: string;
}) {
  return (
    <div
      className="flex max-w-[600px] flex-col gap-2 rounded-xl border border-border bg-background px-3.5 py-3"
      data-testid={testId}
    >
      <span className="text-[13px] font-semibold">
        {strings.chat.happened(label)}
      </span>
      {happened.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {strings.chat.nothingBacked}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {happened.map((entry) => (
            <li
              className="flex flex-col gap-0.5 leading-snug"
              key={`${entry.claim}:${entry.source_id}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                {entry.pillar && (
                  <PlannerPillarLabel
                    pillar={entry.pillar}
                    short
                    strings={goalsStrings}
                  />
                )}
                <span>{entry.claim}</span>
              </span>
              <span className="text-[12.5px] text-success">
                ✓ {entry.source_day} · {strings.chat.sources[entry.source]}:{" "}
                <q className="text-muted-foreground">{entry.quote}</q>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {strings.chat.dropped(dropped)}
        </p>
      )}
    </div>
  );
}
