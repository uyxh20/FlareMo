import {
  type PlannerAgentActionDto,
  type PlannerAgentEditKey,
  type PlannerPillar,
  plannerAddDays,
  plannerColumns,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { healthStrings } from "@/health/strings";
import { cn } from "@/lib/utils";
import {
  type PlannerCardEdit,
  plannerCardProposed,
  plannerCardSet,
  plannerCardValue,
  plannerHealthKinds,
} from "./ask-card-edit-model";
import type { PlannerAskCopy } from "./ask-chat";
import { plannerDueLabel } from "./dates";
import { plannerFetchGoalsYear } from "./goals-api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// The fields of a proposal card (fork-owned add-on, docs/fork-general-agent.md,
// "Edit before Accept"): the proposed values drawn as small inline controls, so
// a nearly right proposal is fixed on the card and then accepted. Native
// controls in the app's own input styling (the same `Input` and `Select` as the
// rest of the app); the model that decides which keys an action takes and what
// counts as an edit is ask-card-edit-model.ts.

/** The edits of the open cards of one chat, by action id. */
export function usePlannerCardEdits() {
  const [edits, setEdits] = useState<Record<string, PlannerCardEdit>>({});
  return {
    edits,
    /** Sets values on one card; a value equal to the proposal is dropped. */
    set: (action: PlannerAgentActionDto, patch: PlannerCardEdit) =>
      setEdits((current) => {
        const next = plannerCardSet(action, current[action.id] ?? {}, patch);
        const { [action.id]: _gone, ...rest } = current;
        return Object.keys(next).length > 0
          ? { ...rest, [action.id]: next }
          : rest;
      }),
    reset: (id: string) =>
      setEdits((current) => {
        const { [id]: _gone, ...rest } = current;
        return rest;
      }),
  };
}

export type PlannerCardEditing = {
  edit: PlannerCardEdit;
  set: (patch: PlannerCardEdit) => void;
  reset: () => void;
  /** The weekly goals the goal picker offers. */
  goals: Array<{ id: string; label: string }>;
};

/**
 * The weekly goals a goal picker offers: this week's and next week's that are
 * not closed. Read only while a card that has a goal field is open.
 */
export function usePlannerGoalChoices(enabled: boolean, today: string) {
  const year = Number(today.slice(0, 4));
  const strings = usePlannerStrings();
  const query = useQuery({
    queryKey: plannerQueryKeys.goalsYear(year, today),
    queryFn: () => plannerFetchGoalsYear({ year, today }),
    enabled,
    staleTime: 60_000,
  });
  const data = query.data;
  if (!data) return [];
  const week = data.current_week;
  return data.goals
    .filter(
      (goal) =>
        goal.level === "week" &&
        goal.status !== "closed" &&
        goal.period_start !== null &&
        goal.period_start >= week &&
        goal.period_start <= plannerAddDays(week, 7),
    )
    .map((goal) => {
      const title = goal.title.trim() || goal.lines[0]?.text.trim() || "";
      return {
        id: goal.id,
        label:
          goal.period_start === week
            ? title
            : `${title} (${plannerDueLabel(goal.period_start ?? week, today, strings)})`,
      };
    });
}

const WIDTH = {
  column: "w-full min-[420px]:w-36",
  date: "w-full min-[420px]:w-40",
  goal: "w-full min-[420px]:w-64",
  spot: "w-full min-[420px]:w-52",
  short: "w-24",
  kind: "w-full min-[420px]:w-44",
} as const;

function Pick({
  label,
  value,
  onChange,
  width,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  width: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", width)}>
      <Select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </Select>
    </div>
  );
}

/** One field of a card: the control for `name`, or nothing when it has none. */
export function PlannerCardField({
  action,
  name,
  editing,
  copy,
  today,
}: {
  action: PlannerAgentActionDto;
  name: PlannerAgentEditKey;
  editing: PlannerCardEditing;
  copy: PlannerAskCopy;
  today: string;
}) {
  const strings = usePlannerStrings();
  const { edit, set } = editing;
  const value = plannerCardValue(action, edit, name);
  const text = typeof value === "string" ? value : "";
  const change = action.change;
  const label = (key: string) =>
    (copy.proposal.field as Record<string, string>)[key] ?? key;

  switch (name) {
    case "text":
      // A flagged entry: its own text, which the owner rewrites.
      return (
        <Textarea
          aria-label={copy.proposal.entryText}
          className="min-h-24 bg-background text-[13px] leading-relaxed"
          maxLength={20_000}
          rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
          value={text}
          onChange={(event) => set({ text: event.target.value })}
        />
      );
    case "lines": {
      const lines = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Textarea
          aria-label={copy.proposal.goalField.lines}
          className="min-h-16 bg-background text-[13px]"
          placeholder={copy.proposal.goalLinesPlaceholder}
          rows={Math.min(8, Math.max(2, lines.length + 1))}
          value={lines.join("\n")}
          onChange={(event) => set({ lines: event.target.value.split("\n") })}
        />
      );
    }
    case "note":
      return null;
    case "title":
      if (action.kind === "goal_change") {
        // The goal's title is the owner's words: empty for a new goal.
        return (
          <Input
            aria-label={copy.proposal.goalField.title}
            className="font-medium"
            maxLength={1000}
            placeholder={copy.proposal.goalTitlePlaceholder}
            value={text}
            onChange={(event) => set({ title: event.target.value })}
          />
        );
      }
      return (
        <Input
          aria-label={label("title")}
          className="font-medium"
          value={text}
          onBlur={() => {
            if (!text.trim())
              set({ title: plannerCardProposed(action, name) as string });
          }}
          onChange={(event) => set({ title: event.target.value })}
        />
      );
    case "column":
      return (
        <Pick
          label={label("column")}
          value={text}
          width={WIDTH.column}
          onChange={(next) => set({ column: next as never })}
        >
          {plannerColumns.map((column) => (
            <option key={column} value={column}>
              {(strings.column as Record<string, string>)[column]}
            </option>
          ))}
        </Pick>
      );
    case "due_at":
    case "start_date":
      return (
        <span className={cn("flex min-w-0 items-center gap-1", WIDTH.date)}>
          <Input
            aria-label={label(name)}
            type="date"
            value={text}
            onChange={(event) => {
              const next = event.target.value;
              if (next) set({ [name]: next });
              else if (action.kind === "task_new") set({ due_at: null });
            }}
          />
          {action.kind === "task_new" && name === "due_at" && text && (
            <button
              aria-label={copy.proposal.noDue}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              title={copy.proposal.noDue}
              type="button"
              onClick={() => set({ due_at: null })}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </span>
      );
    case "priority":
      return (
        <Pick
          label={label("priority")}
          value={text}
          width={WIDTH.column}
          onChange={(next) => set({ priority: next as never })}
        >
          {Object.entries(strings.priority).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </Pick>
      );
    case "effort":
      return (
        <Input
          aria-label={label("effort")}
          className="w-24"
          inputMode="decimal"
          min={0}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (event.target.value !== "" && next >= 0 && next <= 999) {
              set({ effort: next });
            }
          }}
        />
      );
    case "goal_id": {
      const current = typeof value === "string" ? value : "";
      const known = editing.goals.some((goal) => goal.id === current);
      const proposedTitle =
        typeof change.goal_title === "string"
          ? change.goal_title
          : copy.proposal.aGoal;
      return (
        <Pick
          label={label("goal_id")}
          value={current}
          width={WIDTH.goal}
          onChange={(next) => set({ goal_id: next === "" ? null : next })}
        >
          <option value="">{copy.proposal.noGoal}</option>
          {current && !known && (
            <option value={current}>{proposedTitle}</option>
          )}
          {editing.goals.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goal.label}
            </option>
          ))}
        </Pick>
      );
    }
    case "spot": {
      const original = plannerCardProposed(action, "column");
      const column = plannerCardValue(action, edit, "column");
      const anchor =
        typeof change.anchor_title === "string" ? change.anchor_title : "";
      const below = change.after_id !== undefined;
      const spot = typeof value === "string" ? value : "anchor";
      return (
        <Pick
          label={label("place")}
          value={spot}
          width={WIDTH.spot}
          onChange={(next) => set({ spot: next as never })}
        >
          {column === original && anchor && (
            <option value="anchor">
              {below
                ? copy.proposal.spotBelow(anchor)
                : copy.proposal.spotAbove(anchor)}
            </option>
          )}
          <option value="top">{copy.proposal.spotTop}</option>
          <option value="bottom">{copy.proposal.spotBottom}</option>
        </Pick>
      );
    }
    case "kind": {
      const kind = typeof value === "string" ? value : "";
      const variant = plannerCardValue(action, edit, "variant");
      const current = `${kind}:${typeof variant === "string" ? variant : ""}`;
      return (
        <Pick
          label={copy.proposal.healthKind}
          value={current}
          width={WIDTH.kind}
          onChange={(next) => {
            const [nextKind, nextVariant] = next.split(":");
            set({
              kind: nextKind as never,
              variant: nextVariant ? nextVariant : null,
              ...(nextKind === "night_out" ? { minutes: null } : {}),
            });
          }}
        >
          {plannerHealthKinds.map((entry) => (
            <option
              key={`${entry.kind}:${entry.variant ?? ""}`}
              value={`${entry.kind}:${entry.variant ?? ""}`}
            >
              {entry.variant
                ? `${copy.proposal.healthKinds[entry.kind]} · ${healthStrings.variant[entry.variant] ?? entry.variant}`
                : copy.proposal.healthKinds[entry.kind]}
            </option>
          ))}
        </Pick>
      );
    }
    case "variant": {
      // A fix: the variants of the row's own kind.
      const kind = String(change.row_kind ?? "");
      const options = plannerHealthKinds.filter(
        (entry) => entry.kind === kind && entry.variant,
      );
      return (
        <Pick
          label={copy.proposal.healthField.variant}
          value={text}
          width={WIDTH.column}
          onChange={(next) => set({ variant: next })}
        >
          {options.map((entry) => (
            <option key={entry.variant} value={entry.variant ?? ""}>
              {healthStrings.variant[entry.variant ?? ""] ?? entry.variant}
            </option>
          ))}
        </Pick>
      );
    }
    case "minutes": {
      const night = plannerCardValue(action, edit, "kind") === "night_out";
      if (night) return null;
      return (
        <span className="flex items-center gap-1">
          <Input
            aria-label={copy.proposal.healthField.minutes}
            className="w-20"
            inputMode="numeric"
            max={600}
            min={1}
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(event) => {
              const next = Math.round(Number(event.target.value));
              if (event.target.value !== "" && next >= 1 && next <= 600) {
                set({ minutes: next });
              }
            }}
          />
          <span className="text-xs text-muted-foreground">
            {copy.proposal.minutesUnit}
          </span>
        </span>
      );
    }
    case "day":
      return (
        <div className={cn("min-w-0", WIDTH.date)}>
          <Input
            aria-label={copy.proposal.healthField.day}
            type="date"
            value={text}
            onChange={(event) => {
              if (event.target.value) set({ day: event.target.value });
            }}
          />
        </div>
      );
    case "pillar":
      return (
        <Pick
          label={copy.proposal.goalField.pillar ?? "objective"}
          value={text}
          width={WIDTH.column}
          onChange={(next) => set({ pillar: next as PlannerPillar })}
        >
          {Object.entries(copy.proposal.pillar).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </Pick>
      );
    case "period_start": {
      const first = plannerWeekStartOf(today);
      const weeks = Array.from({ length: 9 }, (_, index) =>
        plannerAddDays(first, index * 7),
      );
      if (text && !weeks.includes(text)) weeks.push(text);
      return (
        <Pick
          label={copy.proposal.week}
          value={text}
          width={WIDTH.column}
          onChange={(next) => set({ period_start: next })}
        >
          {weeks.map((week) => (
            <option key={week} value={week}>
              {copy.proposal.weekOf(plannerDueLabel(week, today, strings))}
            </option>
          ))}
        </Pick>
      );
    }
    default:
      return null;
  }
}
