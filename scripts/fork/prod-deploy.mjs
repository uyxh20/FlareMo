#!/usr/bin/env node

// Fork-only ops tooling: ship the current checkout to the LIVE Worker in one
// command, with the whole prod upgrade procedure built in. See
// docs/fork-dev-environment.md ("Shipping to live").
//
//   node scripts/fork/prod-deploy.mjs status                  read-only: live version, counts, pending migrations
//   node scripts/fork/prod-deploy.mjs deploy --dry-run        everything up to (not including) any write
//   node scripts/fork/prod-deploy.mjs deploy --confirm flaremo   the real thing
//   node scripts/fork/prod-deploy.mjs rollback --confirm flaremo put the previous Worker version back
//
// Deploy steps: regenerate config from wrangler.jsonc.example + the live
// Worker's vars -> note the current version (rollback target) -> Time Travel
// bookmark -> baseline row counts -> build -> apply pending migrations ->
// deploy (--keep-vars) -> re-check counts and the site -> roll the Worker back
// automatically if anything is off. Only COUNT(*) is ever read from live D1,
// never diary, memory or task text. Secrets and var values are never printed.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseConfigText } from "./dev-env-config.mjs";
import { PROD } from "./dev-env-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(ROOT, "wrangler.jsonc");
const API = "https://api.cloudflare.com/client/v4";

// Tables whose row count may legitimately drop between two reads (expiry
// sweeps, queues, caches). A drop is reported but does not trigger rollback.
const EPHEMERAL_TABLE =
  /session|verification|token|rate|queue|job|outbox|cache|lock|nonce/i;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Example config + live plain-text vars + the live D1 id -> prod config. */
export function buildProdConfig(exampleText, liveVars) {
  const config = parseConfigText(exampleText, "wrangler.jsonc.example");
  config.name = PROD.workerName;
  const db = config.d1_databases?.find((entry) => entry.binding === "DB");
  if (!db) throw new Error("wrangler.jsonc.example has no DB binding.");
  db.database_name = PROD.d1Name;
  db.database_id = PROD.d1Id;
  config.vars = { ...(config.vars ?? {}), ...liveVars };
  return config;
}

/** Refuse to write anything unless the config targets exactly production. */
export function assertProdConfig(config) {
  const problems = [];
  if (config.name !== PROD.workerName) problems.push("worker name");
  const db = config.d1_databases?.find((entry) => entry.binding === "DB");
  if (db?.database_id !== PROD.d1Id) problems.push("D1 id");
  if (config.r2_buckets?.[0]?.bucket_name !== PROD.bucket) {
    problems.push("R2 bucket");
  }
  const queues = (config.queues?.producers ?? []).map((q) => q.queue).sort();
  if (JSON.stringify(queues) !== JSON.stringify([...PROD.queues].sort())) {
    problems.push("queues");
  }
  const indexes = (config.vectorize ?? []).map((v) => v.index_name).sort();
  if (
    JSON.stringify(indexes) !==
    JSON.stringify([...PROD.vectorizeIndexes].sort())
  ) {
    problems.push("vectorize indexes");
  }
  if (config.vars?.FLAREMO_PUBLIC_URL !== PROD.publicUrl) {
    problems.push("FLAREMO_PUBLIC_URL");
  }
  if (problems.length > 0) {
    throw new Error(
      `Config does not match production (${problems.join(", ")}); refusing to deploy.`,
    );
  }
}

/** Local migration files that live has not applied yet, in order. */
/**
 * Migration files on disk that are not committed on origin/main. wrangler
 * applies every .sql file in migrations/, tracked or not, so any stray file
 * here would go to live with no review. Returns the offending names.
 */
export function strayMigrations(localFiles, trackedFiles) {
  const tracked = new Set(trackedFiles);
  return localFiles.filter((name) => !tracked.has(name)).sort();
}

export function pendingMigrations(localFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return localFiles.filter((name) => !applied.has(name)).sort();
}

