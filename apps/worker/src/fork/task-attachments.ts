import type { AttachmentRow, FlareMoDb } from "@flaremo/db";
import type { PlannerTaskAttachmentRow } from "@flaremo/db/src/schema/planner";
import { attachmentObjectResponse } from "../attachment-http";
import type { FlareMoEnv } from "../env";

// The bucket side of files on cockpit tasks (fork-owned add-on,
// docs/fork-task-attachments.md): serving a file back, and the nightly sweep
// that deletes removed files' objects a week on. The rows are the domain's
// (packages/domain/src/planner/attachments.ts); this file is the only fork code
// that touches the ATTACHMENTS bucket.

/**
 * The file itself, with upstream's range, ETag and Content-Disposition
 * handling. Images, PDFs and plain text show inline (a screenshot opens in the
 * tab); everything else downloads. Undefined when the object is gone.
 */
export function forkTaskAttachmentResponse(input: {
  row: PlannerTaskAttachmentRow;
  bucket: R2Bucket;
  request: Request;
}) {
  // attachmentObjectResponse reads only the key, the name and the type; the
  // planner row has those three under the same names.
  const served = {
    r2Key: input.row.r2Key,
    filename: input.row.filename,
    contentType: input.row.contentType,
  } as AttachmentRow;
  return attachmentObjectResponse({
    attachment: served,
    bucket: input.bucket,
    cacheControl: "private, max-age=0, must-revalidate",
    inlineRequested: true,
    request: input.request,
  });
}

/** Where files dropped in a chat wait to be read (planner-attachments-api.ts). */
export const FORK_CHAT_FILE_PREFIX = "planner-chat/";
/** A chat file is read within seconds; one still there after a day was abandoned. */
const CHAT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How many removed files one night deletes at most (100 a batch). */
const MAX_PURGE_BATCHES = 10;

/**
 * The nightly sweep: files removed more than seven days ago, and files whose
 * task was purged, leave the bucket and the table. Batches of 100, like
 * upstream's attachment GC; a failure is logged and never stops the rest of
 * the night's work.
 */
export async function forkTaskAttachmentsNightly(
  env: FlareMoEnv,
  db: FlareMoDb,
  now: Date,
): Promise<void> {
  try {
    const {
      plannerAttachmentCopyKeys,
      plannerAttachmentsToPurge,
      plannerFinishAttachmentPurge,
    } = await import("@flaremo/domain/src/planner");
    let purged = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      const rows = await plannerAttachmentsToPurge(db, { now, limit: 100 });
      if (rows.length === 0) break;
      await env.ATTACHMENTS.delete(rows.map((row) => row.r2Key));
      // Each file's reading copy (audio, video, HEIC) goes with it; deleting
      // a key that was never written is harmless. R2 takes 1,000 keys a call.
      const copies = rows.flatMap((row) =>
        plannerAttachmentCopyKeys(row.r2Key),
      );
      for (let start = 0; start < copies.length; start += 1000) {
        await env.ATTACHMENTS.delete(copies.slice(start, start + 1000));
      }
      await plannerFinishAttachmentPurge(
        db,
        rows.map((row) => row.id),
      );
      purged += rows.length;
      if (rows.length < 100) break;
    }
    if (purged > 0) {
      console.log(JSON.stringify({ message: "Task files purged", purged }));
    }
    // Chat files never read (the page was closed mid-upload): gone after a day.
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PURGE_BATCHES; page++) {
      const listed = await env.ATTACHMENTS.list({
        prefix: FORK_CHAT_FILE_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const stale = listed.objects
        .filter(
          (object) =>
            now.getTime() - object.uploaded.getTime() > CHAT_FILE_MAX_AGE_MS,
        )
        .map((object) => object.key);
      if (stale.length > 0) await env.ATTACHMENTS.delete(stale);
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Task files sweep failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }
}
