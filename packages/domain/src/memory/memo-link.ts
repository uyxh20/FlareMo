import type { MemoryDto } from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  memoryItems,
  memoryResourceLinks,
} from "@flaremo/db/src/schema/memory";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createMemo } from "../memos";
import type { QuotaScope } from "../quotas";
import { memoryToDto } from "./dto";
import { createResourceId } from "./fork-compat";
import {
  assertAgentCanMutate,
  type MemoryActor,
  type MemoryWriteInput,
  requireMemory,
} from "./shared";
import { createMemory } from "./write";

/**
 * Return the memories derived from or referencing a memo, ordered by most
 * recently updated. The memo page uses this to surface "related memories".
 */
export async function listMemoriesForMemo(
  db: FlareMoDb,
  user: UserRow,
  memoId: string,
): Promise<MemoryDto[]> {
  const links = await db
    .select()
    .from(memoryResourceLinks)
    .where(
      and(
        eq(memoryResourceLinks.userId, user.id),
        eq(memoryResourceLinks.resourceType, "memo"),
        eq(memoryResourceLinks.resourceRef, memoId),
      ),
    );

  const memoryIds = [...new Set(links.map((link) => link.memoryId))];
  if (memoryIds.length === 0) return [];

  const rows = await db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, user.id),
        inArray(memoryItems.id, memoryIds),
        sql`${memoryItems.status} != 'deleted'`,
      ),
    )
    .orderBy(desc(memoryItems.updatedAt));
  return rows.map(memoryToDto);
}

/**
 * Promote a memo's conclusion into a long-term memory, recording a
 * `derived_from` link back to the source memo.
 */
export async function createMemoryFromMemo(
  db: FlareMoDb,
  user: UserRow,
  actor: MemoryActor,
  input: MemoryWriteInput,
  memoId: string,
  scope?: QuotaScope,
) {
  const result = await createMemory(db, user, actor, input, scope);
  if (result.duplicate) {
    // The same conclusion already exists; still record the derivation link if
    // this exact memo is not already linked.
    await db
      .insert(memoryResourceLinks)
      .values({
        id: createResourceId("memories"),
        memoryId: result.memory.id,
        userId: user.id,
        resourceType: "memo",
        resourceRef: memoId,
        relationType: "derived_from",
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
    return result;
  }

  await db.insert(memoryResourceLinks).values({
    id: createResourceId("memories"),
    memoryId: result.memory.id,
    userId: user.id,
    resourceType: "memo",
    resourceRef: memoId,
    relationType: "derived_from",
    createdAt: new Date().toISOString(),
  });
  return result;
}

/**
 * Promote a memory back into a normal memo, recording a `promoted_to` link.
 * The source memory stays in place; the memo becomes the long-form version.
 */
export async function promoteMemoryToMemo(
  db: FlareMoDb,
  user: UserRow,
  actor: MemoryActor,
  memoryId: string,
  scope?: QuotaScope,
): Promise<{ memory: MemoryDto; memo: string }> {
  const memory = await requireMemory(db, user, memoryId);
  assertAgentCanMutate(actor, memory);

  const memo = await createMemo(
    db,
    user,
    {
      content: memory.content,
      visibility: "private",
      source: "memory",
    },
    scope,
  );

  await db.insert(memoryResourceLinks).values({
    id: createResourceId("memories"),
    memoryId: memory.id,
    userId: user.id,
    resourceType: "memo",
    resourceRef: memo.id,
    relationType: "promoted_to",
    createdAt: new Date().toISOString(),
  });

  return { memory: memoryToDto(memory), memo: memo.id };
}
