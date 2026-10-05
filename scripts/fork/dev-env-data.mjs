// Fork-only: the pure planning and SQL-building half of scripts/fork/dev-env.mjs.
// Nothing here talks to Cloudflare, so all of it is unit-tested directly.

import { readdirSync } from "node:fs";
import {
  DERIVED_INDEX_TABLES,
  REBUILDABLE_TABLES,
  RESTORE_TABLES,
} from "../persistence-manifest.mjs";
import { DEV } from "./dev-env-config.mjs";

// Never copied: live login sessions and one-time tokens.
export const EPHEMERAL_TABLES = Object.freeze([
  "auth_sessions",
  "auth_verifications",
]);

// Not copied by default. These hold outbound integrations that would let the
// dev Worker act on the real world with production's copy: webhook endpoints
// and their delivery outbox, browser push endpoints, and encrypted third-party
// credentials (email, OAuth, voice). `--include-side-effect-tables` overrides.
export const SIDE_EFFECT_TABLES = Object.freeze([
  "memos_webhooks",
  "memos_webhook_events",
  "memos_webhook_deliveries",
  "push_subscriptions",
  "integration_config",
  "voice_service_config",
]);

export const MAX_ROWS_PER_EXPORT_CALL = 5000;

export function quoteIdent(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    // D1 returns BLOB values as arrays of bytes.
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildCountsQuery(tables) {
  const counts = tables.map(
    (table) =>
      `(SELECT COUNT(*) FROM ${quoteIdent(table)}) AS ${quoteIdent(table)}`,
  );
  return `SELECT ${counts.join(", ")};`;
}

/**
 * The data file imported into dev: clear every restore table (children first,
 * so ON DELETE RESTRICT keys never block), then insert the copied rows in
 * dependency order. Migrations seed rows of their own (0020 creates the default
 * team), so clearing first is what keeps the import idempotent.
 */
export function buildImportSql({ clearTables, inserts }) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of clearTables) {
    lines.push(`DELETE FROM ${quoteIdent(table)};`);
  }
  for (const { table, columns, rows } of inserts) {
    const columnList = columns.map(quoteIdent).join(", ");
    for (const row of rows) {
      const values = columns
        .map((column) => sqlLiteral(row[column]))
        .join(", ");
      lines.push(
        `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${values});`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The tables to empty before the import, children first: ON DELETE RESTRICT
 * keys (auth_bootstrap, articles.team_id) must never see a parent go before its
 * children, whether or not the import path honours deferred foreign keys.
 */
export function planClearTables(devColumns, tables = RESTORE_TABLES) {
  return tables
    .filter((table) => (devColumns.get(table) ?? []).length > 0)
    .reverse();
}

/**
 * Group tables into export calls. One call is one D1 batch, so a single group
 * is a consistent snapshot; more than one group is not, and the caller says so.
 */
export function planExportBatches(
  tables,
  counts,
  maxRows = MAX_ROWS_PER_EXPORT_CALL,
) {
  const batches = [];
  let current = [];
  let rows = 0;
  for (const table of tables) {
    const count = Number(counts[table] ?? 0);
    if (current.length > 0 && rows + count > maxRows) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(table);
    rows += count;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Tables in `schemaRows` (name and sql from sqlite_master) that the persistence
 * manifest does not list: the fork's planner tables, say. Virtual tables, their
 * shadow tables and SQLite/Cloudflare internals are never candidates.
 */
export function discoverExtraTables(schemaRows) {
  const virtual = schemaRows
    .filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ""))
    .map((row) => row.name);
  const isShadow = (name) =>
    virtual.some(
      (table) =>
        name.startsWith(`${table}_`) &&
        /_(data|idx|content|docsize|config)$/.test(name),
    );
  const known = new Set([
    ...RESTORE_TABLES,
    ...REBUILDABLE_TABLES,
    ...DERIVED_INDEX_TABLES,
    "d1_migrations",
  ]);
  return schemaRows
    .map((row) => row.name)
    .filter(
      (name) =>
        !known.has(name) &&
        !virtual.includes(name) &&
        !isShadow(name) &&
        !/^(sqlite_|_cf_)/.test(name),
    )
    .sort();
}

/**
 * Order tables so each comes after the tables it references. `references` maps
 * a table to the names it points at; names outside `tables` are ignored (they
 * are already in place) and so are self-references. A cycle cannot be ordered:
 * its tables are returned last, in name order, and listed in `cyclic`.
 */
export function orderByForeignKeys(tables, references) {
  const remaining = new Set(tables);
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .sort()
      .filter((table) =>
        (references.get(table) ?? []).every(
          (target) => target === table || !remaining.has(target),
        ),
      );
    if (ready.length === 0) {
      const cyclic = [...remaining].sort();
      return { order: [...order, ...cyclic], cyclic };
    }
    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }
  return { order, cyclic: [] };
}

/**
 * Decide, table by table, what gets copied. `prodColumns` and `devColumns` map
 * a table to its column names ([] when the table does not exist). A table in
 * `optional` that production has but dev lacks is skipped instead of being
 * treated as diverged schemas: those are tables found by discovery, and one
 * made outside the migrations has no counterpart in dev.
 */
export function planTableCopy({
  tables = RESTORE_TABLES,
  prodColumns,
  devColumns,
  includeSideEffectTables = false,
  optional = [],
}) {
  const copy = [];
  const skipped = [];
  for (const table of tables) {
    const prod = prodColumns.get(table) ?? [];
    const dev = devColumns.get(table) ?? [];
    if (EPHEMERAL_TABLES.includes(table)) {
      skipped.push({
        table,
        reason: "ephemeral (sessions and one-time tokens)",
      });
      continue;
    }
    if (!includeSideEffectTables && SIDE_EFFECT_TABLES.includes(table)) {
      skipped.push({ table, reason: "outbound integration (not copied)" });
      continue;
    }
    if (prod.length === 0) {
      skipped.push({
        table,
        reason:
          dev.length === 0
            ? "created by the upgrade migrations"
            : "absent in production",
      });
      continue;
    }
    if (dev.length === 0 && optional.includes(table)) {
      skipped.push({
        table,
        reason: "no migration creates it at dev's level (not copied)",
      });
      continue;
    }
    if (dev.length === 0) {
      throw new Error(
        `Table ${table} exists in production but not in dev at the same migration level; the schemas have diverged. Re-run with --reset.`,
      );
    }
    const columns = dev.filter((column) => prod.includes(column));
    if (columns.length === 0) {
      throw new Error(`Table ${table} has no common columns between schemas.`);
    }
    const warnings = [];
    const dropped = prod.filter((column) => !dev.includes(column));
    const defaulted = dev.filter((column) => !prod.includes(column));
    if (dropped.length > 0) {
      warnings.push(
        `${table}: production columns not in dev are dropped (${dropped.join(", ")})`,
      );
    }
    if (defaulted.length > 0) {
      warnings.push(
        `${table}: dev columns not in production take their defaults (${defaulted.join(", ")})`,
      );
    }
    copy.push({ table, columns, warnings });
  }
  return { copy, skipped };
}

// ---------------------------------------------------------------------------
// Migration levels

function leadingNumber(name) {
  return Number.parseInt(String(name).split("_")[0], 10);
}

// Same ordering wrangler uses: numeric prefix, then name.
export function compareMigrationNames(a, b) {
  const left = leadingNumber(a);
  const right = leadingNumber(b);
  if (left !== right && Number.isFinite(left) && Number.isFinite(right)) {
    return left - right;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listLocalMigrations(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort(compareMigrationNames);
}

// Two migration tracks share one d1_migrations table and one numbering, and
// wrangler applies them by leading number:
//
//   upstream  0xxx_*          FlareMo's own journaled migrations
//   fork      9xxx_planner_*  the fork's hand-written planner migrations
//
// Production's "level" is a property of the upstream track only. If it were the
// highest applied name, the first fork migration (9000) would hide every
// upstream migration that follows it. The fork track is carried alongside: the
// fork files production already has are applied with the level, and anything
// still pending on either track is the upgrade rehearsal.
export const UPSTREAM_MIGRATION_RE = /^0\d{3}_/;
export const FORK_MIGRATION_RE = /^9\d{3}_planner_/;

/** Split migration names into the two tracks, each in wrangler's order. */
export function splitMigrationTracks(names) {
  const tracks = { upstream: [], fork: [], unknown: [] };
  for (const name of [...names].sort(compareMigrationNames)) {
    if (UPSTREAM_MIGRATION_RE.test(name)) tracks.upstream.push(name);
    else if (FORK_MIGRATION_RE.test(name)) tracks.fork.push(name);
    else tracks.unknown.push(name);
  }
  return tracks;
}

/**
 * Work out how to bring dev to exactly production's migration level, and what
 * is left to apply as the upgrade rehearsal.
 *
 * - `prodLatest`: production's newest upstream migration (its level).
 * - `levelFiles`: the upstream files up to that level plus the fork files
 *   production has already applied. This is what dev gets before the import.
 * - `upgrade`: everything still pending on either track, applied after it.
 * - `warnings`: names that match neither track. They are ignored.
 */
export function planMigrationLevels({ localFiles, prodApplied, devApplied }) {
  const local = splitMigrationTracks(localFiles);
  const prod = splitMigrationTracks(prodApplied);
  const dev = splitMigrationTracks(devApplied);
  const warnings = [];
  for (const [source, tracks] of [
    ["checkout", local],
    ["production", prod],
    ["dev", dev],
  ]) {
    for (const name of tracks.unknown) {
      warnings.push(
        `Ignoring ${source} migration ${name}: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).`,
      );
    }
  }

  if (prod.upstream.length === 0) {
    throw new Error(
      "Production has no applied upstream D1 migrations (d1_migrations is empty or missing); refusing to clone.",
    );
  }
  const prodLatest = prod.upstream.at(-1);
  const missingLocally = [
    ...prod.upstream.filter((name) => !local.upstream.includes(name)),
    ...prod.fork.filter((name) => !local.fork.includes(name)),
  ];
  if (missingLocally.length > 0) {
    throw new Error(
      `Production has applied migrations this checkout does not contain (${missingLocally.join(", ")}). Merge the matching upstream release into this checkout first.`,
    );
  }

  const upto = local.upstream.filter(
    (name) => compareMigrationNames(name, prodLatest) <= 0,
  );
  const upstreamGaps = upto.filter((name) => !prod.upstream.includes(name));
  if (upstreamGaps.length > 0) {
    throw new Error(
      `Production skipped migrations older than its latest (${upstreamGaps.join(", ")}); its exact level cannot be reproduced.`,
    );
  }
  const prodForkLatest = prod.fork.at(-1);
  const forkGaps = prodForkLatest
    ? local.fork.filter(
        (name) =>
          compareMigrationNames(name, prodForkLatest) <= 0 &&
          !prod.fork.includes(name),
      )
    : [];
  if (forkGaps.length > 0) {
    throw new Error(
      `Production skipped fork-track migrations older than its latest fork migration (${forkGaps.join(", ")}); its exact level cannot be reproduced.`,
    );
  }

  const forkApplied = [...prod.fork];
  const levelFiles = [...upto, ...forkApplied].sort(compareMigrationNames);
  const upgrade = [
    ...local.upstream.filter(
      (name) => compareMigrationNames(name, prodLatest) > 0,
    ),
    ...local.fork.filter((name) => !prod.fork.includes(name)),
  ].sort(compareMigrationNames);

  const devLatest = dev.upstream.at(-1) ?? null;
  const reset = `Re-run with --reset --confirm ${DEV.d1Name} to recreate it.`;
  if (
    dev.upstream.some((name) => compareMigrationNames(name, prodLatest) > 0)
  ) {
    throw new Error(
      `The dev D1 is already past production's level (dev: ${devLatest}, production: ${prodLatest}). ${reset}`,
    );
  }
  const forkAhead = dev.fork.filter((name) => !prod.fork.includes(name));
  if (forkAhead.length > 0) {
    throw new Error(
      `The dev D1 is already past production on the fork track (${forkAhead.join(", ")}). ${reset}`,
    );
  }
  const foreign = dev.upstream.filter((name) => !upto.includes(name));
  if (foreign.length > 0) {
    throw new Error(
      `The dev D1 has migrations production lacks or this checkout does not contain (${foreign.join(", ")}). ${reset}`,
    );
  }
  return {
    prodLatest,
    devLatest,
    upto,
    forkApplied,
    levelFiles,
    devPending: levelFiles.filter((name) => !devApplied.includes(name)),
    upgrade,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Count comparison

/**
 * Compare what was exported, what dev holds, and what production holds now.
 * A copied table must match the exported rows exactly; production drifting
 * after the export is reported but is not a failure.
 */
export function summarizeCounts({ copy, skipped, exported, prod, dev }) {
  const rows = [];
  const mismatches = [];
  for (const { table } of copy) {
    const expected = exported[table] ?? 0;
    const actual = dev[table];
    let status = "ok";
    if (actual !== expected) {
      status = "MISMATCH";
      mismatches.push(
        `${table}: exported ${expected} rows but dev holds ${actual}`,
      );
    } else if (prod[table] !== undefined && prod[table] !== expected) {
      status = `ok (production changed since the export: now ${prod[table]})`;
    }
    rows.push({ table, prod: prod[table], dev: actual, status });
  }
  for (const { table, reason } of skipped) {
    rows.push({
      table,
      prod: prod[table],
      dev: dev[table],
      status: `not copied: ${reason}`,
    });
  }
  return { rows, mismatches };
}
