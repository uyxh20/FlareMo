import type { FlareMoDb, UserRow } from "@flaremo/db";
import { memoryItems, memoryRejections, memos } from "@flaremo/db";
import { and, desc, eq, gt, gte, or, sql } from "drizzle-orm";
import {
  computeFingerprint,
  type MemoryActor,
  normalizeMemoryContent,
} from "./shared";
import { createMemory } from "./write";

export async function listRecentRejections(
  db: FlareMoDb,
  userId: string,
  days = 30,
) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .select()
    .from(memoryRejections)
    .where(
      and(
        eq(memoryRejections.userId, userId),
        gt(memoryRejections.createdAt, cutoff),
      ),
    )
    .orderBy(desc(memoryRejections.createdAt));
}

export async function isRejectedRecently(
  db: FlareMoDb,
  userId: string,
  factKey?: string | null,
  fingerprint?: string | null,
  days = 30,
): Promise<{ blocked: boolean; reason?: string }> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const conditions = [];
  if (factKey) {
    conditions.push(eq(memoryRejections.factKey, factKey));
  }
  if (fingerprint) {
    conditions.push(eq(memoryRejections.fingerprint, fingerprint));
  }
  if (conditions.length === 0) return { blocked: false };

  const rejection = await db
    .select()
    .from(memoryRejections)
    .where(
      and(
        eq(memoryRejections.userId, userId),
        gt(memoryRejections.createdAt, cutoff),
        or(...conditions),
      ),
    )
    .get();

  if (rejection) {
    return {
      blocked: true,
      reason:
        rejection.reason ??
        "This fact or topic was recently rejected by the user.",
    };
  }
  return { blocked: false };
}

/**
 * Imperative-language detector (§VI.8, v2.4): instruction-style sentences
 * ("always do X", "记住要 Y", "ignore previous instructions") must never enter
 * the ledger without a human ruling — a persisted imperative is a
 * self-poisoning vector. Statement facts auto-apply; imperative phrasing
 * downgrades to a proposal.
 */
export function isImperativeContent(content: string): boolean {
  return /\b(?:always|never|must|must not|do not|don'?t|remember to|ignore (?:all )?(?:previous|prior)|make sure)\b|记住|务必|必须|严禁|不要|牢记|以后都|忽略(?:之前|以上)/iu.test(
    content,
  );
}

/** Auto-apply confidence floor: below it the system silently declines (§VI.8 v2.4). */
export const DREAMING_AUTO_APPLY_MIN_CONFIDENCE = 60;

export async function extractAndProposeDreamingFact(
  db: FlareMoDb,
  user: UserRow,
  candidate: {
    content: string;
    factKey?: string | null;
    tags?: string[];
    type?: "semantic" | "episodic" | "procedural";
    kind?: "preference" | "fact" | "decision" | "constraint" | "lesson";
    scopeType?: "global" | "workspace" | "project" | "agent";
    scopeKey?: string | null;
    sourceType: string;
    sourceId: string;
    sourceRevision?: string | null;
    excerpt?: string;
    confidence?: number;
    /** Always land in the review inbox (e.g. conflict-patrol findings must be ruled on before entering the projection). */
    forceProposal?: boolean;
  },
) {
  const content = normalizeMemoryContent(candidate.content);
  const type = candidate.type ?? "semantic";
  const kind = candidate.kind ?? "fact";
  const scopeType = candidate.scopeType ?? "global";
  const scopeKey = candidate.scopeKey ?? null;
  const confidence = candidate.confidence ?? 60;

  const fingerprint = await computeFingerprint(
    user,
    content,
    type,
    kind,
    scopeType,
    scopeKey,
  );

  // Negative feedback guardrail (§IV.5 & §VI.8)
  const guard = await isRejectedRecently(
    db,
    user.id,
    candidate.factKey,
    fingerprint,
    30,
  );
  if (guard.blocked) {
    return { proposed: false as const, reason: guard.reason };
  }

  // v2.4 routing (§VI.8): the funnel decides where a candidate lands so the
  // user never has to grade routine extractions.
  //   imperative phrasing / forceProposal → 💡 proposal (needs a human ruling)
  //   low confidence                      → created but flagged live_low_confidence
  //   otherwise                           → 👀 observed, live immediately
  const imperative = isImperativeContent(content);
  const agentActor: MemoryActor = {
    type: "agent",
    name: "dreaming",
  };
  const created = await createMemory(db, user, agentActor, {
    content,
    factKey: candidate.factKey ?? null,
    tags: candidate.tags ?? [],
    type,
    kind,
    scopeType,
    scopeKey,
    tier: "normal",
    importance: 50,
    confidence,
    verification:
      imperative || candidate.forceProposal ? "inferred" : "observed",
    sourceAgent: "dreaming",
    evidence: [
      {
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        sourceRevision: candidate.sourceRevision,
        relationType: "derived_from",
        excerpt: candidate.excerpt ?? content.slice(0, 300),
      },
    ],
  });

  // Label the route by where the row actually landed — createMemory itself can
  // downgrade to a proposal (human-asset key collision), not only the funnel.
  if (created.memory.verification === "inferred") {
    return {
      proposed: true as const,
      memory: created.memory,
      routed: "proposal" as const,
    };
  }
  if (confidence < DREAMING_AUTO_APPLY_MIN_CONFIDENCE) {
    // Low confidence should never reach this point from the cycle funnel (the
    // caller pre-filters), but a direct call with low confidence still must
    // not pretend the fact was applied. Surface the downgrade honestly.
    return {
      proposed: true as const,
      memory: created.memory,
      routed: "live_low_confidence" as const,
    };
  }
  return {
    proposed: true as const,
    memory: created.memory,
    routed: "live" as const,
  };
}

