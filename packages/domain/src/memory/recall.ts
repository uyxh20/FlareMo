import type { MemoryEvidenceDto } from "@flaremo/contracts";
import type { FlareMoDb, MemoryItemRow, UserRow } from "@flaremo/db";
import { memoryEvidence, memoryItems, memoryRelations } from "@flaremo/db";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { memoryEvidenceToDto } from "./dto";
import {
  buildFtsCondition,
  memoryLivenessCondition,
  searchFtsRanked,
} from "./shared";

export const MEMORY_DEFAULT_RECALL_LIMIT = 8;
export const MEMORY_MAX_RECALL_LIMIT = 50;
export const MEMORY_DEFAULT_BOOTSTRAP_MAX_ITEMS = 20;
export const MEMORY_BOOTSTRAP_CHAR_BUDGET = 6_000;
const MEMORY_RECALL_CANDIDATE_LIMIT = 50;

type MemoryScopeFilter = {
  projectKey?: string;
  workspaceKey?: string;
  agentName?: string;
  fromScope?: string;
};

export type RecallMemoriesInput = {
  query: string;
  agent?: string;
  projectKey?: string;
  workspaceKey?: string;
  fromScope?: string;
  factKey?: string;
  asOf?: string;
  types?: MemoryItemRow["type"][];
  kinds?: MemoryItemRow["kind"][];
  limit?: number;
  includeInferred?: boolean;
  includeSuperseded?: boolean;
};

export type RecallMemoriesDeps = {
  provider: import("../embedding").EmbeddingProvider;
  index: import("../embedding").VectorIndex;
  /** Scopes the vector query to one tenant inside a shared index. */
  namespace?: string;
};

function buildScopeFilter(user: UserRow, filter: MemoryScopeFilter) {
  const scopes: Array<SQL | undefined> = [eq(memoryItems.scopeType, "global")];
  if (filter.fromScope) {
    scopes.push(eq(memoryItems.scopeKey, filter.fromScope));
  }
  if (filter.projectKey) {
    scopes.push(
      and(
        eq(memoryItems.scopeType, "project"),
        eq(memoryItems.scopeKey, filter.projectKey),
      ),
    );
  }
  if (filter.workspaceKey) {
    scopes.push(
      and(
        eq(memoryItems.scopeType, "workspace"),
        eq(memoryItems.scopeKey, filter.workspaceKey),
      ),
    );
  }
  if (filter.agentName) {
    scopes.push(
      and(
        eq(memoryItems.scopeType, "agent"),
        eq(memoryItems.scopeKey, `agent:${filter.agentName}`),
      ),
    );
  }
  return and(eq(memoryItems.userId, user.id), or(...scopes.filter(Boolean)));
}

