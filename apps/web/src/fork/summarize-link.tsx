import { useQuery } from "@tanstack/react-query";
import { LinkIcon, SparklesIcon } from "lucide-react";
import type { Memo } from "@/api";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { getMemoResourceId } from "@/lib/memo";
import { plannerFetchAsk } from "@/planner/ask-api";
import { plannerSetAsk } from "@/planner/ask-store";
import { plannerQueryKeys } from "@/planner/query-keys";
import { usePlannerToday } from "@/planner/use-planner-clock";

// Fork add-on (docs/fork-link-summaries.md): the ⋯ menu's "Summarize link" on
// an entry holding a web address, and the same button in the composer's
// toolbar for a link not saved yet. It opens a new Ask my diary chat with the
// request typed in, naming the entry, so the owner can add what to focus on
// before sending. The agent reads the link and proposes the summary as a card.
// Shown only where the general agent is set up (as the Ask bubble is).
//
// English only, like every fork add-on (see apps/web/src/health/strings.ts).

export const FORK_SUMMARIZE_LINK_LABEL = "Summarize link";

const LINK = /https?:\/\/[^\s<>"'`)\]]+/gi;

/** The web addresses in an entry, in order, without repeats; at most three. */
export function forkLinksIn(content: string): string[] {
  const found = (content.match(LINK) ?? []).map((raw) =>
    raw.replace(/[.,;:!?]+$/, ""),
  );
  return [...new Set(found)].slice(0, 3);
}

/** The request the Ask chat opens with; names the entry when there is one. */
export function forkSummarizeDraft(links: string[], entryId?: string): string {
  const what = links.length === 1 ? links[0] : links.join("\n");
  return `Summarize the key points of ${links.length === 1 ? "this link" : "these links"} into a diary entry:\n${what}${entryId ? `\n(From my entry ${entryId}.)` : ""}`;
}

/** Whether the general agent is set up (the Ask bubble's own query). */
function useAskEnabled(): boolean {
  const today = usePlannerToday();
  const status = useQuery({
    queryKey: plannerQueryKeys.ask(null),
    queryFn: () => plannerFetchAsk(today, null),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return status.data?.enabled === true;
}

function openSummarize(links: string[], entryId?: string) {
  plannerSetAsk({
    open: true,
    fresh: true,
    conversation: null,
    draft: forkSummarizeDraft(links, entryId),
  });
}

export const FORK_SUMMARIZE_NO_LINK = "Paste a link to summarize it";

/**
 * The composer toolbar's Summarize button (composer-toolbar.tsx renders it
 * last). Greyed out until the text holds a link; the draft stays in the
 * composer, so the owner can still save their own note with the link.
 */
export function ForkComposerSummarizeButton({
  content,
  disabled,
}: {
  content: string;
  disabled?: boolean;
}) {
  const enabled = useAskEnabled();
  if (!enabled) return null;
  const links = forkLinksIn(content);
  const label = links.length
    ? FORK_SUMMARIZE_LINK_LABEL
    : FORK_SUMMARIZE_NO_LINK;
  return (
    <Button
      aria-label={label}
      disabled={disabled || links.length === 0}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
      onClick={() => openSummarize(links)}
    >
      <SparklesIcon />
    </Button>
  );
}

export function ForkSummarizeLinkMenuItem({ memo }: { memo: Memo }) {
  const enabled = useAskEnabled();
  const links = forkLinksIn(memo.content);
  if (!enabled || links.length === 0) return null;
  return (
    <DropdownMenuItem
      onClick={() => openSummarize(links, getMemoResourceId(memo))}
    >
      <LinkIcon />
      {FORK_SUMMARIZE_LINK_LABEL}
    </DropdownMenuItem>
  );
}
