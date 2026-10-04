import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  archiveMemory,
  confirmMemory,
  deleteMemory,
  type Memory,
  pinMemory,
  promoteMemoryToMemo,
  resolveProposal,
  restoreMemory,
  unpinMemory,
} from "@/api";
import { useI18n } from "@/i18n";
import type { TranslationKey } from "@/i18n/key";
import { errorMessage } from "@/lib/error";
import { stripResourceName } from "@/lib/utils";

/** Every write a single memory card can trigger from its menu or buttons. */
export type MemoryAction =
  | "confirm"
  | "reject"
  | "pin"
  | "unpin"
  | "archive"
  | "restore"
  | "promote"
  | "delete";

const SUCCESS_MESSAGE: Record<MemoryAction, TranslationKey> = {
  confirm: "toast.memoryConfirmed",
  reject: "toast.memoryRejected",
  pin: "toast.memoryLocked",
  unpin: "toast.memoryUnlocked",
  archive: "toast.memoryArchived",
  restore: "toast.memoryRestored",
  promote: "toast.saved",
  delete: "toast.memoryDeleted",
};

const FAILURE_MESSAGE: Record<MemoryAction, TranslationKey> = {
  confirm: "toast.memoryConfirmFailed",
  reject: "toast.memoryRejectFailed",
  pin: "toast.memoryLockFailed",
  unpin: "toast.memoryUnlockFailed",
  archive: "toast.memoryArchiveFailed",
  restore: "toast.memoryRestoreFailed",
  promote: "toast.memoryPromoteFailed",
  delete: "toast.memoryDeleteFailed",
};

function runMemoryAction(
  id: string,
  memory: Memory,
  action: MemoryAction,
): Promise<unknown> {
  switch (action) {
    case "confirm":
      // An inferred proposal is accepted through the proposal endpoint; a
      // confirmed memory is only re-confirmed.
      return memory.needs_review || memory.verification === "inferred"
        ? resolveProposal(id, { action: "accept" })
        : confirmMemory(id);
    case "reject":
      return resolveProposal(id, {
        action: "reject",
        rejection_reason: "user_rejected_in_inbox",
      });
    case "pin":
      return pinMemory(id);
    case "unpin":
      return unpinMemory(id);
    case "archive":
      return archiveMemory(id);
    case "restore":
      return restoreMemory(id);
    case "promote":
      return promoteMemoryToMemo(id);
    case "delete":
      return deleteMemory(id);
  }
}

/**
 * One mutation per card instead of one `useMutation` per action: a ledger page
 * of N cards used to hold 8N mutation observers, every one of them
 * re-subscribing on each render. The action travels as the mutation variable,
 * so callers ask "is *this* action the pending one?" through `variables`.
 */
export function useMemoryMutations(memory: Memory, onMutated: () => void) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const id = stripResourceName(memory.id, "memories");

  return useMutation({
    mutationFn: (action: MemoryAction) => runMemoryAction(id, memory, action),
    onSuccess: (_result, action) => {
      toast.success(t(SUCCESS_MESSAGE[action]));
      onMutated();
      if (action === "promote") {
        // The promoted fact became a memo, so the timeline's own caches are
        // now stale in addition to the memory list.
        for (const key of ["memos", "memo-stats", "tag-hierarchy"]) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }
    },
    onError: (error, action) =>
      toast.error(errorMessage(error, t(FAILURE_MESSAGE[action]))),
  });
}
