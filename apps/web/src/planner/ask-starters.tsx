import {
  type PlannerAskStarter,
  type PlannerAskStartersResponse,
  plannerAskStarters,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  BrushCleaningIcon,
  CalendarSyncIcon,
  HeartPulseIcon,
  ListChecksIcon,
  ListTodoIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { plannerFetchAskStarters } from "./ask-api";
import type { PlannerAskCopy } from "./ask-chat";

// Ask my diary's starter buttons (fork-owned add-on, docs/fork-general-agent.md,
// "The starter buttons"): one-tap questions in an empty global chat. Replan my
// week and Tidy my backlog show the count the app finds without a model and
// hide when there is nothing to do; the diary-reading ones (to-dos, what I
// already did, the health log) carry no count. At most four show at once.

/** At most this many starter buttons show at once. */
export const PLANNER_ASK_STARTERS_SHOWN = 4;

/** Which buttons show, in order, with their labels. */
export function plannerAskStarterButtons(
  counts: PlannerAskStartersResponse | null,
  copy: PlannerAskCopy["starters"],
): Array<{ id: PlannerAskStarter; label: string }> {
  const replan = counts ? counts.overdue + counts.stuck : 0;
  const buttons: Array<{ id: PlannerAskStarter; label: string } | null> = [
    replan > 0
      ? {
          id: "replan",
          label: copy.replan(counts?.overdue ?? 0, counts?.stuck ?? 0),
        }
      : null,
    { id: "todos", label: copy.todos },
    { id: "done", label: copy.done },
    counts && counts.stale_backlog > 0
      ? { id: "backlog", label: copy.backlog(counts.stale_backlog) }
      : null,
    { id: "health", label: copy.health },
  ];
  return buttons
    .filter((button): button is { id: PlannerAskStarter; label: string } =>
      Boolean(button),
    )
    .slice(0, PLANNER_ASK_STARTERS_SHOWN);
}

const ICONS: Record<PlannerAskStarter, LucideIcon> = {
  todos: ListTodoIcon,
  done: ListChecksIcon,
  replan: CalendarSyncIcon,
  backlog: BrushCleaningIcon,
  health: HeartPulseIcon,
};

export function PlannerAskStarterButtons({
  copy,
  today,
  onAsk,
}: {
  copy: PlannerAskCopy;
  today: string;
  onAsk: (question: string) => void;
}) {
  const counts = useQuery({
    queryKey: ["planner", "ask", "starters", today],
    queryFn: () => plannerFetchAskStarters(today),
    staleTime: 0,
  });
  const buttons = plannerAskStarterButtons(counts.data ?? null, copy.starters);
  return (
    <fieldset
      aria-label={copy.starters.label}
      className="m-0 flex min-w-0 flex-col items-start gap-1.5 border-0 p-0"
      data-testid="planner-ask-starters"
    >
      {buttons.map(({ id, label }) => {
        const Icon = ICONS[id];
        return (
          <Button
            data-starter={id}
            key={id}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onAsk(plannerAskStarters[id])}
          >
            <Icon data-icon="inline-start" />
            {label}
          </Button>
        );
      })}
    </fieldset>
  );
}