/** Compare row counts. `fatal` means roll back; `notes` are just reported. */
export function compareCounts(before, after) {
  const fatal = [];
  const notes = [];
  for (const [table, was] of Object.entries(before)) {
    const now = after[table];
    if (now === undefined) {
      fatal.push(`${table}: table disappeared (was ${was})`);
    } else if (now < was) {
      const line = `${table}: ${was} -> ${now}`;
      (EPHEMERAL_TABLE.test(table) ? notes : fatal).push(line);
    }
  }
  for (const table of Object.keys(after)) {
    if (!(table in before))
      notes.push(`${table}: new table (${after[table]} rows)`);
  }
  return { fatal, notes };
}

/** Replace every var value in text so wrangler output can be shown safely. */
export function redact(text, secretValues) {
  let out = text;
  for (const value of secretValues) {
    if (typeof value === "string" && value.length >= 4) {
      out = out.split(value).join("***");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cloudflare + wrangler plumbing
// ---------------------------------------------------------------------------

function context() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID is not set; cannot reach Cloudflare.",
    );
  }
  const token =
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_API ||
    "proxy-injected";
  return { accountId, token };
}

async function cf(ctx, path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}/accounts/${ctx.accountId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const reason = (json.errors ?? []).map((e) => e.message).join("; ");
    throw new Error(
      `Cloudflare ${method} ${path} failed (${response.status}) ${reason}`,
    );
  }
  return json.result;
}

const d1 = (ctx, sql) =>
  cf(ctx, `/d1/database/${PROD.d1Id}/query`, {
    method: "POST",
    body: { sql },
  }).then((results) => results[0]?.results ?? []);

async function liveWorker(ctx) {
  const settings = await cf(
    ctx,
    `/workers/scripts/${PROD.workerName}/settings`,
  );
  const vars = {};
  for (const binding of settings.bindings ?? []) {
    if (binding.type === "plain_text") vars[binding.name] = binding.text;
  }
  return { vars };
}

async function currentVersion(ctx) {
  const { deployments } = await cf(
    ctx,
    `/workers/scripts/${PROD.workerName}/deployments`,
  );
  const top = deployments?.[0];
  const id = top?.versions?.[0]?.version_id;
  if (!id || top.versions.length !== 1 || top.versions[0].percentage !== 100) {
    throw new Error(
      "Live Worker is not on a single 100% version; refusing to continue.",
    );
  }
  const { items } = await cf(
    ctx,
    `/workers/scripts/${PROD.workerName}/versions`,
  );
  const number = items?.find((item) => item.id === id)?.number;
  return { id, number };
}

