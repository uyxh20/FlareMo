import { XIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { plannerEndAskRequest } from "./ask-api";
import { PlannerAskChat, usePlannerAskCopy } from "./ask-chat";
import { plannerSetAsk, usePlannerAsk } from "./ask-store";

// Ask my diary's window (fork-owned add-on, docs/fork-general-agent.md): a
// small chat that opens from the bubble in the bottom-right corner, over
// whatever page is showing. The general agent answers from the owner's whole
// record and writes only what the owner accepts on a proposal card; an answer
// takes from a few seconds to a minute, and the chat asks every few seconds
// until it is in. The chat itself is ask-chat.tsx, shared with the task
// panel's agent drawer. Loaded only when the window first opens.

export function PlannerAskWindow() {
  const copy = usePlannerAskCopy();
  const ask = usePlannerAsk();

  const newChat = () => {
    if (ask.conversation) {
      void plannerEndAskRequest(ask.conversation).catch(() => {});
    }
    plannerSetAsk({ fresh: true, conversation: null, draft: "" });
  };

  // Escape closes the window, as it would a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") plannerSetAsk({ open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      aria-label={copy.title}
      className="fixed right-4 bottom-20 z-50 flex h-[min(560px,calc(100dvh-6rem))] w-[min(400px,calc(100vw-2rem))] sm:right-6 sm:bottom-22 sm:h-[min(560px,calc(100dvh-7rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      data-testid="planner-ask-window"
      role="dialog"
    >
      <header className="flex items-center gap-1.5 border-b border-border py-2 pr-2 pl-4">
        <span className="font-semibold">{copy.title}</span>
        <Button
          className="ml-auto"
          disabled={ask.fresh}
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
          onClick={() => plannerSetAsk({ open: false })}
        >
          <XIcon />
        </Button>
      </header>
      <PlannerAskChat
        state={{
          conversation: ask.conversation,
          fresh: ask.fresh,
          draft: ask.draft,
        }}
        onChange={plannerSetAsk}
      />
    </div>
  );
}
