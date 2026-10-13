import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyFlaremoMigrations, embeddingTasks } from "@flaremo/db";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ForkConsumer,
  forkConsumers,
  forkDataSources,
  forkDataSourcesMarkdown,
  forkDataSourceTables,
  forkModules,
  forkUseReason,
  forkUseVerdict,
} from "./data-sources";

// The registry's contract with the code (fork-owned; docs/fork-data-sources.md).
// Each check here fails with a message that says what to do, because the person
// reading it will usually be adding a table, not maintaining this test.

const repo = (path: string) =>
  fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

const ADD_IT =
  "Add it to packages/domain/src/fork/data-sources.ts and say, for each consumer, whether it should reach it (see docs/fork-data-sources.md).";

/** Tables SQLite, D1 and the FTS5 module create for themselves. */
function isInternalTable(name: string): boolean {
  return (
    name.startsWith("sqlite_") ||
    name.startsWith("_cf_") ||
    name.startsWith("d1_") ||
    /_fts_(data|idx|content|docsize|config)$/.test(name)
  );
}

/** Every table a fully migrated database has: upstream's journal, then the fork's. */
async function migratedTables(): Promise<string[]> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok') } }",
    modules: true,
    compatibilityDate: "2026-07-10",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "fork-data-sources-test" },
  });
  try {
    const database = await mf.getD1Database("DB");
    await applyFlaremoMigrations(database);
    await applyPlannerMigrations(database);
    const rows = await database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    return rows.results
      .map((row) => row.name)
      .filter((n) => !isInternalTable(n));
  } finally {
    await mf.dispose();
  }
}

/** Every Drizzle table in every module of packages/db/src/schema, by export name. */
async function schemaTables(): Promise<Map<string, string>> {
  const dir = repo("packages/db/src/schema");
  const byExport = new Map<string, string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(`${dir}/${file}`).href
    )) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (is(value, SQLiteTable)) byExport.set(name, getTableName(value));
    }
  }
  return byExport;
}

const tableEntry = (table: string) =>
  forkDataSources.find((source) => source.id === table);

describe("every table is in the data-source registry", () => {
  let migrated: string[] = [];
  let schema = new Map<string, string>();

  beforeAll(async () => {
    [migrated, schema] = await Promise.all([migratedTables(), schemaTables()]);
  });

  it("lists every table a migrated database has", () => {
    const listed = new Set(forkDataSourceTables());
    const missing = migrated.filter((table) => !listed.has(table));
    expect(missing, `Tables not in the registry. ${ADD_IT}`).toEqual([]);
  });

  it("lists every table the Drizzle schema declares", () => {
    const listed = new Set(forkDataSourceTables());
    const missing = [...new Set(schema.values())].filter(
      (table) => !listed.has(table),
    );
    expect(missing, `Schema tables not in the registry. ${ADD_IT}`).toEqual([]);
  });

  it("lists no table that no longer exists", () => {
    const real = new Set([...migrated, ...schema.values()]);
    const stale = forkDataSourceTables().filter((table) => !real.has(table));
    expect(
      stale,
      "Registry entries for tables that are gone: remove them from data-sources.ts",
    ).toEqual([]);
  });
});