async function rowCounts(ctx) {
  const tables = await d1(
    ctx,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  const virtual = tables
    .filter((t) => /VIRTUAL TABLE/i.test(t.sql ?? ""))
    .map((t) => t.name);
  const counts = {};
  for (const { name } of tables) {
    if (virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    const [row] = await d1(
      ctx,
      `SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`,
    );
    counts[name] = row.n;
  }
  return counts;
}

async function appliedMigrations(ctx) {
  const rows = await d1(ctx, "SELECT name FROM d1_migrations ORDER BY id");
  return rows.map((row) => row.name);
}

function localMigrations() {
  return readdirSync(join(ROOT, "migrations")).filter((f) =>
    f.endsWith(".sql"),
  );
}

/** .sql names committed under migrations/ on origin/main. */
function trackedMigrations() {
  return git("ls-tree", "--name-only", "origin/main", "migrations/")
    .split("\n")
    .map((path) => path.replace(/^migrations\//, ""))
    .filter((name) => name.endsWith(".sql"));
}

/** Refuse when migrations/ holds anything origin/main does not. */
function assertMigrationsMatchMain() {
  const stray = strayMigrations(localMigrations(), trackedMigrations());
  const changed = git("status", "--porcelain", "--", "migrations");
  if (stray.length > 0 || changed !== "") {
    throw new Error(
      `migrations/ differs from origin/main (${[...stray, changed].filter(Boolean).join("; ")}). wrangler would apply it to live; remove or commit it first.`,
    );
  }
}

function wranglerBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler;
  return resolve(dirname(pkgPath), bin);
}

function run(command, args, { cwd = ROOT, secretValues = [] } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const output = redact(
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    secretValues,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${output.slice(-3000)}`,
    );
  }
  return output;
}

const wrangler = (args, options) =>
  run(process.execPath, [wranglerBin(), ...args], options);

async function writeConfig(ctx) {
  const { vars } = await liveWorker(ctx);
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const config = buildProdConfig(example, vars);
  assertProdConfig(config);
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return { config, secretValues: Object.values(vars) };
}

function git(...args) {
  return run("git", args).trim();
}

async function smokeCheck() {
  const results = [];
  for (const path of ["/", "/openapi.json"]) {
    const response = await fetch(`${PROD.publicUrl}${path}`, {
      redirect: "manual",
    });
    results.push({ path, status: response.status });
  }
  return results;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function rollbackTo(ctx, versionId) {
  await cf(ctx, `/workers/scripts/${PROD.workerName}/deployments`, {
    method: "POST",
    body: {
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
    },
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function say(line = "") {
  console.log(line);
}

function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

async function status(ctx) {
  const version = await currentVersion(ctx);
  const counts = await rowCounts(ctx);
  const pending = pendingMigrations(
    localMigrations(),
    await appliedMigrations(ctx),
  );
  say(`Live Worker version: #${version.number ?? "?"} (${version.id})`);
  say(
    `Local checkout: ${git("rev-parse", "--short", "HEAD")} ${git("log", "-1", "--format=%s")}`,
  );
  say(
    `Live tables: ${Object.keys(counts).length}, rows in total: ${total(counts)}`,
  );
  say(
    `Pending migrations: ${pending.length === 0 ? "none" : pending.join(", ")}`,
  );
}

/**
 * The generated root wrangler.jsonc points at production. Left behind, any
 * later `pnpm migrate:remote` or raw `wrangler deploy` would hit live without
 * this script's safeguards, so a deploy run always removes it when it ends.
 */
async function deploy(ctx, options) {
  try {
    await shipToLive(ctx, options);
  } finally {
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH);
      say("Removed the generated wrangler.jsonc (it points at live).");
    }
  }
}

async function shipToLive(ctx, { dryRun }) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const head = git("rev-parse", "--short", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error(
      "Working tree has uncommitted changes; commit or stash first.",
    );
  }
  git("fetch", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Error(
      "HEAD is not the same commit as origin/main; refusing to ship it.",
    );
  }
  assertMigrationsMatchMain();
  say(
    `Shipping ${head} (${branch}) ${dryRun ? "[dry run: nothing will change]" : ""}`,
  );

  const { config, secretValues } = await writeConfig(ctx);
  say(
    "1/8 Config rebuilt from the example + live settings (matches production).",
  );

  const rollbackTarget = await currentVersion(ctx);
  say(
    `2/8 Rollback target: version #${rollbackTarget.number ?? "?"} (${rollbackTarget.id})`,
  );

  const bookmark = (
    await cf(ctx, `/d1/database/${PROD.d1Id}/time_travel/bookmark`)
  ).bookmark;
  say(`3/8 Time Travel bookmark saved: ${bookmark}`);

  const before = await rowCounts(ctx);
  say(
    `4/8 Baseline: ${Object.keys(before).length} tables, ${total(before)} rows.`,
  );

  const pending = pendingMigrations(
    localMigrations(),
    await appliedMigrations(ctx),
  );
  say(
    `    Pending migrations: ${pending.length === 0 ? "none" : pending.join(", ")}`,
  );

  run("pnpm", ["--filter", "@flaremo/web", "build"]);
  say("5/8 Web app built.");

  if (dryRun) {
    wrangler(
      [
        "deploy",
        "--dry-run",
        "--config",
        "../../wrangler.jsonc",
        "--keep-vars",
      ],
      {
        cwd: join(ROOT, "apps/worker"),
        secretValues,
      },
    );
    say("    Worker bundle builds cleanly (wrangler dry run).");
    say("Dry run finished. Nothing on live was changed.");
    return;
  }

  assertProdConfig(config);
  // The build takes minutes; check again right before anything is applied.
  assertMigrationsMatchMain();
  try {
    if (pending.length > 0) {
      wrangler(
        [
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          CONFIG_PATH,
        ],
        {
          secretValues,
        },
      );
      say(`6/8 Applied ${pending.length} migration(s).`);
    } else {
      say("6/8 No migrations to apply.");
    }

    wrangler(["deploy", "--config", "../../wrangler.jsonc", "--keep-vars"], {
      cwd: join(ROOT, "apps/worker"),
      secretValues,
    });
    const after = await currentVersion(ctx);
    if (after.id === rollbackTarget.id) {
      throw new Error("Deploy finished but the live version did not change.");
    }
    say(`7/8 Deployed: version #${after.number ?? "?"} (${after.id}).`);

    await sleep(5000);
    const afterCounts = await rowCounts(ctx);
    const { fatal, notes } = compareCounts(before, afterCounts);
    const smoke = await smokeCheck();
    const badSmoke = smoke.filter((s) => s.status >= 400);
    if (fatal.length > 0 || badSmoke.length > 0) {
      throw new Error(
        [
          ...fatal.map((line) => `row count dropped: ${line}`),
          ...badSmoke.map((s) => `${s.path} answered ${s.status}`),
        ].join("; "),
      );
    }
    say(
      `8/8 Checks passed: ${Object.keys(afterCounts).length} tables, ${total(afterCounts)} rows (was ${total(before)}); site answers.`,
    );
    for (const note of notes) say(`    note: ${note}`);
    say("");
    say(
      `Done. Live is on version #${after.number ?? "?"}. Previous version #${rollbackTarget.number ?? "?"} can be restored with: node scripts/fork/prod-deploy.mjs rollback --confirm flaremo`,
    );
  } catch (error) {
    say(`PROBLEM: ${error.message}`);
    say(
      `Rolling the Worker back to version #${rollbackTarget.number ?? "?"} ...`,
    );
    await rollbackTo(ctx, rollbackTarget.id);
    say("Worker rolled back. No data was restored automatically.");
    say(
      `If a migration ran and the data needs undoing, use the Time Travel bookmark ${bookmark} (wrangler d1 time-travel restore flaremo --bookmark=...), after checking with Anon.`,
    );
    process.exitCode = 1;
  }
}

async function rollback(ctx) {
  const { items } = await cf(
    ctx,
    `/workers/scripts/${PROD.workerName}/versions`,
  );
  const current = await currentVersion(ctx);
  const index = items.findIndex((item) => item.id === current.id);
  const previous = items[index + 1];
  if (!previous) throw new Error("No earlier version to roll back to.");
  await rollbackTo(ctx, previous.id);
  say(
    `Live Worker is back on version #${previous.number} (${previous.id}). Data was not touched.`,
  );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      confirm: { type: "string" },
    },
  });
  const command = positionals[0];
  const ctx = context();
  if (command === "status") {
    await status(ctx);
  } else if (command === "deploy") {
    if (!values["dry-run"] && values.confirm !== PROD.workerName) {
      throw new Error(
        "Live deploys need --confirm flaremo (or use --dry-run).",
      );
    }
    await deploy(ctx, { dryRun: values["dry-run"] });
  } else if (command === "rollback") {
    if (values.confirm !== PROD.workerName) {
      throw new Error("Rollback needs --confirm flaremo.");
    }
    await rollback(ctx);
  } else {
    throw new Error(
      "Usage: prod-deploy.mjs <status|deploy|rollback> [--dry-run] [--confirm flaremo]",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
