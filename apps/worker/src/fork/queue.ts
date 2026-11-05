import { createDb } from "@flaremo/db";
import type { FlareMoEnv } from "../env";

// The fork's messages on the Worker's queue (fork-owned add-on,
// docs/fork-task-attachments.md, "When a file is read"). Upstream's consumer
// takes {jobId} and {taskId}; a task file's read travels as
// {forkAttachmentRead: {userId, attachmentId}} on the same queue, so a long
// read gets the consumer's 15 minutes instead of the 30 seconds work may run
// after a response. This module stays light: the reader loads only when a
// batch holds a read.

/** Whether a queue body is one of the fork's (and not upstream's). */
export function forkIsQueueMessage(body: unknown): boolean {
  const read = (body as { forkAttachmentRead?: unknown } | null)
    ?.forkAttachmentRead as
    | { userId?: unknown; attachmentId?: unknown }
    | undefined;
  return (
    typeof read?.userId === "string" && typeof read?.attachmentId === "string"
  );
}

/** Runs the fork's messages of a batch. Never throws, so the batch still acks. */
export async function forkRunQueue(
  env: FlareMoEnv,
  bodies: unknown[],
): Promise<void> {
  if (bodies.length === 0) return;
  try {
    const { forkIsAttachmentReadMessage, forkQueueAttachmentReads } =
      await import("./attachment-read");
    await forkQueueAttachmentReads(
      env,
      createDb(env.DB),
      bodies.filter(forkIsAttachmentReadMessage),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fork queue messages failed",
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}
