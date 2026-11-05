import {
  type PlannerAgentActionDto,
  type PlannerAttachmentDto,
  type PlannerTaskDetailResponse,
  plannerAttachmentMaxBytesFor,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/lib/utils";
import {
  plannerDeleteAttachmentRequest,
  plannerErrorMessage,
  plannerPutAttachmentCopyRequest,
  plannerReadAttachmentRequest,
  plannerSetAttachmentSettingsRequest,
  plannerUploadAttachmentRequest,
} from "./api";
import { plannerMakeReadingCopy } from "./attachment-reading-copy";
import { plannerQueryKeys } from "./query-keys";
import { type PlannerStrings, usePlannerStrings } from "./strings";
import { plannerToastId } from "./use-planner-actions";

// What the task's files do, apart from how they look (fork-owned add-on,
// docs/fork-task-attachments.md): the panel's Attachments section and the
// task's agent chat both drop files through this hook, so a file dropped in
// the chat is the same upload, and the one cached detail shows it in both.

type Detail = PlannerTaskDetailResponse;

/** A file on its way up: shown dimmed at the end of a list. */
export type PlannerUploading = { key: number; name: string; size: number };

/** What happened to the file's reading, in the owner's words. */
export function plannerAttachmentState(
  attachment: Pick<PlannerAttachmentDto, "read_state" | "proposal">,
  copy: PlannerStrings["panel"]["attachments"],
): string {
  switch (attachment.read_state) {
    case "pending":
      return copy.state.reading;
    case "read":
      return attachment.proposal?.state === "accepted"
        ? copy.state.added
        : attachment.proposal?.state === "open"
          ? copy.state.proposed
          : copy.state.dismissed;
    case "failed":
      return copy.state.unreadable;
    case "capped":
      return copy.state.capped;
    case "skipped":
      return copy.state.skipped;
    default:
      return copy.stored;
  }
}

export function usePlannerAttachmentActions(taskId: string) {
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const [uploading, setUploading] = useState<PlannerUploading[]>([]);
  const serial = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const actions = useMemo(() => {
    const detailKey = plannerQueryKeys.detail(taskId);
    const current = () => queryClient.getQueryData<Detail>(detailKey);
    const setDetail = (update: (detail: Detail) => Detail) =>
      queryClient.setQueryData<Detail>(detailKey, (detail) =>
        detail ? update(detail) : detail,
      );
    const replace = (attachment: PlannerAttachmentDto) =>
      setDetail((detail) => ({
        ...detail,
        attachments: detail.attachments.map((entry) =>
          entry.id === attachment.id ? attachment : entry,
        ),
      }));
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.history(taskId),
      });
    };
    const fail = (error: unknown, fallback: string) =>
      toast.error(
        plannerErrorMessage(
          error,
          fallback,
          stringsRef.current.toast.rateLimited,
        ),
        { id: plannerToastId },
      );

    const uploadOne = async (file: File, key: number) => {
      try {
        // Audio, video and iPhone photos get a reading copy first (sound as
        // WAV parts, frames as JPEGs); the file is stored as it is, the copy
        // goes up beside it, then the first read is asked for. The row stays
        // dimmed as "uploading…" until all of it is done.
        const copy = await plannerMakeReadingCopy(file);
        const withCopy = Boolean(copy && copy.length > 0);
        let { attachment } = await (withCopy
          ? plannerUploadAttachmentRequest(taskId, file, { copyFollows: true })
          : plannerUploadAttachmentRequest(taskId, file));
        if (copy && withCopy) {
          try {
            for (const { part, blob } of copy) {
              await plannerPutAttachmentCopyRequest(attachment.id, part, blob);
            }
            attachment = (
              await plannerReadAttachmentRequest(attachment.id, { first: true })
            ).attachment;
          } catch {
            // Reading is not set up here, or a part failed: the file is
            // stored, and Read stays on offer.
          }
        }
        setDetail((detail) => ({
          ...detail,
          attachments: [...detail.attachments, attachment],
        }));
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.history(taskId),
        });
      } catch (error) {
        fail(error, stringsRef.current.toast.attachmentUploadFailed);
      } finally {
        setUploading((list) => list.filter((entry) => entry.key !== key));
      }
    };

    return {
      /** Checks each file here first, then uploads them one after another. */
      add: (files: readonly File[]) => {
        const copy = stringsRef.current.panel.attachments;
        const held = current()?.attachments.length ?? 0;
        let queued = 0;
        setUploading((list) => {
          queued = list.length;
          return list;
        });
        const accepted: { file: File; key: number }[] = [];
        for (const file of files) {
          // Audio and video may be 95 MB, everything else 10 MB.
          const max = plannerAttachmentMaxBytesFor({
            filename: file.name,
            contentType: file.type || null,
          });
          if (file.size > max) {
            toast.error(copy.tooLarge(file.name, formatBytes(max)), {
              id: plannerToastId,
            });
            continue;
          }
          if (held + queued + accepted.length >= plannerAttachmentsPerTask) {
            toast.error(copy.tooMany(plannerAttachmentsPerTask), {
              id: plannerToastId,
            });
            break;
          }
          serial.current += 1;
          accepted.push({ file, key: serial.current });
        }
        if (accepted.length === 0) return;
        setUploading((list) => [
          ...list,
          ...accepted.map(({ file, key }) => ({
            key,
            name: file.name,
            size: file.size,
          })),
        ]);
        for (const { file, key } of accepted) {
          queue.current = queue.current.then(() => uploadOne(file, key));
        }
      },

      remove: async (attachment: PlannerAttachmentDto) => {
        setDetail((detail) => ({
          ...detail,
          attachments: detail.attachments.filter(
            (entry) => entry.id !== attachment.id,
          ),
        }));
        try {
          await plannerDeleteAttachmentRequest(attachment.id);
          void queryClient.invalidateQueries({
            queryKey: plannerQueryKeys.history(taskId),
          });
        } catch (error) {
          refresh();
          fail(error, stringsRef.current.toast.attachmentRemoveFailed);
        }
      },

      /** Asks for the file to be read (again); the state turns to "reading…" at once. */
      read: async (attachment: PlannerAttachmentDto) => {
        replace({ ...attachment, read_state: "pending" });
        try {
          const response = await plannerReadAttachmentRequest(attachment.id);
          replace(response.attachment);
        } catch (error) {
          replace(attachment);
          fail(error, stringsRef.current.toast.attachmentReadFailed);
        }
      },

      /** A card under a file was accepted or dismissed. */
      settled: (attachmentId: string, action: PlannerAgentActionDto) =>
        setDetail((detail) => ({
          ...detail,
          attachments: detail.attachments.map((entry) =>
            entry.id === attachmentId
              ? { ...entry, proposal: action, action_id: action.id }
              : entry,
          ),
        })),

      /** The task's "Store only" switch, as `files_read`. */
      setFilesRead: async (filesRead: boolean) => {
        const before = current()?.files_read ?? true;
        setDetail((detail) => ({ ...detail, files_read: filesRead }));
        try {
          await plannerSetAttachmentSettingsRequest(taskId, filesRead);
        } catch (error) {
          setDetail((detail) => ({ ...detail, files_read: before }));
          fail(error, stringsRef.current.toast.attachmentSettingsFailed);
        }
      },

      /** Asks the server for the detail again (while a file is being read). */
      poll: () => void queryClient.invalidateQueries({ queryKey: detailKey }),
    };
  }, [queryClient, taskId]);

  return { actions, uploading };
}
