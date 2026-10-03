import type {
  CheckpointInput,
  MemoryRelationDto,
  MemoryRelationType,
  MemoryResourceLinkDto,
  MemoryResourceRelationType,
  MemoryResourceType,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { memoryItems, memoryRelations, memoryResourceLinks } from "@flaremo/db";
import { and, eq } from "drizzle-orm";
import { ConflictError } from "../errors";
import { createResourceId } from "../ids";
import type { QuotaScope } from "../quotas";
import { memoryRelationToDto, memoryResourceLinkToDto } from "./dto";
import {
  assertAgentCanMutate,
  type MemoryActor,
  requireMemory,
} from "./shared";
import { createMemory } from "./write";

export type LinkMemoryInput = {
  memoryId: string;
  relatedMemoryId?: string;
  relationType: MemoryRelationType;
  resourceType?: MemoryResourceType;
  resourceRef?: string;
  resourceRelationType: MemoryResourceRelationType;
};

export async function checkpointMemory(
  db: FlareMoDb,
  user: UserRow,
  actor: MemoryActor,
  input: CheckpointInput,
  scope?: QuotaScope,
) {
  const scopeKey = input.scope_key ?? input.project_key ?? null;
  const now = new Date().toISOString();
  const episode = await createMemory(
    db,
    user,
    actor,
    {
      content: input.summary,
      type: "episodic",
      kind: "event",
      scopeType: input.scope_type,
      scopeKey,
      tier: "normal",
      importance: 50,
      confidence: actor.type === "user" ? 100 : 50,
      verification: actor.type === "user" ? "confirmed" : "observed",
      sourceAgent: actor.type === "agent" ? actor.name : null,
    },
    scope,
  );

  if (episode.duplicate) {
    throw new ConflictError("This checkpoint already exists.");
  }

  const episodeId = episode.memory.id;
  const createdIds: string[] = [];

  for (const item of input.items) {
    const result = await createMemory(
      db,
      user,
      actor,
      {
        content: item.content,
        factKey: item.fact_key ?? null,
        tags: item.tags ?? [],
        type: item.type,
        kind: item.kind,
        scopeType: input.scope_type,
        scopeKey,
        tier: "normal",
        importance: item.importance,
        confidence: actor.type === "user" ? 100 : 50,
        verification: actor.type === "user" ? "confirmed" : "observed",
        sourceAgent: actor.type === "agent" ? actor.name : null,
        evidence: [
          {
            sourceType: "session",
            sourceId: episodeId,
            relationType: "derived_from",
            observedAt: now,
            excerpt: input.summary.slice(0, 500),
          },
        ],
      },
      scope,
    );
    const itemId = result.memory.id;
    createdIds.push(itemId);

    await db
      .insert(memoryRelations)
      .values({
        id: createResourceId("memories"),
        memoryId: itemId,
        relatedMemoryId: episodeId,
        userId: user.id,
        type: "part_of",
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  return {
    episode: episode.memory,
    items: createdIds,
  };
}

export async function linkMemory(
  db: FlareMoDb,
  user: UserRow,
  actor: MemoryActor,
  input: LinkMemoryInput,
) {
  const memory = await requireMemory(db, user, input.memoryId);
  assertAgentCanMutate(actor, memory);

  const relations: MemoryRelationDto[] = [];
  const resourceLinks: MemoryResourceLinkDto[] = [];

  if (input.relatedMemoryId) {
    const related = await requireMemory(db, user, input.relatedMemoryId);
    if (input.relationType === "supersedes") {
      assertAgentCanMutate(actor, related);
      await db
        .update(memoryItems)
        .set({ status: "superseded", updatedAt: new Date().toISOString() })
        .where(
          and(eq(memoryItems.id, related.id), eq(memoryItems.userId, user.id)),
        );
    }
    if (input.relationType === "contradicts" && actor.type === "agent") {
      // A contradiction is the agent's dispute channel: it queues the source
      // memory for user review without ever touching the disputed memory
      // itself — even a locked or confirmed one stays untouched and recallable.
      await db
        .update(memoryItems)
        .set({
          needsReview: true,
          reviewReason: "contradicts",
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(eq(memoryItems.id, memory.id), eq(memoryItems.userId, user.id)),
        );
    }
    const inserted = await db
      .insert(memoryRelations)
      .values({
        id: createResourceId("memories"),
        memoryId: memory.id,
        relatedMemoryId: related.id,
        userId: user.id,
        type: input.relationType,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) relations.push(memoryRelationToDto(inserted));
  }

  if (input.resourceType && input.resourceRef) {
    const inserted = await db
      .insert(memoryResourceLinks)
      .values({
        id: createResourceId("memories"),
        memoryId: memory.id,
        userId: user.id,
        resourceType: input.resourceType,
        resourceRef: input.resourceRef,
        relationType: input.resourceRelationType,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    resourceLinks.push(memoryResourceLinkToDto(inserted));
  }

  return { relations, resource_links: resourceLinks };
}
