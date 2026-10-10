import type { PlannerGoalDto } from "@flaremo/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { plannerGoalBadge, plannerLinesAsChips } from "./goals-model";
import type { PlannerGoalsSearch } from "./goals-search";
import type { PlannerGoalsStrings } from "./goals-strings";

// Small pieces the Goals page and the weekly review share (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): badges, a row of choices, a goal's
// title and points, the number tiles and the breadcrumb.

const BADGE =
  "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap";

/** A small rounded label: neutral, or coloured for a result or a clash. */
export function PlannerBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "met" | "partial" | "missed" | "contested" | "brand";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        BADGE,
        tone === "neutral" && "border-border text-muted-foreground",
        tone === "met" && "border-success/40 text-success",
        tone === "partial" && "border-warning/50 text-warning",
        tone === "missed" && "border-destructive/40 text-destructive",
        tone === "contested" && "border-dashed border-warning/60 text-warning",
        tone === "brand" &&
          "border-brand-400/40 text-brand-600 dark:text-brand-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

const RESULT_MARK = { met: "✓", partial: "◐", missed: "✕" } as const;

/** The badge a goal wears for its status or result, with its note on hover. */
export function PlannerGoalStatusBadge({
  goal,
  strings,
}: {
  goal: Pick<PlannerGoalDto, "status" | "result" | "note">;
  strings: PlannerGoalsStrings;
}) {
  const badge = plannerGoalBadge(goal);
  if (!badge) return null;
  const body =
    badge.kind === "result" ? (
      <PlannerBadge tone={badge.result}>
        <span aria-hidden="true" className="text-[11px]">
          {RESULT_MARK[badge.result]}
        </span>
        {strings.result[badge.result]}
      </PlannerBadge>
    ) : (
      <PlannerBadge tone={badge.kind === "contested" ? "contested" : "neutral"}>
        {strings.status[badge.kind]}
      </PlannerBadge>
    );
  if (!goal.note) return body;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            className="inline-flex cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            type="button"
          >
            {body}
          </button>
        }
      />
      <TooltipContent className="max-w-72 whitespace-pre-line">
        {goal.note}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A row of mutually exclusive choices, each a toggle button. `value` is the
 * pressed one; pressing it again keeps it (a choice, not a switch).
 */
export function PlannerChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  label: string;
  /** The pressed choice, or null when none is. */
  value: T | null;
  options: ReadonlyArray<{ value: T; label: ReactNode; className?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn("flex min-w-0 flex-wrap gap-1.5", className)}
    >
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            "planner-tag inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:font-medium",
            "aria-pressed:border-foreground/70 aria-pressed:shadow-[inset_0_0_0_1px_var(--foreground)] disabled:cursor-default disabled:opacity-60",
            option.className,
          )}
          disabled={disabled}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/** A goal's title and its points: bullets, or chips when every point is short. */
export function PlannerGoalBody({
  goal,
  className,
}: {
  goal: Pick<PlannerGoalDto, "title" | "lines">;
  className?: string;
}) {
  const chips = plannerLinesAsChips(goal);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      {goal.title && (
        <p className="text-[15px] leading-snug font-semibold">{goal.title}</p>
      )}
      {goal.lines.length > 0 &&
        (chips ? (
          <div className="flex flex-wrap gap-1.5">
            {goal.lines.map((line, index) => (
              <span
                className="inline-flex h-[26px] items-center rounded-full border border-border bg-background px-2.5 text-[13px] whitespace-nowrap"
                // Lines have no ids; their order is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered list
                key={index}
              >
                {line.text}
              </span>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {goal.lines.map((line, index) => (
              <li
                className={cn(
                  "planner-bullet flex items-baseline gap-2.5 leading-snug",
                  line.struck && "text-muted-foreground",
                )}
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered list
                key={index}
              >
                {/* The note follows the text and wraps with it on a narrow card. */}
                <span className="min-w-0">
                  <span className={cn(line.struck && "line-through")}>
                    {line.text}
                  </span>
                  {line.note && (
                    <span className="ml-2 text-xs whitespace-nowrap text-warning">
                      {line.note}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** One number with its label, like "4.12 · Authenticity". */
export function PlannerTile({
  value,
  label,
  extra,
}: {
  value: ReactNode;
  label: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5">
      <div className="font-mono text-[22px] leading-tight font-medium tracking-tight tabular-nums sm:text-3xl">
        {value}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
        <span>{label}</span>
        {extra}
      </div>
    </div>
  );
}

/** Where the page is: "2026 › Q4 › October", each step but the last a link. */
export function PlannerCrumbs({
  items,
  label,
}: {
  items: ReadonlyArray<{ label: string; search?: PlannerGoalsSearch }>;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span className="inline-flex items-center gap-2" key={item.label}>
            {index > 0 && (
              <span aria-hidden="true" className="text-muted-foreground/60">
                ›
              </span>
            )}
            {last || !item.search ? (
              <span
                aria-current={last ? "page" : undefined}
                className="font-medium text-foreground"
              >
                {item.label}
              </span>
            ) : (
              <Link
                className="hover:text-foreground"
                search={item.search}
                to="/goals"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** A small section heading. */
export function PlannerSectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <h2 className="text-[15px] font-semibold">{children}</h2>
      {action}
    </div>
  );
}
