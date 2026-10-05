import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FlaremoMigrationDatabase } from "./test-migrations";

// Test helper for the planning cockpit's migrations (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md).
//
// Planner migrations are hand-written files named migrations/9NNN_planner_*.sql.
// They are not in the drizzle journal (G3), and applyFlaremoMigrations reads
// only the journal, so it never creates the planner tables. Suites that need
// them call both, upstream first:
//
//   await applyFlaremoMigrations(database);
//   await applyPlannerMigrations(database);
//
// Deliberately NOT exported from the @flaremo/db barrel: import it by deep path
// (`@flaremo/db/src/planner-migrations`) so upstream's index.ts stays untouched.
// It repeats the small file-loading helpers of ./test-migrations because
// importing them would mean editing that upstream file.

/** `9NNN_planner_<name>.sql`: the same track the fork's dev tooling recognises. */
const PLANNER_MIGRATION_FILE = /^(9\d{3})_planner_.+\.sql$/;

type LoadedPlannerMigration = { name: string; statements: string[] };

let migrationsCache: LoadedPlannerMigration[] | undefined;

/**
 * Resolved relative to this source file so the helper works from any
 * workspace package under vitest: <repo>/packages/db/src -> <repo>/migrations.
 */
function migrationsDirectory(): string {
  return fileURLToPath(new URL("../../../migrations/", import.meta.url));
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Picks the planner migration files out of a directory listing and puts them in
 * the order Wrangler applies them: by leading number, then by name. Anything
 * else (upstream 0NNN files, `meta`, other 9NNN files) is ignored.
 */
export function plannerMigrationFiles(names: readonly string[]): string[] {
  const numbered = names.flatMap((name) => {
    const match = PLANNER_MIGRATION_FILE.exec(name);
    return match?.[1] ? [{ name, number: Number(match[1]) }] : [];
  });
  return numbered
    .sort((left, right) => {
      if (left.number !== right.number) return left.number - right.number;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })
    .map(({ name }) => name);
}

async function loadPlannerMigrations(): Promise<LoadedPlannerMigration[]> {
  if (migrationsCache) return migrationsCache;
  const directory = migrationsDirectory();
  const names = plannerMigrationFiles(await readdir(directory));
  if (names.length === 0) {
    // A moved directory or a renamed file must not turn into a silent no-op
    // that leaves every planner suite failing on a missing table.
    throw new Error(`No 9NNN_planner_*.sql migrations found in ${directory}`);
  }
  const migrations = await Promise.all(
    names.map(async (name) => ({
      name,
      statements: splitStatements(
        await readFile(`${directory}/${name}`, "utf8"),
      ),
    })),
  );
  migrationsCache = migrations;
  return migrations;
}

/**
 * Applies every migrations/9NNN_planner_*.sql file, in numeric order, to the
 * given D1 database. Call it after `applyFlaremoMigrations`. Like that helper it
 * is not idempotent: a second call on the same database fails on the first
 * CREATE TABLE.
 */
export async function applyPlannerMigrations(
  database: FlaremoMigrationDatabase,
): Promise<void> {
  for (const migration of await loadPlannerMigrations()) {
    for (const statement of migration.statements) {
      await database.prepare(statement).run();
    }
  }
}
