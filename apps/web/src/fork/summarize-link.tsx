import { useQuery } from "@tanstack/react-query";
import { LinkIcon } from "lucide-react";
import type { Memo } from "@/api";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { getMemoResourceId } from "@/lib/memo";
import { plannerFetchAsk } from "@/planner/ask-api";
import { plannerSetAsk } from "@/planner/ask-store";
import { plannerQueryKeys } from "@/planner/query-keys";
import { usePlannerToday } from "@/planner/use-planner-clock";

// Fork add-on (docs/fork-link-summaries.md): the ⋯ menu's "Summarize link" on
// an entry holding a web address. It opens a new Ask my diary chat with the
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

/** The request the Ask chat opens with. */
export function forkSummarizeDraft(links: string[], entryId: string): string {
  const what = links.length === 1 ? links[0] : links.join("\n");
  return `Summarize the key points of ${links.length === 1 ? "this link" : "these links"} into a diary entry:\n${what}\n(From my entry ${entryId}.)`;
}

export function ForkSummarizeLinkMenuItem({ memo }: { memo: Memo }) {
  const today = usePlannerToday();
  const status = useQuery({
    queryKey: plannerQueryKeys.ask(null),
    queryFn: () => plannerFetchAsk(today, null),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const links = forkLinksIn(memo.content);
  if (!status.data?.enabled || links.length === 0) return null;
  return (
    <DropdownMenuItem
      onClick={() =>
        plannerSetAsk({
          open: true,
          fresh: true,
          conversation: null,
          draft: forkSummarizeDraft(links, getMemoResourceId(memo)),
        })
      }
    >
      <LinkIcon />
      {FORK_SUMMARIZE_LINK_LABEL}
    </DropdownMenuItem>
  );
}
