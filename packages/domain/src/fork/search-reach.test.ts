import { importBundleSchema } from "@flaremo/contracts";
import { applyFlaremoMigrations, createDb } from "@flaremo/db";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EmbeddingProvider,
  VectorIndex,
  VectorIndexMatch,
  VectorIndexVector,
} from "../embedding";
import { dispatchEmbeddingOutbox } from "../embedding-outbox";
import { importData } from "../import-export";
import { createMemory } from "../memory";
import { createMemo, updateMemo } from "../memos";
import type { TeamViewer } from "../team-permissions";
import { ensureTeamOwner } from "../test-support";

// Every way an entry or a memory gets into the app must also get it into
// search (fork-owned; docs/fork-data-sources.md, "Ways in").
//
// Search has two indexes. The keyword index (memos_fts, memory_fts) is kept by
// database triggers, so every insert reaches it. The semantic index lives in
// Vectorize and is fed by the embedding outbox: a write path reaches it only if
// it queues an embedding task. Each test writes through one path, runs the
// outbox against an in-memory index with a fake embedding model, and checks the
// row landed. Nothing leaves the test.
//
// `it.fails` marks a known gap: the test describes what should happen and is
// expected to fail today. When someone fixes the gap it starts passing, vitest
// reports that as a failure, and the fix is to change `it.fails` to `it`.

class MemoryIndex implements VectorIndex {
  store = new Map<string, VectorIndexVector>();
  async query(): Promise<VectorIndexMatch[]> {
    return [];
  }
  async upsert(vectors: VectorIndexVector[]) {
    for (const vector of vectors) this.store.set(vector.id, vector);
  }
  async getByIds(ids: string[]) {
    return ids.flatMap((id) => {
      const vector = this.store.get(id);
      return vector ? [vector] : [];
    });
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.store.delete(id);
  }
  async describe() {
    return { vectorCount: this.store.size, dimensions: 4 };
  }
  /** The memo or memory ids the index holds vectors for. */
  resources(key: "memo_id" | "memory_id"): string[] {
    return [...this.store.values()].map((vector) =>
      String((vector.metadata as Record<string, unknown> | undefined)?.[key]),
    );
  }
}

const provider: EmbeddingProvider = {
  model: "test-model",
  dimensions: 4,
  async embed(texts: string[]) {
    return texts.map((text, index) => [index, text.length, 0, 1]);
  },
};

let mf: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let db: ReturnType<typeof createDb>;
let owner: TeamViewer;
let memosIndex: MemoryIndex;
let memoriesIndex: MemoryIndex;

async function runOutbox() {
  await dispatchEmbeddingOutbox(db, { provider, memosIndex, memoriesIndex });
}

async function keywordHits(table: "memos_fts" | "memory_fts", word: string) {
  const column = table === "memos_fts" ? "memo_id" : "memory_id";
  const rows = await database
    .prepare(`SELECT ${column} AS id FROM ${table} WHERE ${table} MATCH ?`)
    .bind(word)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

const importOne = (memo: { name: string; content: string }) =>
  importData(
    db,
    owner,
    importBundleSchema.parse({
      version: 5,
      memos: [
        {
          ...memo,
          visibility: "private",
          state: "normal",
          pinned: false,
          payload: {},
          create_time: "2026-03-02T08:00:00.000Z",
        },
      ],
    }),
  );

describe("every way in reaches search", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "fork-search-reach-test" },
    });
    database = await mf.getD1Database("DB");
    db = createDb(database);
    await applyFlaremoMigrations(database);
    owner = await ensureTeamOwner(db);
    memosIndex = new MemoryIndex();
    memoriesIndex = new MemoryIndex();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("a new entry reaches both indexes", async () => {
    const memo = await createMemo(db, owner, {
      content: "Kayaking on the lake",
      visibility: "private",
      source: "web",
    });
    await runOutbox();
    expect(await keywordHits("memos_fts", "kayaking")).toEqual([memo.id]);
    expect(memosIndex.resources("memo_id")).toEqual([memo.id]);
  });

  it("an edited entry is indexed again with its new text", async () => {
    const memo = await createMemo(db, owner, {
      content: "First draft",
      visibility: "private",
      source: "web",
    });
    await runOutbox();
    memosIndex.store.clear();
    await updateMemo(db, owner, memo.id, { content: "Climbing gym tonight" });
    await runOutbox();
    expect(await keywordHits("memos_fts", "climbing")).toEqual([memo.id]);
    expect(memosIndex.resources("memo_id")).toEqual([memo.id]);
  });

  it("an imported entry reaches the keyword index", async () => {
    await importOne({ name: "memos/imported-kw", content: "Snorkeling trip" });
    expect(await keywordHits("memos_fts", "snorkeling")).toEqual([
      "memos/imported-kw",
    ]);
  });

  // Known gap: importData inserts memos without queueing an embedding task
  // (packages/domain/src/import-export/import-data.ts), and nothing sweeps
  // `not_indexed` rows later, so imported entries stay out of semantic search
  // until someone runs the admin "rebuild embeddings" action.
  it.fails("an imported entry reaches the semantic index", async () => {
    await importOne({ name: "memos/imported-sem", content: "Snorkeling trip" });
    await runOutbox();
    expect(memosIndex.resources("memo_id")).toEqual(["memos/imported-sem"]);
  });

  it("a memory the owner writes reaches both indexes", async () => {
    const created = await createMemory(
      db,
      owner,
      { type: "user" },
      {
        content: "Owner prefers swimming before work",
        type: "semantic",
        kind: "preference",
        scopeType: "global",
        scopeKey: null,
        tier: "normal",
        importance: 60,
        confidence: 90,
      },
    );
    await runOutbox();
    const id = created.memory.id;
    expect(await keywordHits("memory_fts", "swimming")).toEqual([id]);
    expect(memoriesIndex.resources("memory_id")).toEqual([id]);
  });
});
