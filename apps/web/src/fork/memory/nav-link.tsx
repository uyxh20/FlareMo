import { Link } from "@tanstack/react-router";
import { BrainIcon } from "lucide-react";
import { forkMemoryMessages } from "../memory-messages";

// The Memory link in the explorer sidebar (fork-owned,
// docs/fork-customizations.md). Upstream dropped it with the memory layer in
// v0.27. PlannerNavLink renders it after Health, so the explorer's file gains
// nothing for it. Styled like the planner links beside it.

const LINK_CLASS =
  "flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5";

export function ForkMemoryNavLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      activeProps={{
        className: "!bg-accent !text-accent-foreground font-medium",
      }}
      className={LINK_CLASS}
      onClick={onNavigate}
      to="/memory"
    >
      <BrainIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {forkMemoryMessages["memory.title"]}
      </span>
    </Link>
  );
}