describe("the registry is well formed", () => {
  it("has unique ids and one table-level entry per table", () => {
    const ids = forkDataSources.map((source) => source.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    const withoutOwnEntry = forkDataSourceTables().filter(
      (table) => !tableEntry(table),
    );
    expect(
      withoutOwnEntry,
      "A `table:variant` or `table.column` entry needs an entry whose id is the table itself",
    ).toEqual([]);
    for (const source of forkDataSources) {
      if (source.id === source.table) continue;
      expect(source.id).toMatch(new RegExp(`^${source.table}[:.][a-z0-9_-]+$`));
    }
  });

  it("answers every consumer, with a reason, for every source", () => {
    const consumers = Object.keys(forkConsumers) as ForkConsumer[];
    for (const source of forkDataSources) {
      expect(Object.keys(source.uses).sort(), source.id).toEqual(
        [...consumers].sort(),
      );
      expect(Object.keys(forkModules), source.id).toContain(source.module);
      expect(source.holds.trim(), source.id).not.toBe("");
      for (const consumer of consumers) {
        expect(
          forkUseReason(source.uses[consumer]).trim().length,
          `${source.id} → ${consumer} needs a reason`,
        ).toBeGreaterThan(3);
      }
    }
  });

  it("marks fork-owned tables as fork tables", () => {
    for (const source of forkDataSources) {
      if (source.table.startsWith("planner_")) {
        expect(source.owner, source.id).toBe("fork");
      }
    }
  });
});

describe("the backup column matches the persistence manifest", () => {
  type Manifest = {
    RESTORE_TABLES: string[];
    REBUILDABLE_TABLES: string[];
    DERIVED_INDEX_TABLES: string[];
  };
  let manifest: Manifest;

  beforeAll(async () => {
    const path = pathToFileURL(repo("scripts/persistence-manifest.mjs")).href;
    manifest = (await import(/* @vite-ignore */ path)) as Manifest;
  });

  it("says yes exactly for the tables the backup restores", () => {
    const restored = new Set(manifest.RESTORE_TABLES);
    for (const source of forkDataSources) {
      const verdict = forkUseVerdict(source.uses.backup);
      expect(
        verdict === "yes",
        `${source.id}: backup is "${verdict}" but scripts/persistence-manifest.mjs ${
          restored.has(source.table) ? "restores" : "does not restore"
        } ${source.table}. Change one so they agree.`,
      ).toBe(restored.has(source.table));
    }
  });

  it("classifies every table, so pnpm test repeats persistence:check", () => {
    // `pnpm persistence:check` scans schema files only and is not part of
    // `pnpm test`; this runs the same rule on every table the registry knows,
    // including tables created by hand-written SQL.
    const classified = new Set([
      ...manifest.RESTORE_TABLES,
      ...manifest.REBUILDABLE_TABLES,
      ...manifest.DERIVED_INDEX_TABLES,
    ]);
    expect(
      forkDataSourceTables().filter((table) => !classified.has(table)),
      "Add these to RESTORE_TABLES (source of truth) or REBUILDABLE_TABLES (derived) in scripts/persistence-manifest.mjs",
    ).toEqual([]);
  });

  it("never marks the backup as a gap", () => {
    // A table missing from the backup is a data-loss bug, not a follow-up.
    const gaps = forkDataSources.filter((s) => "gap" in s.uses.backup);
    expect(gaps.map((s) => s.id)).toEqual([]);
  });
});

describe("the search column matches the search index", () => {
  // The tables search covers, the embedding resource that stands for each and
  // its keyword index. Adding a table to search means adding it here, to the
  // embedding_tasks resource enum and to data-sources.ts.
  const SEARCH_INDEX: Record<string, { embedding: string; fts: string }> = {
    memos: { embedding: "memo", fts: "memos_fts" },
    memory_items: { embedding: "memory", fts: "memory_fts" },
  };

  it("says yes exactly for the tables with an index", () => {
    const searched = forkDataSources
      .filter((source) => source.id === source.table)
      .filter((source) => forkUseVerdict(source.uses.search) === "yes")
      .map((source) => source.table)
      .sort();
    expect(searched).toEqual(Object.keys(SEARCH_INDEX).sort());
  });

  it("has an embedding resource for each searched table and no other", () => {
    expect([...embeddingTasks.resourceType.enumValues].sort()).toEqual(
      Object.values(SEARCH_INDEX)
        .map((index) => index.embedding)
        .sort(),
    );
  });

  it("has a keyword index for each searched table", () => {
    for (const index of Object.values(SEARCH_INDEX)) {
      expect(tableEntry(index.fts), index.fts).toBeDefined();
    }
  });
});

describe("the memory column matches what the memory layer reads", () => {
  // The memory layer's source files. A table they import from @flaremo/db is a
  // table the layer reads; reading outside its own tables must be declared.
  const MEMORY_SOURCES = [
    ...readdirSync(repo("packages/domain/src/memory"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => `packages/domain/src/memory/${name}`),
    "apps/worker/src/memory-dreaming.ts",
  ];

  it("reads only the tables marked for memory, and all of them", async () => {
    const schema = await schemaTables();
    const imported = new Set<string>();
    for (const file of MEMORY_SOURCES) {
      const text = readFileSync(repo(file), "utf8");
      for (const match of text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"@flaremo\/db[^"]*"/g,
      )) {
        for (const name of (match[1] ?? "").split(",")) {
          const table = schema.get(name.replace(/^\s*type\s+/, "").trim());
          if (table) imported.add(table);
        }
      }
    }
    const outside = (table: string) => {
      const entry = tableEntry(table);
      return entry && entry.module !== "memory" && entry.kind !== "system";
    };
    const read = [...imported].filter(outside).sort();
    const declared = forkDataSources
      .filter((source) => source.id === source.table && outside(source.table))
      .filter((source) => forkUseVerdict(source.uses.memory) === "yes")
      .map((source) => source.table)
      .sort();
    expect(
      read,
      "The memory layer reads these tables; mark memory as yes for exactly them in data-sources.ts",
    ).toEqual(declared);
  });
});

describe("every migration file reaches the test databases", () => {
  // Upstream migrations are applied from the drizzle journal; fork ones by
  // name, 9NNN_planner_*.sql (packages/db/src/planner-migrations.ts, and the
  // dev environment tooling uses the same pattern). A fork migration with any
  // other name would be applied in production by `wrangler d1 migrations apply`
  // but silently skipped by every test and by the dev tooling.
  it("is either in the drizzle journal or named 9NNN_planner_*.sql", () => {
    const journal = JSON.parse(
      readFileSync(repo("migrations/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const known = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
    const stray = readdirSync(repo("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .filter(
        (name) => !known.has(name) && !/^9\d{3}_planner_.+\.sql$/.test(name),
      );
    expect(
      stray,
      "Migrations no test applies. Name fork migrations 9NNN_planner_<name>.sql, or widen the pattern in packages/db/src/planner-migrations.ts and scripts/fork/dev-env-data.mjs together.",
    ).toEqual([]);
  });
});

describe("docs/fork-data-sources.md", () => {
  it("shows the registry as it is", () => {
    const path = repo("docs/fork-data-sources.md");
    const doc = readFileSync(path, "utf8");
    const start = "<!-- data-sources:start -->";
    const end = "<!-- data-sources:end -->";
    const before = doc.slice(0, doc.indexOf(start) + start.length);
    const after = doc.slice(doc.indexOf(end));
    expect(doc.includes(start) && doc.includes(end)).toBe(true);
    const expected = `${before}\n\n${forkDataSourcesMarkdown()}\n\n${after}`;
    if (process.env.FORK_DATA_SOURCES_WRITE === "1" && expected !== doc) {
      writeFileSync(path, expected);
      return;
    }
    expect(
      doc,
      "Run FORK_DATA_SOURCES_WRITE=1 pnpm exec vitest run packages/domain/src/fork/data-sources.test.ts to refresh the doc",
    ).toBe(expected);
  });
});