// --- Dreaming cycle (§VI.8): the daily offline extraction driver -------------

export type DreamingSource = {
  kind: "memo" | "episode";
  id: string;
  content: string;
  createdAt: string;
};

export type DreamingCandidate = {
  content: string;
  fact_key?: string | null;
  tags?: string[];
  type?: "semantic" | "episodic" | "procedural";
  kind?: "preference" | "fact" | "decision" | "constraint" | "lesson";
};

/**
 * The extractor turns raw L0/L1 text into candidate atomic facts. It is a
 * pluggable seam because extraction needs a language model; the deterministic
 * parts of Dreaming (scan window, quota, fingerprint dedup, negative-sample
 * guard, isolated storage) all live below this interface.
 */
export type DreamingExtractor = (
  sources: DreamingSource[],
  guardrailFactKeys: string[],
) => Promise<DreamingCandidate[]>;

/** Daily proposal cap (§IV.5.1): default five notes per day, configurable. */
export const DAILY_PROPOSAL_QUOTA_DEFAULT = 5;

/**
 * Proposals the user has not answered yet today. State is re-derived from
 * timestamps on every run, so a missed or doubled cron converges (§VI.11).
 */
export async function remainingProposalQuota(
  db: FlareMoDb,
  userId: string,
  now = new Date(),
  dailyLimit = DAILY_PROPOSAL_QUOTA_DEFAULT,
): Promise<number> {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, userId),
        eq(memoryItems.sourceAgent, "dreaming"),
        eq(memoryItems.verification, "inferred"),
        gte(memoryItems.createdAt, dayStart),
      ),
    )
    .get();
  const made = row?.n ?? 0;
  return Math.max(0, dailyLimit - made);
}

/**
 * The scan window (§VI.8): L0 entries (new memos) and L1 entries (new
 * checkpoints) since the last dreaming proposal. Anchoring at the newest
 * proposal keeps the window stateless — no cursor table, idempotent on
 * re-runs, and fingerprint dedup absorbs the overlap.
 */
