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
    const { plannerAttachmentsToPurge, plannerFinishAttachmentPurge } =
      await import("@flaremo/domain/src/planner");
    let purged = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      const rows = await plannerAttachmentsToPurge(db, { now, limit: 100 });
      if (rows.length === 0) break;
      await env.ATTACHMENTS.delete(rows.map((row) => row.r2Key));
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
