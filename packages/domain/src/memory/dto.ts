import type {
  MemoryDto,
  MemoryEventDto,
  MemoryEvidenceDto,
  MemoryRejectionDto,
  MemoryRelationDto,
  MemoryResourceLinkDto,
  MemoryRevisionDto,
} from "@flaremo/contracts";
import type {
  MemoryItemRow,
  memoryEvents,
  memoryEvidence,
  memoryRejections,
  memoryRelations,
  memoryResourceLinks,
  memoryRevisions,
} from "@flaremo/db";

export function memoryToDto(
  row: MemoryItemRow,
  evidence?: MemoryEvidenceDto[] | unknown,
): MemoryDto {
  const safeEvidence = Array.isArray(evidence)
    ? (evidence as MemoryEvidenceDto[])
    : undefined;
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    kind: row.kind,
    scope_type: row.scopeType,
    scope_key: row.scopeKey,
    fact_key: row.factKey ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    tier: row.tier,
    verification: row.verification,
    status: row.status,
    importance: row.importance,
    confidence: row.confidence,
    needs_review: row.needsReview,
    review_reason: row.reviewReason,
    created_by_type: row.createdByType,
    source_agent: row.sourceAgent,
    source_session: row.sourceSession,
    source_ref: row.sourceRef,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    observed_at: row.observedAt ?? null,
    expires_at: row.expiresAt ?? null,
    superseded_by_id: row.supersededById ?? null,
    superseded_at: row.supersededAt ?? null,
    rejected_at: row.rejectedAt ?? null,
    access_count: row.accessCount,
    last_accessed_at: row.lastAccessedAt,
    embedding_status: row.embeddingStatus,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    evidence: safeEvidence,
  };
}

export function memoryRevisionToDto(
  row: typeof memoryRevisions.$inferSelect,
): MemoryRevisionDto {
  return {
    id: row.id,
    memory_id: row.memoryId,
    content: row.content,
    metadata_snapshot: row.metadataSnapshot,
    created_by_type: row.createdByType,
    created_by_agent: row.createdByAgent,
    created_at: row.createdAt,
  };
}

export function memoryRelationToDto(
  row: typeof memoryRelations.$inferSelect,
): MemoryRelationDto {
  return {
    memory_id: row.memoryId,
    related_memory_id: row.relatedMemoryId,
    type: row.type,
    created_at: row.createdAt,
  };
}

export function memoryResourceLinkToDto(
  row: typeof memoryResourceLinks.$inferSelect,
): MemoryResourceLinkDto {
  return {
    memory_id: row.memoryId,
    resource_type: row.resourceType,
    resource_ref: row.resourceRef,
    relation_type: row.relationType,
    metadata: row.metadata,
    created_at: row.createdAt,
  };
}

export function memoryEvidenceToDto(
  row: typeof memoryEvidence.$inferSelect,
): MemoryEvidenceDto {
  return {
    id: row.id,
    memory_id: row.memoryId,
    source_type: row.sourceType as MemoryEvidenceDto["source_type"],
    source_id: row.sourceId,
    source_revision: row.sourceRevision ?? null,
    relation_type: row.relationType as MemoryEvidenceDto["relation_type"],
    observed_at: row.observedAt ?? null,
    excerpt: row.excerpt ?? null,
    excerpt_hash: row.excerptHash ?? null,
    stale_at: row.staleAt ?? null,
    missing_at: row.missingAt ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.createdAt,
  };
}

export function memoryEventToDto(
  row: typeof memoryEvents.$inferSelect,
): MemoryEventDto {
  return {
    id: row.id,
    memory_id: row.memoryId,
    event_type: row.eventType as MemoryEventDto["event_type"],
    actor_type: row.actorType as MemoryEventDto["actor_type"],
    actor_name: row.actorName ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.createdAt,
  };
}

export function memoryRejectionToDto(
  row: typeof memoryRejections.$inferSelect,
): MemoryRejectionDto {
  return {
    id: row.id,
    scope_type: row.scopeType,
    scope_key: row.scopeKey ?? null,
    fact_key: row.factKey ?? null,
    rejected_content: row.rejectedContent,
    fingerprint: row.fingerprint,
    reason: row.reason ?? null,
    created_at: row.createdAt,
  };
}
