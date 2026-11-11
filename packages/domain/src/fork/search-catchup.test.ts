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
import { importData } from "../import-export";
import type { TeamViewer } from "../team-permissions";
import { ensureTeamOwner } from "../test-support";
import {
  CATCHUP_QUERY_BUDGET,
  runSearchCatchup,
  SEARCH_CATCHUP_BATCH,
} from "./search-catchup";

// The search catch-up (fork-owned): indexes a few `not_indexed` rows per run,
// stays under the Free plan's 50 D1 queries per invocation, and never lets one
// bad row block the rest. Fake model, in-memory index; nothing leaves the test.

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
  resources(key: "memo_id"): string[] {
    return [
      ...new Set(
        [...this.store.values()].map((vector) =>
          String(
            (vector.metadata as Record<string, unknown> | undefined)?.[key],
          ),
        ),
      ),
    ].sort();
  }
}

const provider: EmbeddingProvider = {
  model: "test-model",
  dimensions: 4,
  async embed(texts: string[]) {
    if (texts.some((text) => text.includes("BREAKS"))) {
      throw new Error("model refused");
    }
    return texts.map((text, index) => [index, text.length, 0, 1]);
  },
};

let mf: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let db: ReturnType<typeof createDb>;
let owner: TeamViewer;
let memosIndex: MemoryIndex;
let queries = 0;

const deps = () => ({ provider, memosIndex });

async function importEntries(entries: Array<[string, string]>) {
  await importData(
    db,
    owner,
    importBundleSchema.parse({
      version: 5,
      memos: entries.map(([name, content]) => ({
        name,
        content,
        visibility: "private",
        state: "normal",
        pinned: false,
        payload: {},
        create_time: "2026-03-02T08:00:00.000Z",
      })),
    }),
  );
}

async function statusOf(id: string) {
  const row = await database
    .prepare("SELECT embedding_status AS status FROM memos WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

describe("search catch-up", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "fork-search-catchup-test" },
    });
    database = await mf.getD1Database("DB");
    await applyFlaremoMigrations(database);
    // Count every D1 call the app makes: each prepared statement run and each
    // batch is one query against the per-invocation cap.
    queries = 0;
    const counted = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "prepare" || prop === "batch" || prop === "exec") {
          return (...args: unknown[]) => {
            if (prop !== "prepare") queries += 1;
            const out = (
              target[prop as keyof typeof target] as (
                ...a: unknown[]
              ) => unknown
            ).apply(target, args);
            if (prop !== "prepare") return out;
            return countStatement(out as object);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    db = createDb(counted as typeof database);
    owner = await ensureTeamOwner(db);
    memosIndex = new MemoryIndex();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("indexes a small batch per run until nothing is left", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `memos/old-${i}`);
    await importEntries(names.map((name) => [name, `Old entry ${name}`]));

    const first = await runSearchCatchup(db, deps());
    expect(first).toEqual({
      indexed: SEARCH_CATCHUP_BATCH,
      failed: 0,
      more: true,
    });
    expect(memosIndex.resources("memo_id")).toHaveLength(SEARCH_CATCHUP_BATCH);

    for (let run = 0; run < 5; run += 1) await runSearchCatchup(db, deps());
    expect(memosIndex.resources("memo_id")).toEqual([...names].sort());
    for (const name of names) expect(await statusOf(name)).toBe("indexed");

    const idle = await runSearchCatchup(db, deps());
    expect(idle).toEqual({ indexed: 0, failed: 0, more: false });
  });

  it("stays well under the Free plan's 50 queries per run", async () => {
    // Long entries split into several chunks; the D1 cost must not grow with it.
    await importEntries(
      Array.from({ length: 8 }, (_, i) => [
        `memos/long-${i}`,
        "A sentence about the week. ".repeat(200),
      ]),
    );
    queries = 0;
    const result = await runSearchCatchup(db, deps());
    expect(result.indexed).toBe(SEARCH_CATCHUP_BATCH);
    // The counter sees every read and write (at least one per entry)...
    expect(queries).toBeGreaterThan(SEARCH_CATCHUP_BATCH);
    // ...and the run stays inside the budget, which is inside the cap.
    expect(queries).toBeLessThanOrEqual(CATCHUP_QUERY_BUDGET);
    expect(CATCHUP_QUERY_BUDGET).toBeLessThan(50);
  });

  it("marks a failing entry and moves on to the others", async () => {
    await importEntries([
      ["memos/a-bad", "This one BREAKS the model"],
      ["memos/b-good", "Lake swim"],
      ["memos/c-good", "Morning run"],
    ]);
    queries = 0;
    const result = await runSearchCatchup(db, deps());
    expect(result).toMatchObject({ indexed: 2, failed: 1 });
    expect(queries).toBeLessThanOrEqual(CATCHUP_QUERY_BUDGET);
    expect(await statusOf("memos/a-bad")).toBe("error");
    expect(memosIndex.resources("memo_id")).toEqual([
      "memos/b-good",
      "memos/c-good",
    ]);
    // The marked entry is not retried on every run.
    expect(await runSearchCatchup(db, deps())).toMatchObject({
      indexed: 0,
      failed: 0,
    });
  });

  it("leaves rows the outbox owns, and trashed entries alone", async () => {
    await importEntries([
      ["memos/queued", "Has an outbox task"],
      ["memos/binned", "In the bin"],
    ]);
    await database
      .prepare(
        "INSERT INTO embedding_tasks (id, user_id, resource_type, resource_id, operation, status, attempts, next_attempt_at, created_at, updated_at) SELECT 't1', user_id, 'memo', id, 'index', 'pending', 0, created_at, created_at, created_at FROM memos WHERE id = 'memos/queued'",
      )
      .run();
    await database
      .prepare("UPDATE memos SET status = 'trashed' WHERE id = 'memos/binned'")
      .run();

    const result = await runSearchCatchup(db, deps());
    expect(result).toEqual({ indexed: 0, failed: 0, more: false });
    expect(memosIndex.resources("memo_id")).toEqual([]);
    expect(await statusOf("memos/queued")).toBe("not_indexed");
  });

  it("does nothing while indexing is switched off", async () => {
    await importEntries([["memos/off", "Dev has no model"]]);
    const result = await runSearchCatchup(db, {
      provider: null,
      memosIndex,
    });
    expect(result).toEqual({ indexed: 0, failed: 0, more: false });
    expect(await statusOf("memos/off")).toBe("not_indexed");
  });
});

/** Count a prepared statement's executions (first/all/run/raw). */
function countStatement(statement: object): object {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "bind" && typeof value === "function") {
        return (...args: unknown[]) =>
          countStatement(value.apply(target, args) as object);
      }
      if (
        (prop === "first" ||
          prop === "all" ||
          prop === "run" ||
          prop === "raw") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          queries += 1;
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
