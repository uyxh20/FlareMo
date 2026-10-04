import type {
  CreateMemoryFromMemoInput,
  CreateMemoryInput,
  RememberInput,
} from "@flaremo/contracts";
import type { MemoryWriteInput } from "./shared";

export function createMemoryInputToWrite(
  input: CreateMemoryInput,
): MemoryWriteInput {
  return {
    content: input.content,
    factKey: input.fact_key ?? null,
    tags: input.tags ?? [],
    type: input.type,
    kind: input.kind,
    scopeType: input.scope_type,
    scopeKey: input.scope_key ?? null,
    tier: input.tier,
    importance: input.importance,
    confidence: 100,
    verification: input.lock ? "locked" : "confirmed",
    validFrom: input.valid_from ?? null,
    validTo: input.valid_to ?? null,
    observedAt: input.observed_at ?? null,
    expiresAt: input.expires_at ?? null,
    evidence: input.evidence?.map((e) => ({
      sourceType: e.source_type,
      sourceId: e.source_id,
      sourceRevision: e.source_revision,
      relationType: e.relation_type,
      observedAt: e.observed_at,
      excerpt: e.excerpt,
      metadata: e.metadata,
    })),
  };
}

export function createMemoryFromMemoInputToWrite(
  input: CreateMemoryFromMemoInput,
  fallbackContent: string,
): MemoryWriteInput {
  return {
    content: input.content ?? fallbackContent,
    factKey: input.fact_key ?? null,
    tags: input.tags ?? [],
    type: input.type,
    kind: input.kind,
    scopeType: input.scope_type,
    scopeKey: input.scope_key ?? null,
    tier: input.tier,
    importance: input.importance,
    confidence: 100,
    verification: input.lock ? "locked" : "confirmed",
    validFrom: input.valid_from ?? null,
    validTo: input.valid_to ?? null,
  };
}

export function rememberInputToWrite(input: RememberInput): MemoryWriteInput {
  return {
    content: input.content,
    factKey: input.fact_key ?? null,
    tags: input.tags ?? [],
    type: input.type,
    kind: input.kind,
    scopeType: input.scope_type,
    scopeKey: input.scope_key ?? null,
    tier: input.tier,
    importance: input.importance,
    confidence: input.confidence,
    verification: input.verification,
    sourceAgent: input.source_agent,
    sourceSession: input.source_session,
    sourceRef: input.source_ref,
    validFrom: input.valid_from ?? null,
    observedAt: input.observed_at ?? null,
    idempotencyKey: input.idempotency_key ?? null,
    evidence: input.evidence?.map((e) => ({
      sourceType: e.source_type,
      sourceId: e.source_id,
      sourceRevision: e.source_revision,
      relationType: e.relation_type,
      observedAt: e.observed_at,
      excerpt: e.excerpt,
      metadata: e.metadata,
    })),
  };
}
