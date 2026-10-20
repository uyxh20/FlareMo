#!/usr/bin/env node

// Fork-only ops tooling: ship the current checkout to the LIVE Worker in one
// command, with the whole prod upgrade procedure built in. See
// docs/fork-dev-environment.md ("Shipping to live").
//
//   node scripts/fork/prod-deploy.mjs status                  read-only: live version, counts, pending migrations
//   node scripts/fork/prod-deploy.mjs deploy --dry-run        everything up to (not including) any write
//   node scripts/fork/prod-deploy.mjs deploy --confirm flaremo   the real thing
//   node scripts/fork/prod-deploy.mjs rollback --confirm flaremo put the previous healthy deployment back
//                                     [--version <id>]          or a chosen version
//
// Deploy steps: check the checkout (clean, equal to origin/main, no stray
// migration files) -> regenerate config from wrangler.jsonc.example + the live
// Worker's vars -> note the current version (rollback target) -> Time Travel
// bookmark -> build the web app and the Worker bundle -> baseline row counts ->
// apply pending migrations -> re-count -> deploy (--keep-vars) -> re-check
// counts and the site (including one route that reads D1) -> roll the Worker
// back automatically if anything is off. Only COUNT(*) is ever read from live
// D1, never diary, memory or task text. Secrets and var values are never
// printed. The root wrangler.jsonc it writes is put back the way it was at the
// end, so it never stays behind pointing at live.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_VARS, parseConfigText } from "./dev-env-config.mjs";
import { PROD } from "./dev-env-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(ROOT, "wrangler.jsonc");
const API = "https://api.cloudflare.com/client/v4";

// Tables whose row count may legitimately drop between two reads (expiry
// sweeps, queues, derived counters). A drop is reported but does not trigger
// a rollback. Every other table, including any new one, is guarded.
const EPHEMERAL_TABLES = new Set([
  "auth_sessions",
  "auth_verifications",
  "data_tasks",
  "embedding_tasks",
  "member_removal_jobs",
  "memo_hourly_counts",
  "memos_sse_events",
  "memos_webhook_deliveries",
  "memos_webhook_events",
  "push_subscriptions",
  "usage_counters",
]);

// Paths checked after a deploy. /feed.xml runs the Worker and reads D1, so a
// Worker that fails on every query cannot pass.
const SMOKE_PATHS = ["/", "/openapi.json", "/feed.xml"];

const ROLLED_BACK_FROM = /prod-deploy: rolled back from (\S+)/;

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

/**
 * The general agent's vars for this deploy, from FLAREMO_PROD_AGENT,
 * FLAREMO_PROD_AGENT_ENVIRONMENT, _STORE and _VAULT (the ids
 * scripts/fork/general-agent.ts prints). All four or none. Once live has them,
 * later deploys keep them through live's own vars.
 */
