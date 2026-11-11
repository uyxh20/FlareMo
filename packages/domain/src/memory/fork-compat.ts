import type { FlareMoDb } from "@flaremo/db";
import {
  type EmbeddingResourceType,
  type EmbeddingTaskOperation,
  insertEmbeddingTask as upstreamInsertEmbeddingTask,
} from "../embedding-outbox";
import type { UserPlanLimits } from "../limits";

// Fork-owned (docs/fork-customizations.md). Upstream removed the memory layer
// in v0.27 (the "memories" id prefix, memory vectors and the memory quota went
// with it). The fork keeps the layer; these three stand in for what the
// memory module used to import from upstream files, so those files stay
// upstream's.

/** A new id like `memories/<uuid>`, the shape every memory row already has. */
export function createResourceId(
  prefix: "memories" | "memos" | "attachments",
): string {
  return `${prefix}/${crypto.randomUUID()}`;
}

/**
 * The embedding outbox row the memory code queues. Since upstream v0.27 the
 * outbox only indexes entries: a `memory` row is claimed and finished without
 * work, so memories have no semantic vectors and recall uses fact keys,
 * keywords and relations. The row is still written (and still usable inside a
 * D1 batch), so turning memory vectors back on later is a processor change only.
 */
export function insertEmbeddingTask(
  db: FlareMoDb,
  input: {
    userId: string;
    resourceType: "memory" | "memo";
    resourceId: string;
    operation: EmbeddingTaskOperation;
    createdAt?: string;
  },
) {
  return upstreamInsertEmbeddingTask(db, {
    ...input,
    resourceType: input.resourceType as EmbeddingResourceType,
  });
}

/**
 * Upstream's memory-count quota. A self-hosted instance has no memory cap
 * (upstream dropped `maxMemoryItemsPerUser`), so there is nothing to check.
 */
export async function assertMemoryCountQuota(
  _db: FlareMoDb,
  _userLimits: UserPlanLimits | null | undefined,
  _userId: string,
  _additionalCount = 1,
): Promise<void> {}