export async function recallMemories(
  db: FlareMoDb,
  user: UserRow,
  input: RecallMemoriesInput,
  deps?: RecallMemoriesDeps,
) {
  const scopeFilter = buildScopeFilter(user, {
    projectKey: input.projectKey,
    workspaceKey: input.workspaceKey,
    agentName: input.agent,
    fromScope: input.fromScope,
  });

  const nowIso = new Date().toISOString();
  const asOfTime = input.asOf ?? nowIso;

  const filters: SQL[] = scopeFilter ? [scopeFilter] : [];

  // Status & Bi-temporal validity filters (§VI.5)
  if (!input.includeSuperseded && !input.asOf) {
    filters.push(eq(memoryItems.status, "active"));
  } else {
    filters.push(
      or(
        eq(memoryItems.status, "active"),
        eq(memoryItems.status, "superseded"),
      ) as SQL,
    );
  }
  if (!input.includeInferred) {
    filters.push(eq(memoryItems.needsReview, false));
  }

  // Liveness (validity window + optional expiry) is defined once in shared.ts
  // so recall, bootstrap, and compile can never disagree about what is current.
  filters.push(memoryLivenessCondition(asOfTime));

  if (input.types?.length) {
    filters.push(inArray(memoryItems.type, input.types));
  }
  if (input.kinds?.length) {
    filters.push(inArray(memoryItems.kind, input.kinds));
  }

  const candidateMap = new Map<string, MemoryItemRow>();
  const matchPathsMap = new Map<
    string,
    Set<"fact_key" | "keyword" | "vector" | "relation">
  >();

  const addMatch = (
    row: MemoryItemRow,
    path: "fact_key" | "keyword" | "vector" | "relation",
  ) => {
    candidateMap.set(row.id, row);
    let paths = matchPathsMap.get(row.id);
    if (!paths) {
      paths = new Set();
      matchPathsMap.set(row.id, paths);
    }
    paths.add(path);
  };

  // --- Path A: Fact Key exact hit short-circuit (§VI.6) ---
  const targetFactKey =
    input.factKey ??
    (input.query.trim().includes(" ") ? undefined : input.query.trim());
  let factKeyHitRow: MemoryItemRow | null = null;
  if (targetFactKey) {
    const hit = await db
      .select()
      .from(memoryItems)
      .where(and(...filters, eq(memoryItems.factKey, targetFactKey)))
      .get();
    if (hit) {
      factKeyHitRow = hit;
      addMatch(hit, "fact_key");
    }
  }

  // --- Path B: SQLite FTS5 (Keyword search, bm25 relevance order) ---
  const ftsRankMap = new Map<string, number>();
  const ftsRanked = await searchFtsRanked(
    db,
    input.query,
    MEMORY_RECALL_CANDIDATE_LIMIT,
  );
  if (ftsRanked.length > 0) {
    const ftsIdOrder = ftsRanked.map((hit) => hit.memoryId);
    const ftsRows = await db
      .select()
      .from(memoryItems)
      .where(and(...filters, inArray(memoryItems.id, ftsIdOrder)));
    // Position in the bm25-ordered candidate list is the RRF rank; the rows
    // themselves are re-filtered through the same liveness/scope filters.
    const rankById = new Map(ftsRanked.map((hit) => [hit.memoryId, hit.rank]));
    ftsRows.forEach((row) => {
      const rank = rankById.get(row.id);
      if (rank !== undefined) {
        ftsRankMap.set(row.id, rank);
        addMatch(row, "keyword");
      }
    });
  } else {
    // Short / token-less queries: trigram FTS cannot help, fall back to a
    // LIKE filter whose ordering (recency) doubles as the RRF rank.
    const withText = buildFtsCondition(input.query);
    if (withText) {
      const ftsRows = await db
        .select()
        .from(memoryItems)
        .where(and(...filters, withText))
        .orderBy(desc(memoryItems.updatedAt), desc(memoryItems.id))
        .limit(MEMORY_RECALL_CANDIDATE_LIMIT);

      ftsRows.forEach((row, idx) => {
        ftsRankMap.set(row.id, idx + 1);
        addMatch(row, "keyword");
      });
    }
  }

  // --- Path C: Semantic Search (Cloudflare Vectorize) ---
  const vecRankMap = new Map<string, number>();
  if (deps) {
    try {
      const [queryVector] = await deps.provider.embed([input.query]);
      if (queryVector && queryVector.length > 0) {
        const matches = await deps.index.query(
          queryVector,
          MEMORY_RECALL_CANDIDATE_LIMIT,
          deps.namespace,
        );
        if (matches.length > 0) {
          const matchedIds = matches.map((m) => m.id);
          const vecRows = await db
            .select()
            .from(memoryItems)
            .where(and(...filters, inArray(memoryItems.id, matchedIds)));

          // Order vecRows according to match order
          const idToRow = new Map(vecRows.map((r) => [r.id, r]));
          let rank = 1;
          for (const match of matches) {
            const row = idToRow.get(match.id);
            if (row) {
              vecRankMap.set(row.id, rank++);
              addMatch(row, "vector");
            }
          }
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Semantic memory recall failed; continuing with hybrid",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // --- Path D: 1-Hop Relation Expansion (§VI.6) ---
  const relRankMap = new Map<string, number>();
  const topSeeds = Array.from(candidateMap.keys()).slice(0, 5);
  if (topSeeds.length > 0) {
    const relations = await db
      .select()
      .from(memoryRelations)
      .where(
        and(
          inArray(memoryRelations.memoryId, topSeeds),
          inArray(memoryRelations.type, ["supports", "depends_on", "part_of"]),
        ),
      )
      .limit(20);

    const relatedIds = Array.from(
      new Set(relations.map((r) => r.relatedMemoryId)),
    ).filter((id) => !candidateMap.has(id));

    if (relatedIds.length > 0) {
      const relatedRows = await db
        .select()
        .from(memoryItems)
        .where(and(...filters, inArray(memoryItems.id, relatedIds)));

      relatedRows.forEach((row, idx) => {
        relRankMap.set(row.id, idx + 1);
        addMatch(row, "relation");
      });
    }
  }

  // --- RRF (Reciprocal Rank Fusion) Scoring ---
  const k = 60;
  const wKw = 1.0;
  const wVec = 1.0;
  const wRel = 0.5;

  const authorityMultiplier: Record<MemoryItemRow["verification"], number> = {
    locked: 1.5,
    confirmed: 1.2,
    observed: 1.0,
    inferred: 0.8,
  };

  const scoredCandidates: Array<{
    row: MemoryItemRow;
    score: number;
    matchPaths: Array<"fact_key" | "keyword" | "vector" | "relation">;
    matchedBy: "fts" | "semantic" | "fact_key";
  }> = [];

  for (const [id, row] of candidateMap.entries()) {
    const paths = Array.from(matchPathsMap.get(id) ?? []);
    let matchedBy: "fts" | "semantic" | "fact_key" = "fts";
    if (paths.includes("fact_key")) matchedBy = "fact_key";
    else if (paths.includes("vector")) matchedBy = "semantic";

    // Fact key exact hit short-circuits to top with maximum score (§VI.6)
    if (factKeyHitRow && id === factKeyHitRow.id) {
      scoredCandidates.push({
        row,
        score: 100.0,
        matchPaths: paths,
        matchedBy,
      });
      continue;
    }

    let rrf = 0;
    const ftsRank = ftsRankMap.get(id);
    if (ftsRank !== undefined) {
      rrf += wKw / (k + ftsRank);
    }
    const vecRank = vecRankMap.get(id);
    if (vecRank !== undefined) {
      rrf += wVec / (k + vecRank);
    }
    const relRank = relRankMap.get(id);
    if (relRank !== undefined) {
      rrf += wRel / (k + relRank);
    }

    // Normalize RRF by base single-rank score (~0.01639)
    let score = rrf * 61.0;

    // Apply authority multiplier
    score *= authorityMultiplier[row.verification] ?? 1.0;

    // Decay ONLY for episodic memories; semantic facts NEVER decay (§VI.6).
    // The clock is `asOf`, not wall time: a time-travel query scores facts by
    // the same timeline its liveness filter uses.
    if (row.type === "episodic") {
      const referenceTime = Date.parse(asOfTime) || Date.now();
      const ageDays =
        (referenceTime - new Date(row.updatedAt).getTime()) / 86_400_000;
      const decay = Math.max(0.5, 1 - ageDays / 365);
      score *= decay;
    }

    // Secondary influence: importance & confidence
    score += (row.importance / 100) * 0.2 + (row.confidence / 100) * 0.1;

    // Negative constraints top-placement (§VI.7)
    if (row.kind === "constraint" && row.verification === "locked") {
      score += 2.0;
    }

    scoredCandidates.push({
      row,
      score,
      matchPaths: paths,
      matchedBy,
    });
  }

  // Sort descending by score
  scoredCandidates.sort((a, b) => b.score - a.score);

  const limit = Math.min(
    input.limit ?? MEMORY_DEFAULT_RECALL_LIMIT,
    MEMORY_MAX_RECALL_LIMIT,
  );
  const selected = scoredCandidates.slice(0, limit);

  // Access bookkeeping feeds the dormancy sink (§IV.5.4): "90 天未被召回"
  // needs to know when a memory was last answered, so every successful
  // recall stamps the rows it returned.
  if (selected.length > 0) {
    await db
      .update(memoryItems)
      .set({
        lastAccessedAt: nowIso,
        accessCount: sql`${memoryItems.accessCount} + 1`,
      })
      .where(
        inArray(
          memoryItems.id,
          selected.map((s) => s.row.id),
        ),
      );
  }

  // Load evidence for selected candidates (§VI.1)
  const selectedIds = selected.map((s) => s.row.id);
  const evidenceMap = new Map<string, MemoryEvidenceDto[]>();
  if (selectedIds.length > 0) {
    const evidenceRows = await db
      .select()
      .from(memoryEvidence)
      .where(inArray(memoryEvidence.memoryId, selectedIds));

    for (const ev of evidenceRows) {
      const list = evidenceMap.get(ev.memoryId) ?? [];
      list.push(memoryEvidenceToDto(ev));
      evidenceMap.set(ev.memoryId, list);
    }
  }

  return selected.map(({ row, score, matchPaths, matchedBy }) => ({
    id: row.id,
    content: row.content,
    type: row.type,
    kind: row.kind,
    scope: row.scopeType,
    scope_key: row.scopeKey,
    fact_key: row.factKey,
    tags: Array.isArray(row.tags) ? row.tags : [],
    tier: row.tier,
    verification: row.verification,
    importance: row.importance,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    source: row.sourceRef,
    source_agent: row.sourceAgent,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    score,
    matched_by: matchedBy,
    match_paths: matchPaths,
    evidence: evidenceMap.get(row.id) ?? [],
  }));
}

export async function bootstrapMemory(
  db: FlareMoDb,
  user: UserRow,
  input: {
    agent: string;
    projectKey?: string;
    workspaceKey?: string;
    maxItems?: number;
  },
) {
  const scopeFilter = buildScopeFilter(user, {
    projectKey: input.projectKey,
    workspaceKey: input.workspaceKey,
    agentName: input.agent,
  });

  const nowIso = new Date().toISOString();
  const rows = await db
    .select()
    .from(memoryItems)
    .where(
      and(
        scopeFilter,
        eq(memoryItems.status, "active"),
        eq(memoryItems.needsReview, false),
        sql`${memoryItems.verification} != 'inferred'`,
        memoryLivenessCondition(nowIso),
      ),
    )
    .orderBy(desc(memoryItems.updatedAt), desc(memoryItems.id));

  // Core memories and locked/confirmed constraints are the highest-value
  // bootstrap context; fill the remaining budget with recent lessons.
  const core = rows.filter((row) => row.tier === "core");
  const constraints = rows.filter(
    (row) =>
      row.kind === "constraint" &&
      (row.verification === "locked" || row.verification === "confirmed"),
  );
  const decisions = rows.filter(
    (row) =>
      row.kind === "decision" &&
      (row.verification === "locked" || row.verification === "confirmed"),
  );
  const rest = rows.filter(
    (row) =>
      row.tier !== "core" &&
      row.kind !== "constraint" &&
      row.kind !== "decision",
  );

  const maxItems = Math.min(
    input.maxItems ?? MEMORY_DEFAULT_BOOTSTRAP_MAX_ITEMS,
    MEMORY_DEFAULT_BOOTSTRAP_MAX_ITEMS,
  );
  const selected: MemoryItemRow[] = [];
  const seen = new Set<string>();
  const push = (row: MemoryItemRow) => {
    if (!seen.has(row.id) && selected.length < maxItems) {
      seen.add(row.id);
      selected.push(row);
    }
  };
  for (const group of [core, constraints, decisions, rest]) {
    group.sort(
      (a, b) => b.importance + b.confidence - (a.importance + a.confidence),
    );
    for (const row of group) push(row);
  }

  const items = selected.map((row) => ({
    id: row.id,
    content: row.content,
    type: row.type,
    kind: row.kind,
    scope: row.scopeType,
    scope_key: row.scopeKey,
    fact_key: row.factKey,
    tags: Array.isArray(row.tags) ? row.tags : [],
    tier: row.tier,
    verification: row.verification,
    importance: row.importance,
    source: row.sourceRef,
    source_agent: row.sourceAgent,
  }));

  let total = 0;
  const trimmed: typeof items = [];
  for (const item of items) {
    if (total + item.content.length > MEMORY_BOOTSTRAP_CHAR_BUDGET) break;
    total += item.content.length;
    trimmed.push(item);
  }

  return { items: trimmed };
}