export function agentVarsFromEnv(env) {
  const names = Object.keys(AGENT_VARS);
  const given = names.filter((name) => env[`FLAREMO_PROD_${name.slice(8)}`]);
  if (given.length === 0) return {};
  if (given.length !== names.length) {
    throw new Error(
      `The general agent needs all of ${names.map((n) => `FLAREMO_PROD_${n.slice(8)}`).join(", ")}.`,
    );
  }
  const vars = {};
  for (const name of names) {
    const value = env[`FLAREMO_PROD_${name.slice(8)}`];
    if (!AGENT_VARS[name].test(value)) {
      throw new Error(`${name} does not look like an Anthropic id.`);
    }
    vars[name] = value;
  }
  return vars;
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
export function pendingMigrations(localFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return localFiles.filter((name) => !applied.has(name)).sort();
}

/**
 * Migration files on disk that are not committed. wrangler applies every .sql
 * in migrations/, tracked or not, so one of these would reach live unreviewed.
 */
export function strayMigrations(localFiles, trackedFiles) {
  const tracked = new Set(trackedFiles.map((file) => basename(file)));
  return localFiles.filter((name) => !tracked.has(name)).sort();
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
      (EPHEMERAL_TABLES.has(table) ? notes : fatal).push(line);
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

const VAR_BINDING_TYPES = new Set(["plain_text", "secret_text", "json"]);

/** Binding names a wrangler config declares, vars excluded. */
function configBindingNames(config) {
  const names = new Set();
  for (const [key, value] of Object.entries(config)) {
    if (key === "vars" || value === null || typeof value !== "object") {
      continue;
    }
    const entries = Array.isArray(value)
      ? value
      : key === "queues"
        ? (value.producers ?? [])
        : key === "durable_objects"
          ? (value.bindings ?? [])
          : [value];
    for (const entry of entries) {
      const name = entry?.binding ?? entry?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/**
 * What a deploy of `config` would change in live's bindings. `unknown`: live
 * bindings (not vars or secrets) the config lacks, which wrangler would remove.
 * `restored`: vars the config sets that live does not have, which come back
 * with the example's default.
 */
export function bindingDrift(liveBindings, config) {
  const declared = configBindingNames(config);
  const liveNames = new Set(liveBindings.map((binding) => binding.name));
  const unknown = liveBindings
    .filter((binding) => !VAR_BINDING_TYPES.has(binding.type))
    .filter((binding) => binding.name && !declared.has(binding.name))
    .map((binding) => `${binding.name} (${binding.type})`)
    .sort();
  const restored = Object.keys(config.vars ?? {})
    .filter((name) => !liveNames.has(name))
    .sort();
  return { unknown, restored };
}

/**
 * The version a manual rollback should restore: the newest earlier deployment
 * at 100% that is not the live version and that prod-deploy did not already
 * roll back from (a version that failed its checks).
 */
export function previousDeployment(deployments, currentId) {
  const sorted = [...deployments].sort((a, b) =>
    String(b.created_on).localeCompare(String(a.created_on)),
  );
  const failed = new Set();
  for (const deployment of sorted) {
    const message = deployment.annotations?.["workers/message"] ?? "";
    const match = ROLLED_BACK_FROM.exec(message);
    if (match) failed.add(match[1]);
  }
  for (const deployment of sorted) {
    const only =
      deployment.versions?.length === 1 &&
      deployment.versions[0].percentage === 100
        ? deployment.versions[0].version_id
        : null;
    if (!only || only === currentId || failed.has(only)) continue;
    return { versionId: only, createdOn: deployment.created_on };
  }
  return null;
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

/** The real side effects. Tests pass their own object with the same shape. */
export function realIo() {
  const ctx = context();
  return {
    async cf(path, { method = "GET", body } = {}) {
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
    },
    run: (command, args, options) => run(command, args, options),
    wrangler: (args, options) =>
      run(process.execPath, [wranglerBin(), ...args], options),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    say: (line = "") => console.log(line),
    localMigrations: () =>
      readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")),
    readExample: () =>
      readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8"),
    readRootConfig: () =>
      existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null,
    writeRootConfig: (text) =>
      writeFileSync(CONFIG_PATH, text, { mode: 0o600 }),
    removeRootConfig: () => rmSync(CONFIG_PATH, { force: true }),
    makeTempDir: () => mkdtempSync(join(tmpdir(), "prod-deploy-bundle-")),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  };
}

const d1 = (io, sql) =>
  io
    .cf(`/d1/database/${PROD.d1Id}/query`, { method: "POST", body: { sql } })
    .then((results) => results[0]?.results ?? []);

async function currentVersion(io) {
  const { deployments } = await io.cf(
    `/workers/scripts/${PROD.workerName}/deployments`,
  );
  const top = deployments?.[0];
  const id = top?.versions?.[0]?.version_id;
  if (!id || top.versions.length !== 1 || top.versions[0].percentage !== 100) {
    throw new Error(
      "Live Worker is not on a single 100% version; refusing to continue.",
    );
  }
  const { items } = await io.cf(`/workers/scripts/${PROD.workerName}/versions`);
  const number = items?.find((item) => item.id === id)?.number;
  return { id, number };
}

async function rowCounts(io) {
  const tables = await d1(
    io,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  const virtual = tables
    .filter((t) => /VIRTUAL TABLE/i.test(t.sql ?? ""))
    .map((t) => t.name);
  const counts = {};
  for (const { name } of tables) {
    if (virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    const [row] = await d1(
      io,
      `SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`,
    );
    counts[name] = row.n;
  }
  return counts;
}

async function appliedMigrations(io) {
  const rows = await d1(io, "SELECT name FROM d1_migrations ORDER BY id");
  return rows.map((row) => row.name);
}

async function writeConfig(io) {
  const settings = await io.cf(`/workers/scripts/${PROD.workerName}/settings`);
  const bindings = settings.bindings ?? [];
  const vars = {};
  for (const binding of bindings) {
    if (binding.type === "plain_text") vars[binding.name] = binding.text;
  }
  const config = buildProdConfig(io.readExample(), {
    ...vars,
    ...agentVarsFromEnv(io.env ?? process.env),
  });
  assertProdConfig(config);
  io.writeRootConfig(`${JSON.stringify(config, null, 2)}\n`);
  return {
    config,
    secretValues: Object.values(vars),
    drift: bindingDrift(bindings, config),
  };
}

/** Run `fn` with the root wrangler.jsonc, then put the old one back. */
async function withRootConfig(io, fn) {
  const saved = io.readRootConfig();
  try {
    return await fn();
  } finally {
    // A file left by an older run of this script points at live: drop it.
    if (saved === null || saved.includes(PROD.d1Id)) io.removeRootConfig();
    else io.writeRootConfig(saved);
  }
}

const git = (io, ...args) => io.run("git", args).trim();

async function smokeCheck(io, { attempts = 4, delayMs = 5000 } = {}) {
  let results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    results = [];
    for (const path of SMOKE_PATHS) {
      try {
        const response = await io.fetch(`${PROD.publicUrl}${path}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        results.push({ path, status: response.status });
      } catch (error) {
        results.push({ path, status: 0, error: error.message });
      }
    }
    if (results.every((r) => r.status > 0 && r.status < 400)) return results;
    if (attempt < attempts) await io.sleep(delayMs);
  }
  return results;
}

async function rollbackTo(io, versionId, fromId) {
  const path = `/workers/scripts/${PROD.workerName}/deployments`;
  const body = {
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
  };
  const message = fromId
    ? `prod-deploy: rolled back from ${fromId}`
    : "prod-deploy: rollback";
  try {
    await io.cf(path, {
      method: "POST",
      body: { ...body, annotations: { "workers/message": message } },
    });
  } catch {
    // The note only helps a later manual rollback skip a failed version;
    // never let it stand in the way of the rollback itself.
    await io.cf(path, { method: "POST", body });
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

export async function status(io) {
  const version = await currentVersion(io);
  const counts = await rowCounts(io);
  const pending = pendingMigrations(
    io.localMigrations(),
    await appliedMigrations(io),
  );
  io.say(`Live Worker version: #${version.number ?? "?"} (${version.id})`);
  io.say(
    `Local checkout: ${git(io, "rev-parse", "--short", "HEAD")} ${git(io, "log", "-1", "--format=%s")}`,
  );
  io.say(
    `Live tables: ${Object.keys(counts).length}, rows in total: ${total(counts)}`,
  );
  io.say(
    `Pending migrations: ${pending.length === 0 ? "none" : pending.join(", ")}`,
  );
}

/** Refuse a checkout that is not exactly origin/main, committed. */
function checkCheckout(io) {
  if (git(io, "status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error(
      "Working tree has uncommitted changes; commit or stash first.",
    );
  }
  git(io, "fetch", "origin", "main");
  if (git(io, "rev-parse", "HEAD") !== git(io, "rev-parse", "origin/main")) {
    throw new Error(
      "HEAD is not the same commit as origin/main; refusing to ship it.",
    );
  }
  const tracked = git(io, "ls-tree", "--name-only", "HEAD", "migrations/")
    .split("\n")
    .filter(Boolean);
  const stray = strayMigrations(io.localMigrations(), tracked);
  if (stray.length > 0) {
    throw new Error(
      `migrations/ holds files that are not committed on main: ${stray.join(", ")}. They would be applied to live; move or delete them first.`,
    );
  }
}

/** Returns true when live ended on the new version with every check passed. */
export async function deploy(io, { dryRun }) {
  checkCheckout(io);
  const head = git(io, "rev-parse", "--short", "HEAD");
  io.say(`Shipping ${head} ${dryRun ? "[dry run: nothing will change]" : ""}`);
  return withRootConfig(io, () => deploySteps(io, { dryRun }));
}

async function deploySteps(io, { dryRun }) {
  const say = io.say;
  const { config, secretValues, drift } = await writeConfig(io);
  if (drift.unknown.length > 0) {
    throw new Error(
      `Live has bindings that wrangler.jsonc.example lacks, and a deploy would remove them: ${drift.unknown.join(", ")}. Add them to the example first.`,
    );
  }
  say(
    "1/9 Config rebuilt from the example + live settings (matches production).",
  );
  if (drift.restored.length > 0) {
    say(
      `    note: vars live does not set will take the example's default: ${drift.restored.join(", ")}`,
    );
  }

  const rollbackTarget = await currentVersion(io);
  say(
    `2/9 Rollback target: version #${rollbackTarget.number ?? "?"} (${rollbackTarget.id})`,
  );

  const bookmark = (
    await io.cf(`/d1/database/${PROD.d1Id}/time_travel/bookmark`)
  ).bookmark;
  say(`3/9 Time Travel bookmark saved: ${bookmark}`);

  // Build everything before any write, so a build error can never leave live
  // half-upgraded (new tables, old code).
  io.run("pnpm", ["--filter", "@flaremo/web", "build"]);
  const bundleDir = io.makeTempDir();
  try {
    io.wrangler(
      [
        "deploy",
        "--dry-run",
        "--outdir",
        bundleDir,
        "--config",
        "../../wrangler.jsonc",
        "--keep-vars",
      ],
      { cwd: join(ROOT, "apps/worker"), secretValues },
    );
  } finally {
    io.removeDir(bundleDir);
  }
  say("4/9 Web app and Worker bundle built.");

  const pending = pendingMigrations(
    io.localMigrations(),
    await appliedMigrations(io),
  );
  // Taken as late as possible, so normal diary use during the build cannot
  // make the comparison cry wolf.
  const before = await rowCounts(io);
  say(
    `5/9 Baseline: ${Object.keys(before).length} tables, ${total(before)} rows. Pending migrations: ${pending.length === 0 ? "none" : pending.join(", ")}`,
  );

  if (dryRun) {
    say("Dry run finished. Nothing on live was changed.");
    return true;
  }

  assertProdConfig(config);
  let migrated = false;
  try {
    if (pending.length > 0) {
      io.wrangler(
        [
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          CONFIG_PATH,
        ],
        { secretValues },
      );
      migrated = true;
      const afterMigrations = await rowCounts(io);
      const { fatal } = compareCounts(before, afterMigrations);
      if (fatal.length > 0) {
        throw new Error(
          `rows dropped during the migrations, so the Worker was not deployed: ${fatal.join("; ")}`,
        );
      }
      say(`6/9 Applied ${pending.length} migration(s); row counts held.`);
    } else {
      say("6/9 No migrations to apply.");
    }

    io.wrangler(["deploy", "--config", "../../wrangler.jsonc", "--keep-vars"], {
      cwd: join(ROOT, "apps/worker"),
      secretValues,
    });
    const after = await currentVersion(io);
    if (after.id === rollbackTarget.id) {
      throw new Error("Deploy finished but the live version did not change.");
    }
    say(`7/9 Deployed: version #${after.number ?? "?"} (${after.id}).`);

    await io.sleep(5000);
    const afterCounts = await rowCounts(io);
    const { fatal, notes } = compareCounts(before, afterCounts);
    if (fatal.length > 0) {
      throw new Error(
        fatal.map((line) => `row count dropped: ${line}`).join("; "),
      );
    }
    say(
      `8/9 Row counts held: ${Object.keys(afterCounts).length} tables, ${total(afterCounts)} rows (was ${total(before)}).`,
    );
    for (const note of notes) say(`    note: ${note}`);

    const smoke = await smokeCheck(io);
    const bad = smoke.filter((s) => s.status === 0 || s.status >= 400);
    if (bad.length > 0) {
      throw new Error(
        bad
          .map(
            (s) =>
              `${s.path} ${s.status ? `answered ${s.status}` : `failed: ${s.error}`}`,
          )
          .join("; "),
      );
    }
    say(`9/9 Site answers, including ${SMOKE_PATHS.at(-1)}, which reads D1.`);
    say("");
    say(
      `Done. Live is on version #${after.number ?? "?"}. Previous version #${rollbackTarget.number ?? "?"} can be restored with: node scripts/fork/prod-deploy.mjs rollback --confirm flaremo`,
    );
    return true;
  } catch (error) {
    say(`PROBLEM: ${error.message}`);
    await recover(io, { rollbackTarget, bookmark, migrated, pending });
    return false;
  }
}

/** Put the Worker back after a failed deploy and say exactly where live is. */
async function recover(io, { rollbackTarget, bookmark, migrated, pending }) {
  const say = io.say;
  const target = `#${rollbackTarget.number ?? "?"} (${rollbackTarget.id})`;
  let live = null;
  try {
    live = await currentVersion(io);
  } catch {
    // Unknown: roll back anyway.
  }
  if (live?.id === rollbackTarget.id) {
    say(`The Worker was not changed: live is still on version ${target}.`);
  } else {
    say(`Rolling the Worker back to version ${target} ...`);
    try {
      await rollbackTo(io, rollbackTarget.id, live?.id);
      say("Worker rolled back.");
    } catch (error) {
      say(`ROLLBACK FAILED: ${error.message}`);
      say(
        `Live is on the NEW, unchecked version${live ? ` #${live.number ?? "?"} (${live.id})` : ""}. Roll it back by hand now: node scripts/fork/prod-deploy.mjs rollback --confirm flaremo --version ${rollbackTarget.id}, or the Worker's Deployments page in the Cloudflare dashboard.`,
      );
    }
  }
  if (migrated) {
    say(
      `The database schema is NOT rolled back: ${pending.length} migration(s) stay applied (${pending.join(", ")}). Migrations only add, so the old Worker keeps working on the new tables.`,
    );
  }
  say(
    `No data was restored automatically. If data needs undoing, Time Travel bookmark ${bookmark} restores the whole database to before this deploy (wrangler d1 time-travel restore flaremo --bookmark=...), only after checking with Anon.`,
  );
}

export async function rollback(io, { version } = {}) {
  const current = await currentVersion(io);
  const { items } = await io.cf(`/workers/scripts/${PROD.workerName}/versions`);
  let targetId = version;
  if (!targetId) {
    const { deployments } = await io.cf(
      `/workers/scripts/${PROD.workerName}/deployments`,
    );
    targetId = previousDeployment(deployments ?? [], current.id)?.versionId;
    if (!targetId) {
      throw new Error(
        "No earlier healthy deployment found; pass --version <id> to choose one.",
      );
    }
  }
  if (targetId === current.id) {
    throw new Error(`Version ${targetId} is already live.`);
  }
  const target = items?.find((item) => item.id === targetId);
  if (version && !target) {
    throw new Error(`Version ${version} is not one of the Worker's versions.`);
  }
  io.say(
    `Rolling back from #${current.number ?? "?"} (${current.id}) to #${target?.number ?? "?"} (${targetId}).`,
  );
  await rollbackTo(io, targetId, current.id);
  io.say(
    `Live Worker is back on version #${target?.number ?? "?"} (${targetId}). Data was not touched.`,
  );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      confirm: { type: "string" },
      version: { type: "string" },
    },
  });
  const command = positionals[0];
  const io = realIo();
  if (command === "status") {
    await status(io);
  } else if (command === "deploy") {
    if (!values["dry-run"] && values.confirm !== PROD.workerName) {
      throw new Error(
        "Live deploys need --confirm flaremo (or use --dry-run).",
      );
    }
    if (!(await deploy(io, { dryRun: values["dry-run"] }))) {
      process.exitCode = 1;
    }
  } else if (command === "rollback") {
    if (values.confirm !== PROD.workerName) {
      throw new Error("Rollback needs --confirm flaremo.");
    }
    await rollback(io, { version: values.version });
  } else {
    throw new Error(
      "Usage: prod-deploy.mjs <status|deploy|rollback> [--dry-run] [--confirm flaremo] [--version <id>]",
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
