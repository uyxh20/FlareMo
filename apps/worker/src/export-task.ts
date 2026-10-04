import type { DataTaskRow, FlareMoDb } from "@flaremo/db";
import {
  claimQueuedDataTask,
  failDataTask,
  getDataTaskById,
  getFlaremoUserById,
  streamExportData,
  updateDataTask,
} from "@flaremo/domain";
import type { FlareMoEnv } from "./env";

/**
 * Execute one export data task: claim the queued row, stream the owner's
 * data into R2 NDJSON chunks plus a manifest, and mark the task succeeded.
 *
 * The in-request path (queue-less deployments run it inline) and the
 * DATA_EXPORT_QUEUE / cron maintenance path share this executor so both
 * write identical artifacts and observe identical lifecycle semantics —
 * the design comment in index.ts's queue handler ("shares the same
 * idempotent executor") applies here the same way it does to member
 * removal. Only a `queued` row is claimed: a completed, failed, or actively
 * leased task returns undefined, which keeps queue redeliveries and doubled
 * sends as safe no-ops.
 */
export async function runDataExportTask(
  env: FlareMoEnv,
  db: FlareMoDb,
  taskId: string,
): Promise<DataTaskRow | undefined> {
  if (!(await claimQueuedDataTask(db, taskId))) return undefined;
  const task = await getDataTaskById(db, taskId);
  const user = task ? await getFlaremoUserById(db, task.userId) : undefined;
  if (!user) {
    await failDataTask(
      db,
      taskId,
      "export_owner_missing",
      "Export task owner not found",
    );
    return undefined;
  }

  const prefix = `exports/${taskId}`;
  const chunkKeys: Array<{
    kind: string;
    key: string;
    recordCount: number;
  }> = [];
  const attachmentRefs: Array<{
    id: string;
    filename: string;
    content_type: string | null;
    size: number;
  }> = [];

  await streamExportData(db, user, async (chunk) => {
    const sequence = chunkKeys.length + 1;
    const key = `${prefix}/data/${chunk.kind}-${String(sequence).padStart(4, "0")}.ndjson`;
    const recordCount =
      chunk.records.length > 0 ? chunk.records.split("\n").length : 0;
    await env.ATTACHMENTS.put(key, chunk.records, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    chunkKeys.push({ kind: chunk.kind, key, recordCount });
    if (chunk.kind === "attachments") {
      for (const line of chunk.records.split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as {
          id: string;
          filename: string;
          content_type: string | null;
          size: number;
        };
        attachmentRefs.push({
          id: record.id,
          filename: record.filename,
          content_type: record.content_type,
          size: record.size,
        });
      }
    }
    await updateDataTask(db, taskId, {
      phase: "writing",
      progressDone: chunkKeys.length,
      progressTotal: 5,
    });
  });

  const manifest = {
    format_version: 1,
    exported_at: new Date().toISOString(),
    counts: {
      memos: 0,
      attachments: attachmentRefs.length,
      relations: 0,
      shares: 0,
    },
    data_chunks: chunkKeys,
    attachments: attachmentRefs,
  };
  // Re-derive counts from chunk record counts for accuracy.
  for (const chunk of chunkKeys) {
    if (chunk.kind === "memos") manifest.counts.memos += chunk.recordCount;
    if (chunk.kind === "relations")
      manifest.counts.relations += chunk.recordCount;
    if (chunk.kind === "shares") manifest.counts.shares += chunk.recordCount;
  }
  const manifestKey = `${prefix}/manifest.json`;
  await env.ATTACHMENTS.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });

  return updateDataTask(db, taskId, {
    status: "succeeded",
    phase: "completed",
    manifestKey,
    progressDone: chunkKeys.length,
    progressTotal: chunkKeys.length,
    completedAt: new Date().toISOString(),
  });
}