export async function collectDreamingSources(
  db: FlareMoDb,
  user: UserRow,
  sinceIso: string,
  maxSources = 40,
): Promise<DreamingSource[]> {
  const memoRows = await db
    .select({
      id: memos.id,
      content: memos.content,
      createdAt: memos.createdAt,
    })
    .from(memos)
    .where(and(eq(memos.userId, user.id), gt(memos.createdAt, sinceIso)))
    .orderBy(desc(memos.createdAt))
    .limit(Math.ceil(maxSources / 2));

  const episodeRows = await db
    .select({
      id: memoryItems.id,
      content: memoryItems.content,
      createdAt: memoryItems.createdAt,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, user.id),
        eq(memoryItems.type, "episodic"),
        gt(memoryItems.createdAt, sinceIso),
      ),
    )
    .orderBy(desc(memoryItems.createdAt))
    .limit(Math.ceil(maxSources / 2));

  return [
    ...memoRows.map((row) => ({ ...row, kind: "memo" as const })),
    ...episodeRows.map((row) => ({ ...row, kind: "episode" as const })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type DreamingCycleResult = {
  sources: number;
  proposed: number;
  deferredByQuota: boolean;
  skipped: "no_new_sources" | null;
};

/**
 * One dreaming run: scan window → pluggable extraction → per-candidate funnel
 * (negative samples, fingerprint dedup, imperative→proposal, low-confidence
 * silent drop, live 👀 write). The quota slices the candidate list, so overflow
 * is deferred, not dropped.
 */
export async function runDreamingCycle(
  db: FlareMoDb,
  user: UserRow,
  extractor: DreamingExtractor,
  options: {
    now?: Date;
    proposalLimit?: number;
    maxSources?: number;
  } = {},
): Promise<DreamingCycleResult> {
  const now = options.now ?? new Date();
  const proposalLimit = options.proposalLimit ?? DAILY_PROPOSAL_QUOTA_DEFAULT;
  const maxSources = options.maxSources ?? 40;

  const lastProposal = await db
    .select({ createdAt: memoryItems.createdAt })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, user.id),
        eq(memoryItems.sourceAgent, "dreaming"),
      ),
    )
    .orderBy(desc(memoryItems.createdAt))
    .limit(1)
    .get();
  const sinceIso =
    lastProposal?.createdAt ??
    new Date(now.getTime() - 86_400_000).toISOString();

  const sources = await collectDreamingSources(db, user, sinceIso, maxSources);
  if (sources.length === 0) {
    return {
      sources: 0,
      proposed: 0,
      deferredByQuota: false,
      skipped: "no_new_sources",
    };
  }

  const quota = await remainingProposalQuota(db, user.id, now, proposalLimit);
  if (quota <= 0) {
    return {
      sources: sources.length,
      proposed: 0,
      deferredByQuota: true,
      skipped: null,
    };
  }

  // The negative-sample guardrail (§IV.5.3): recent rejections forbid their
  // fact keys outright and are also passed to the extractor as a prompt-level
  // guard so paraphrased attempts never reach the funnel in the first place.
  const recentRejections = await listRecentRejections(db, user.id, 30);
  const guardrailFactKeys = Array.from(
    new Set(
      recentRejections
        .map((rejection) => rejection.factKey)
        .filter((key): key is string => Boolean(key)),
    ),
  );

  const candidates = await extractor(sources, guardrailFactKeys);
  // The system pre-deletes junk (v2.4): imperative phrasing becomes a
  // proposal, everything else applies live as 👀 — so the *queue* only grows
  // from imperative phrasing and human-asset collisions, and the quota now
  // caps extraction volume rather than user traffic.
  let proposed = 0;
  for (const candidate of candidates.slice(0, quota)) {
    if (isImperativeContent(candidate.content)) continue;
    const result = await extractAndProposeDreamingFact(db, user, {
      content: candidate.content,
      factKey: candidate.fact_key ?? null,
      tags: candidate.tags ?? [],
      type: candidate.type ?? "semantic",
      kind: candidate.kind ?? "fact",
      scopeType: "global",
      scopeKey: null,
      sourceType: "memo",
      sourceId: "dreaming",
      excerpt: sources
        .slice(0, 3)
        .map((source) => source.content.slice(0, 200))
        .join("\n---\n"),
    });
    if (result.proposed) proposed += 1;
  }

  return {
    sources: sources.length,
    proposed,
    deferredByQuota: candidates.length > quota,
    skipped: null,
  };
}

/**
 * Weekly conflict patrol (§VI.8): sample human-endorsed facts and let an
 * extractor flag internal contradictions. It never edits — findings become
 * ordinary inferred proposals in the review inbox, keyed to the fact they
 * challenge so the acceptance flow supersedes correctly.
 */
export type DreamingConflict = {
  memoryId: string;
  content: string;
  reason: string;
};

export async function proposeDreamingConflicts(
  db: FlareMoDb,
  user: UserRow,
  detector: (
    facts: Array<{ id: string; content: string }>,
  ) => Promise<DreamingConflict[]>,
  options: { now?: Date; sampleSize?: number; maxFindings?: number } = {},
): Promise<number> {
  const sampleSize = options.sampleSize ?? 30;
  const maxFindings = options.maxFindings ?? 3;
  const facts = await db
    .select({
      id: memoryItems.id,
      content: memoryItems.content,
      factKey: memoryItems.factKey,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.userId, user.id),
        eq(memoryItems.status, "active"),
        or(
          eq(memoryItems.verification, "confirmed"),
          eq(memoryItems.verification, "locked"),
        ),
      ),
    )
    .orderBy(desc(memoryItems.updatedAt))
    .limit(sampleSize);
  if (facts.length < 2) return 0;

  const findings = (await detector(facts)).slice(0, maxFindings);
  let proposed = 0;
  for (const finding of findings) {
    const target = facts.find((fact) => fact.id === finding.memoryId);
    if (!target) continue;
    // Findings are keyed to the fact they challenge so the acceptance flow
    // supersedes it, and always land in the review inbox — a patrol finding is
    // an accusation against a human-endorsed fact, not a fact itself.
    const result = await extractAndProposeDreamingFact(db, user, {
      content: `${finding.content}（与既有事实冲突，提请仲裁）`,
      factKey: target.factKey ?? null,
      tags: [],
      type: "semantic",
      kind: "fact",
      scopeType: "global",
      scopeKey: null,
      sourceType: "other",
      sourceId: target.id,
      excerpt: target.content,
      forceProposal: true,
    });
    if (result.proposed) proposed += 1;
  }
  return proposed;
}
