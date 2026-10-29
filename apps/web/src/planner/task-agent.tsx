import { PanelRightCloseIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { plannerEndAskRequest } from "./ask-api";
import {
  PlannerAskChat,
  type PlannerAskChatState,
  usePlannerAskCopy,
} from "./ask-chat";
import { usePlannerAskHold } from "./ask-store";

// A task's own agent drawer (fork-owned add-on, docs/fork-general-agent.md,
// "Proposing into tasks and the diary"): opened from the task panel's "Ask
// agent" button, it sits beside the task on a wide screen and under it on a
// phone. The chat is held from the task, so the agent reads that task first
// and proposes its changes as cards; an accepted card is the write, and the
// panel's fields follow. The conversation is the task's own, apart from Ask my
// diary's window: closing the drawer keeps it, "New chat" puts it down.

export function PlannerTaskAgent({
  taskId,
  onClose,
  className,
}: {
  taskId: string;
  onClose: () => void;
  className?: string;
}) {
  const copy = usePlannerAskCopy();
  // The Ask bubble would sit on this drawer's question box: it steps aside.
  usePlannerAskHold();
  const [state, setState] = useState<PlannerAskChatState>({
    conversation: null,
    fresh: false,
    draft: "",
  });

  const newChat = () => {
    if (state.conversation) {
      void plannerEndAskRequest(state.conversation).catch(() => {});
    }
    setState({ fresh: true, conversation: null, draft: "" });
  };

  return (
    <aside
      aria-label={copy.taskTitle}
      className={cn(
        "flex min-h-0 flex-col border-border bg-card",
        "max-md:h-[min(28rem,60dvh)] max-md:shrink-0 max-md:border-t",
        "md:w-[24rem] md:shrink-0 md:border-l",
        className,
      )}
      data-testid="planner-task-agent"
    >
      {/* Beside the task, the sheet's own close button sits over the drawer's
          top-right corner: the header leaves it room. */}
      <header className="flex items-center gap-1.5 border-b border-border py-2 pr-2 pl-4 md:pr-12">
        <span className="text-sm font-semibold">{copy.taskTitle}</span>
        <Button
          className="ml-auto"
          disabled={state.fresh}
          size="sm"
          variant="ghost"
          onClick={newChat}
        >
          {copy.newChat}
        </Button>
        <Button
          aria-label={copy.close}
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
        >
          <PanelRightCloseIcon />
        </Button>
      </header>
      <PlannerAskChat
        state={state}
        task={taskId}
        onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
      />
    </aside>
  );
}
