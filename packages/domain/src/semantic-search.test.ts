import { applyFlaremoMigrations, createDb, memos } from "@flaremo/db";
import { eq } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EmbeddingProvider,
  VectorIndex,
  VectorIndexInfo,
  VectorIndexMatch,
  VectorIndexVector,
} from "./embedding";
import { memoTeamNamespace, memoUserNamespace } from "./embedding";
import { createMemo } from "./memos";
import { semanticSearchMemos } from "./semantic-search";
import type { TeamViewer } from "./team-permissions";
import { createTeamMember, ensureTeamOwner } from "./test-support";

let mf: Miniflare;
let db: ReturnType<typeof createDb>;
let user: TeamViewer;

class FakeVectorIndex implements VectorIndex {
  vectors = new Map<string, VectorIndexVector>();
  matches: VectorIndexMatch[] = [];
  lastNamespace: string | undefined;
  namespaces: string[] = [];

  async query(
    _vector: number[],
    _topK: number,
    namespace?: string,
  ): Promise<VectorIndexMatch[]> {
    this.lastNamespace = namespace;
    if (namespace) this.namespaces.push(namespace);
    return this.matches;
  }
  async upsert(vectors: VectorIndexVector[]) {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
  }
  async getByIds(ids: string[]): Promise<VectorIndexVector[]> {
    return ids.flatMap((id) => {
      const vector = this.vectors.get(id);
      return vector ? [vector] : [];
    });
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.vectors.delete(id);
  }
  async describe(): Promise<VectorIndexInfo> {
    return { vectorCount: this.vectors.size, dimensions: 4 };
  }
}

const provider: EmbeddingProvider = {
  model: "test-model",
  dimensions: 4,
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0, 0]);
  },
};

describe("semanticSearchMemos", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-semantic-test" },
    });
    const database = await mf.getD1Database("DB");
    db = createDb(database);
    await applyFlaremoMigrations(database);
    user = await ensureTeamOwner(db);
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("returns re-checked D1 hits ordered by score", async () => {
    const a = await createMemo(db, user, {
      content: "关于日志方案的笔记",
      visibility: "private",
      source: "web",
    });
    const b = await createMemo(db, user, {
      content: "关于部署的笔记",
      visibility: "private",
      source: "web",
    });

    const index = new FakeVectorIndex();
    index.matches = [
      { id: `${b.id}#chunks/0`, score: 0.9 },
      { id: `${a.id}#chunks/0`, score: 0.6 },
    ];

    const hits = await semanticSearchMemos(
      db,
      user,
      { provider, index },
      "日志",
      10,
    );
    expect(hits.map((hit) => hit.id)).toEqual([b.id, a.id]);
  });

  it("drops hits for memos that are no longer indexable", async () => {
    const a = await createMemo(db, user, {
      content: "一条会被删除的笔记",
      visibility: "private",
      source: "web",
    });

    const index = new FakeVectorIndex();
    // The vector is stale — the memo was trashed after indexing.
    index.matches = [{ id: `${a.id}#chunks/0`, score: 0.8 }];
    await db.update(memos).set({ status: "trashed" }).where(eq(memos.id, a.id));

    const hits = await semanticSearchMemos(
      db,
      user,
      { provider, index },
      "删除",
      10,
    );
    expect(hits).toEqual([]);
  });

  it("scopes the vector query to the caller's namespace", async () => {
    const a = await createMemo(db, user, {
      content: "租户隔离测试",
      visibility: "private",
      source: "web",
    });
    const index = new FakeVectorIndex();
    index.matches = [{ id: `${a.id}#chunks/0`, score: 0.9 }];

    await semanticSearchMemos(
      db,
      user,
      { provider, index, namespaces: [user.id] },
      "租户",
      10,
    );
    expect(index.lastNamespace).toBe(user.id);
  });

  it("queries each namespace bucket and merges matches by best score", async () => {
    const a = await createMemo(db, user, {
      content: "个人笔记",
      visibility: "private",
      source: "web",
    });
    const b = await createMemo(db, user, {
      content: "团队笔记",
      visibility: "protected",
      source: "web",
    });
    const index = new FakeVectorIndex();
    index.matches = [
      { id: `${b.id}#chunks/0`, score: 0.7 },
      { id: `${a.id}#chunks/0`, score: 0.9 },
    ];

    const hits = await semanticSearchMemos(
      db,
      user,
      {
        provider,
        index,
        namespaces: [memoUserNamespace(user.id), memoTeamNamespace()],
      },
      "笔记",
      10,
    );
    expect(hits.map((hit) => hit.id)).toEqual([a.id, b.id]);
    // Both partitions are scanned; no implicit pool query.
    expect(index.namespaces).toEqual([
      memoUserNamespace(user.id),
      memoTeamNamespace(),
    ]);
  });

  it("returns team memos but never another member's private memo", async () => {
    const member = await createTeamMember(db, "Member");
    const privateMemo = await createMemo(db, user, {
      content: "owner private",
      visibility: "private",
      source: "web",
    });
    const teamMemo = await createMemo(db, user, {
      content: "owner team",
      visibility: "protected",
      source: "web",
    });
    const index = new FakeVectorIndex();
    index.matches = [
      { id: `${privateMemo.id}#chunks/0`, score: 0.95 },
      { id: `${teamMemo.id}#chunks/0`, score: 0.9 },
    ];

    const hits = await semanticSearchMemos(
      db,
      member,
      { provider, index },
      "owner",
      10,
    );

    expect(hits).toEqual([{ id: teamMemo.id, score: 0.9 }]);
    // Default (no explicit buckets) keeps a single pool-style query, matching
    // legacy deployments that have not adopted the partitioned layout.
    expect(index.namespaces).toEqual([]);
    expect(index.lastNamespace).toBeUndefined();
  });
});
