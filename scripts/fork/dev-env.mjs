#!/usr/bin/env node

// Fork-only ops tooling: stand up and refresh a separate dev clone of the live
// FlareMo (Worker flaremo-dev, D1 flaremo-dev, R2 flaremo-dev-attachments, ...)
// on the same Cloudflare account, so new commits are tested on a copy of real
// data before they go live. See docs/fork-dev-environment.md.
//
//   node scripts/fork/dev-env.mjs config      write the dev wrangler config
//   node scripts/fork/dev-env.mjs provision   create dev resources and secrets
//   node scripts/fork/dev-env.mjs clone       copy live data into dev, then
//                                             rehearse the pending migrations
//   node scripts/fork/dev-env.mjs deploy      build and deploy the dev Worker
//   node scripts/fork/dev-env.mjs status      show what exists and its level
//
// Production is never written. Every wrangler call passes through
// assertSafeWranglerCall (./dev-env-guard.mjs), which refuses write-capable
// commands unless the config and every target are flaremo-dev* resources.
//
// Layout: dev-env-guard.mjs (the production guard), dev-env-config.mjs (the
// dev wrangler config), dev-env-data.mjs (pure planners and SQL builders) and
// this file (the wrangler runner, the commands and the CLI).

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertDerivedIndexesComplete,
  DERIVED_INDEX_TABLES,
  POST_RESTORE_DERIVED_SQL,
  REBUILDABLE_TABLES,
  RESTORE_TABLES,
} from "../persistence-manifest.mjs";
import {
  isAlreadyExists,
  isPlaceholderDatabaseId,
  listedResourceExists,
  resourcesFromConfig,
} from "../provision-cloudflare.mjs";
import { inspectWorkerSecret } from "../sync-worker-secrets.mjs";
import {
  buildDevConfig,
  buildMigrationLevelConfig,
  DEV,
  describeConfig,
  PLACEHOLDER_D1_ID,
  parseConfigText,
} from "./dev-env-config.mjs";
import {
  buildCountsQuery,
  buildImportSql,
  discoverExtraTables,
  listLocalMigrations,
  orderByForeignKeys,
  planClearTables,
  planExportBatches,
  planMigrationLevels,
  planTableCopy,
  quoteIdent,
  splitMigrationTracks,
  summarizeCounts,
} from "./dev-env-data.mjs";
import {
  assertSafeWranglerCall,
  PROD,
  ProdGuardError,
} from "./dev-env-guard.mjs";

export * from "./dev-env-config.mjs";
export * from "./dev-env-data.mjs";
export * from "./dev-env-guard.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const D1_STATEMENT_LIMIT_BYTES = 100_000;
const R2_PUT_LIMIT_BYTES = 300 * 1024 * 1024;

// Secrets the Worker needs to start (apps/worker/src/auth-env.ts):
// BETTER_AUTH_SECRET signs sessions and Memos JWTs and must be >= 32 chars;
// FLAREMO_BOOTSTRAP_SECRET (>= 32) gates the one-time bootstrap. Everything
// else (RESEND_API_KEY, ASR keys, OAuth, FLAREMO_*_CONFIG_KEY, recovery) is
// optional and deliberately left unset in dev.
export const REQUIRED_WORKER_SECRETS = Object.freeze([
  "BETTER_AUTH_SECRET",
  "FLAREMO_BOOTSTRAP_SECRET",
]);

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

// ---------------------------------------------------------------------------
// Environment for wrangler children

/**
 * Environment for wrangler child processes.
 *
 * The token comes from CLOUDFLARE_API_TOKEN, then the owner's CLOUDFLARE_API,
 * then the literal "proxy-injected". The placeholder only keeps wrangler from
 * starting an interactive OAuth login: in the sandbox a network proxy swaps the
 * Authorization header for api.cloudflare.com with the real token. Nothing in
 * this module prints the environment.
 */
export function wranglerChildEnv(parentEnv = process.env) {
  const pick = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const env = { ...parentEnv };
  env.CLOUDFLARE_API_TOKEN =
    pick(parentEnv.CLOUDFLARE_API_TOKEN) ??
    pick(parentEnv.CLOUDFLARE_API) ??
    "proxy-injected";
  // The owner's alias is not a variable wrangler reads; keep it out of the
  // child.
  delete env.CLOUDFLARE_API;
  const accountId = pick(parentEnv.CLOUDFLARE_ACCOUNT_ID);
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  env.WRANGLER_SEND_METRICS = "false";
  // Non-interactive: no migration confirmation prompt, no OAuth login.
  env.CI = "true";
  return env;
}

// ---------------------------------------------------------------------------
// Process plumbing

export class WranglerError extends Error {
  constructor(summary, result, redact = []) {
    let output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    for (const value of redact) {
      if (value) output = output.replaceAll(value, "[redacted]");
    }
    super(
      `wrangler ${summary} failed (exit ${result.status})${
        output ? `:\n${output.slice(-4000)}` : ""
      }`,
    );
    this.name = "WranglerError";
    this.status = result.status;
    this.output = output;
  }
}

const TRANSIENT_RE =
  /Authentication error|\b10000\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b|\b429\b|too many requests|temporarily unavailable|try again/i;

export function isTransientWranglerError(error) {
  return error instanceof WranglerError && TRANSIENT_RE.test(error.output);
}

function summarizeArgv(argv) {
  return argv
    .map((token, at) => {
      if (argv[at - 1] === "--config") return basename(token);
      const text = token.length > 110 ? `${token.slice(0, 107)}...` : token;
      return /[\s"'`$;()]/.test(text) ? JSON.stringify(text) : text;
    })
    .join(" ");
}

export function parseJsonLoose(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // wrangler can print banner or warning lines before the JSON; try every
    // line that opens a JSON value until one parses to the end.
    const lines = trimmed.split("\n");
    for (let at = 0; at < lines.length; at += 1) {
      if (!/^\s*[[{]/.test(lines[at])) continue;
      try {
        return JSON.parse(lines.slice(at).join("\n"));
      } catch {
        // not the start of the JSON document
      }
    }
    throw new Error("wrangler did not print JSON where JSON was expected.");
  }
}

function wranglerBinPath() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler;
  return resolve(dirname(packagePath), bin);
}

// Runs wrangler's own entry point with node: no shell (SQL passes through
// untouched on every platform) and no pnpm start-up cost per call.
function defaultExec(argv, { input, capture, env, cwd }) {
  const result = spawnSync(process.execPath, [wranglerBinPath(), ...argv], {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: [
      input === undefined ? "ignore" : "pipe",
      capture ? "pipe" : "inherit",
      capture ? "pipe" : "inherit",
    ],
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function defaultRunLocal(command, args, { cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
}

function defaultSleep(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeFilename(key) {
  return `${basename(key).replaceAll(/[^A-Za-z0-9_.-]/g, "_")}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// The tool

export class DevEnv {
  constructor({
    repoRoot = REPO_ROOT,
    stateDir = join(repoRoot, ".wrangler", "fork-dev"),
    backupsDir = join(repoRoot, "backups"),
    migrationsDir = join(repoRoot, "migrations"),
    env = process.env,
    exec = defaultExec,
    runLocal = defaultRunLocal,
    log = console.log,
    sleep = defaultSleep,
    retryDelayMs = 2000,
    now = () => new Date(),
  } = {}) {
    this.env = env;
    this.exec = exec;
    this.runLocal = runLocal;
    this.log = log;
    this.sleep = sleep;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
    this.paths = {
      repoRoot,
      stateDir,
      backupsDir,
      devConfig: join(stateDir, "wrangler.dev.jsonc"),
      levelConfig: join(stateDir, "wrangler.dev-prod-level.jsonc"),
      levelMigrationsDir: join(stateDir, "migrations-prod-level"),
      state: join(stateDir, "state.json"),
      migrationsDir,
      example: join(repoRoot, "wrangler.jsonc.example"),
    };
    this.allowedConfigs = new Set([
      resolve(this.paths.devConfig),
      resolve(this.paths.levelConfig),
    ]);
    this.steps = [];
  }

  // -- state and config -----------------------------------------------------

  readState() {
    try {
      return JSON.parse(readFileSync(this.paths.state, "utf8"));
    } catch {
      return {};
    }
  }

  writeState(patch) {
    mkdirSync(this.paths.stateDir, { recursive: true });
    const next = { ...this.readState(), ...patch };
    writeFileSync(this.paths.state, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /** Settings precedence: CLI flag, then FLAREMO_DEV_* env, then saved state. */
  resolveSettings(options = {}, { allowPlaceholder = false } = {}) {
    const clean = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const state = this.readState();
    const databaseId =
      clean(options.d1Id) ??
      clean(this.env.FLAREMO_DEV_D1_ID) ??
      clean(state.d1Id) ??
      (allowPlaceholder ? PLACEHOLDER_D1_ID : undefined);
    if (!databaseId) {
      throw new Error(
        "The dev D1 id is not known yet: run provision first, or pass --d1-id / set FLAREMO_DEV_D1_ID.",
      );
    }
    const envOrigins = (clean(this.env.FLAREMO_DEV_TRUSTED_ORIGINS) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      databaseId,
      publicUrl:
        clean(options.publicUrl) ??
        clean(this.env.FLAREMO_DEV_PUBLIC_URL) ??
        DEV.publicUrl,
      trustedOrigins: [...(options.trustedOrigins ?? []), ...envOrigins],
      ratelimitNamespaceId:
        clean(options.ratelimitNamespaceId) ??
        clean(this.env.FLAREMO_DEV_RATELIMIT_NAMESPACE_ID) ??
        DEV.ratelimitNamespaceId,
    };
  }

  writeConfig(settings) {
    const text = buildDevConfig({
      exampleText: readFileSync(this.paths.example, "utf8"),
      repoRoot: this.paths.repoRoot,
      migrationsDir: resolve(this.paths.migrationsDir),
      ...settings,
    });
    mkdirSync(this.paths.stateDir, { recursive: true });
    writeFileSync(this.paths.devConfig, text);
    this.settings = settings;
    this.devConfigText = text;
    return { path: this.paths.devConfig, config: parseConfigText(text) };
  }

  /** Remember a newly discovered dev D1 id and refresh the config with it. */
  adoptD1Id(id) {
    this.writeState({ d1Id: id, updatedAt: this.now().toISOString() });
    return this.writeConfig({ ...this.settings, databaseId: id });
  }

  devResources() {
    return resourcesFromConfig(parseConfigText(this.devConfigText));
  }

  requireRealD1Id() {
    if (isPlaceholderDatabaseId(this.settings.databaseId)) {
      throw new Error(
        "The dev D1 id is still a placeholder: run provision first.",
      );
    }
  }

  // -- wrangler -------------------------------------------------------------

  /** Run wrangler through the production guard. Returns the raw result. */
  wrangler(
    args,
    {
      config = this.paths.devConfig,
      capture = true,
      input,
      allowFailure = false,
      redact = [],
    } = {},
  ) {
    const configPath = resolve(config);
    if (!this.allowedConfigs.has(configPath)) {
      throw new ProdGuardError(
        `Refusing wrangler config ${configPath}: only the generated dev configs may be used.`,
      );
    }
    const argv = [...args, "--config", configPath];
    const verdict = assertSafeWranglerCall(
      argv,
      parseConfigText(readFileSync(configPath, "utf8"), configPath),
    );
    this.log(
      `$ wrangler ${summarizeArgv(argv)}${verdict.writeCapable ? "" : "   (read-only)"}`,
    );
    const result = this.exec(argv, {
      input,
      capture,
      env: wranglerChildEnv(this.env),
      cwd: this.paths.repoRoot,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0 && !allowFailure) {
      throw new WranglerError(summarizeArgv(argv), result, redact);
    }
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      output,
    };
  }

  withRetry(fn, attempts = 3) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        if (attempt >= attempts || !isTransientWranglerError(error)) {
          throw error;
        }
        this.log(
          `transient failure (attempt ${attempt}/${attempts}); retrying`,
        );
        this.sleep(this.retryDelayMs * attempt);
      }
    }
  }

  /** Run read-only SQL; returns one rows-array per statement. */
  d1Select(target, sql, options = {}) {
    const result = this.withRetry(() =>
      this.wrangler(
        ["d1", "execute", target, "--remote", "--command", sql, "--json"],
        options,
      ),
    );
    const payload = parseJsonLoose(result.stdout);
    if (!Array.isArray(payload)) {
      // With --json wrangler reports a failed query as {"error": {...}}.
      if (payload?.error) {
        throw new WranglerError(`d1 execute ${target}`, {
          status: result.status,
          stdout: JSON.stringify(payload.error),
        });
      }
      throw new Error(`Unexpected D1 response for ${target}.`);
    }
    return payload.map((entry) => {
      if (entry?.success === false) {
        throw new Error(`D1 query failed on ${target}.`);
      }
      return entry?.results ?? [];
    });
  }

  /**
   * Run several read-only statements in one call (one D1 batch, so one
   * snapshot). Falls back to one call each if D1 does not answer per statement.
   */
  d1SelectMany(target, statements, options = {}) {
    if (statements.length === 0) return [];
    const sql = statements.map((statement) => `${statement};`).join("\n");
    const sets = this.d1Select(target, sql, options);
    if (sets.length === statements.length) return sets;
    this.log(
      `D1 returned ${sets.length} result sets for ${statements.length} statements; querying one by one`,
    );
    return statements.map(
      (statement) => this.d1Select(target, statement, options)[0] ?? [],
    );
  }

  listD1() {
    const { stdout } = this.wrangler(["d1", "list", "--json"]);
    const parsed = parseJsonLoose(stdout);
    if (!Array.isArray(parsed)) {
      throw new Error("Unexpected output from `wrangler d1 list --json`.");
    }
    return parsed.map((item) => ({ name: item?.name, id: item?.uuid }));
  }

  /** The id wrangler reports for `name`, or null. */
  findD1(name) {
    return this.listD1().find((database) => database.name === name)?.id ?? null;
  }

  /** Applied migration names in order; [] when no migration table exists. */
  listAppliedMigrations(target) {
    try {
      const [rows] = this.d1Select(
        target,
        'SELECT name FROM "d1_migrations" ORDER BY id',
      );
      return rows.map((row) => String(row.name));
    } catch (error) {
      if (
        error instanceof WranglerError &&
        /no such table/i.test(error.output)
      ) {
        return [];
      }
      throw error;
    }
  }

  /** Column names per table ([] for a table that does not exist). */
  tableColumns(target, tables) {
    const sets = this.d1SelectMany(
      target,
      tables.map((table) => `PRAGMA table_info(${quoteIdent(table)})`),
    );
    return new Map(
      tables.map((table, at) => [
        table,
        (sets[at] ?? []).map((row) => String(row.name)),
      ]),
    );
  }

  /** Row counts for tables the caller knows exist. */
  countRows(target, tables) {
    const [[row]] = this.d1Select(target, buildCountsQuery(tables));
    return Object.fromEntries(
      tables.map((table) => [table, Number(row?.[table] ?? 0)]),
    );
  }

  applyMigrations(config = this.paths.devConfig) {
    this.withRetry(() =>
      this.wrangler(["d1", "migrations", "apply", "DB", "--remote"], {
        config,
        capture: false,
      }),
    );
  }

  runSqlFile(path) {
    this.withRetry(() =>
      this.wrangler(
        ["d1", "execute", "DB", "--remote", "--file", path, "--yes"],
        { capture: false },
      ),
    );
  }

  /**
   * Confirm the production D1 is the one we think it is before reading it.
   * Returns the verified id, which is what the read-only queries target.
   */
  verifyProdTarget() {
    const id = this.findD1(PROD.d1Name);
    if (!id) {
      throw new Error(
        `No D1 database named ${PROD.d1Name} on this account; is the token for the right account?`,
      );
    }
    if (normalize(id) !== normalize(PROD.d1Id)) {
      throw new Error(
        `D1 ${PROD.d1Name} has id ${id}, expected ${PROD.d1Id}; refusing to read an unexpected database.`,
      );
    }
    return PROD.d1Id;
  }

  /** Find the dev D1, adopt its id into state and config, or null. */
  syncDevD1() {
    const id = this.findD1(DEV.d1Name);
    if (!id) return null;
    if (normalize(id) === normalize(PROD.d1Id)) {
      throw new ProdGuardError(
        `D1 ${DEV.d1Name} resolves to the production id; refusing to continue.`,
      );
    }
    if (normalize(id) !== normalize(this.settings.databaseId)) {
      this.adoptD1Id(id);
    }
    return id;
  }

  /** Run a create command; "already exists" counts as present. */
  createResource(label, args, outcome) {
    const result = this.wrangler(args, { input: "n\n", allowFailure: true });
    if (result.status !== 0 && !isAlreadyExists(result.output)) {
      throw new Error(`Could not create ${label}:\n${result.output}`);
    }
    (result.status === 0 ? outcome.created : outcome.existing).push(label);
  }

  step(name, fn) {
    this.log(`\n==> ${name}`);
    const started = Date.now();
    try {
      const value = fn();
      this.steps.push(`${name}: ok`);
      this.log(`    done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return value;
    } catch (error) {
      this.steps.push(`${name}: failed`);
      throw error;
    }
  }

  // -- config ---------------------------------------------------------------

  config(options = {}) {
    const settings = this.resolveSettings(options, { allowPlaceholder: true });
    const written = this.writeConfig(settings);
    // An explicit real id is remembered; a placeholder never is.
    if (options.d1Id && !isPlaceholderDatabaseId(settings.databaseId)) {
      this.writeState({
        d1Id: settings.databaseId,
        updatedAt: this.now().toISOString(),
      });
    }
    this.log(`Wrote ${written.path}`);
    for (const [label, value] of describeConfig(written.config)) {
      this.log(`  ${label.padEnd(11)} ${value}`);
    }
    return written;
  }

  // -- provision ------------------------------------------------------------

  provision(options = {}) {
    const settings = this.resolveSettings(options, { allowPlaceholder: true });
    this.writeConfig(settings);
    const outcome = { created: [], existing: [], secretsSet: [] };

    this.step("D1 database", () => this.ensureDevD1(outcome));
    const resources = this.devResources();
    this.step("R2 bucket", () => this.ensureBucket(resources, outcome));
    this.step("Queues", () => this.ensureQueues(resources, outcome));
    this.step("Vectorize indexes", () =>
      this.ensureVectorize(resources, outcome),
    );
    if (options.skipSecrets) {
      this.log("\n==> Worker secrets\n    skipped (--skip-secrets)");
    } else {
      outcome.secretsSet = this.step("Worker secrets", () =>
        this.ensureSecrets(),
      );
    }

    const list = (items) => (items.length ? items.join(", ") : "nothing");
    this.log(`\nCreated: ${list(outcome.created)}`);
    this.log(`Already present: ${list(outcome.existing)}`);
    if (outcome.secretsSet.length > 0) {
      this.log(
        `Secrets set (values are never shown): ${outcome.secretsSet.join(", ")}`,
      );
    }
    this.log(
      "\nNext: node scripts/fork/dev-env.mjs clone, then node scripts/fork/dev-env.mjs deploy",
    );
    return outcome;
  }

  ensureDevD1(outcome) {
    let id = this.syncDevD1();
    if (id) {
      outcome.existing.push(`D1 ${DEV.d1Name}`);
    } else {
      this.createResource(
        `D1 ${DEV.d1Name}`,
        ["d1", "create", DEV.d1Name],
        outcome,
      );
      id = this.syncDevD1();
      if (!id) {
        throw new Error(`Created D1 ${DEV.d1Name} but could not read its id.`);
      }
    }
    this.log(`    id ${id}`);
  }

  ensureBucket(resources, outcome) {
    const listed = this.wrangler(["r2", "bucket", "list"]);
    if (listedResourceExists(listed.output, resources.bucketName)) {
      outcome.existing.push(`R2 ${resources.bucketName}`);
      return;
    }
    this.createResource(
      `R2 ${resources.bucketName}`,
      ["r2", "bucket", "create", resources.bucketName],
      outcome,
    );
  }

  ensureQueues(resources, outcome) {
    const listed = this.wrangler(["queues", "list"]);
    for (const queue of resources.queues) {
      if (listedResourceExists(listed.output, queue)) {
        outcome.existing.push(`Queue ${queue}`);
      } else {
        this.createResource(
          `Queue ${queue}`,
          ["queues", "create", queue],
          outcome,
        );
      }
    }
  }

  listVectorizeIndexes() {
    const listed = parseJsonLoose(
      this.wrangler(["vectorize", "list", "--json"]).stdout,
    );
    return Array.isArray(listed)
      ? listed
      : (listed?.indexes ?? listed?.result ?? []);
  }

  ensureVectorize(resources, outcome) {
    const indexes = this.listVectorizeIndexes();
    for (const name of resources.indexes) {
      const found = indexes.find((item) => item?.name === name);
      if (!found) {
        this.createResource(
          `Vectorize ${name}`,
          [
            "vectorize",
            "create",
            name,
            "--dimensions",
            String(resources.dimensions),
            "--metric",
            resources.metric,
          ],
          outcome,
        );
        continue;
      }
      const dimensions = Number(found.config?.dimensions ?? found.dimensions);
      if (dimensions && dimensions !== resources.dimensions) {
        throw new Error(
          `Vectorize index ${name} has ${dimensions} dimensions; FlareMo needs ${resources.dimensions}.`,
        );
      }
      outcome.existing.push(`Vectorize ${name}`);
    }
  }

  /** Names of the secrets the dev Worker has; [] while it does not exist. */
  listWorkerSecrets() {
    const listed = this.wrangler(["secret", "list", "--name", DEV.workerName], {
      allowFailure: true,
    });
    if (listed.status === 0) {
      const parsed = parseJsonLoose(listed.stdout);
      return (Array.isArray(parsed) ? parsed : []).map((item) => item?.name);
    }
    if (/not found/i.test(listed.output)) return null;
    throw new WranglerError("secret list", listed);
  }

  /** Set the required Worker secrets that are missing. Returns their names. */
  ensureSecrets() {
    const present = this.listWorkerSecrets() ?? [];
    const set = [];
    for (const name of REQUIRED_WORKER_SECRETS) {
      if (present.includes(name)) {
        this.log(`    ${name}: already set`);
        continue;
      }
      let value = generateSecret();
      while (inspectWorkerSecret(name, value).status !== "ok") {
        value = generateSecret();
      }
      // The value goes to wrangler's stdin only: never argv, a log or a file.
      this.wrangler(["secret", "put", name, "--name", DEV.workerName], {
        input: `${value}\n`,
        redact: [value],
      });
      set.push(name);
      this.log(`    ${name}: set (random, not shown)`);
    }
    return set;
  }

  // -- status ---------------------------------------------------------------

  status(options = {}) {
    const settings = this.resolveSettings(options, { allowPlaceholder: true });
    const { config } = this.writeConfig(settings);
    const resources = resourcesFromConfig(config);
    const report = { problems: [] };
    this.log(`Config: ${this.paths.devConfig}`);
    for (const [label, value] of describeConfig(config)) {
      this.log(`  ${label.padEnd(11)} ${value}`);
    }
    const checks = [
      ["D1", () => this.statusD1(report, settings)],
      ["R2", () => this.statusBucket(report, resources)],
      ["Queues", () => this.statusQueues(report, resources)],
      ["Vectorize", () => this.statusVectorize(report, resources)],
      ["Worker", () => this.statusWorker(report)],
    ];
    if (options.withProd) {
      checks.push(["Production", () => this.statusProduction(report)]);
    }
    for (const [label, check] of checks) {
      try {
        check();
      } catch (error) {
        const message = (
          error instanceof Error ? error.message : String(error)
        ).split("\n")[0];
        report.problems.push(`${label}: ${message}`);
        this.log(`  ${label}: could not check (${message})`);
      }
    }
    return report;
  }

  statusD1(report, settings) {
    const id = this.findD1(DEV.d1Name);
    report.d1 = id ?? null;
    if (!id) {
      this.log(`  D1 ${DEV.d1Name}: MISSING (run provision)`);
      return;
    }
    if (normalize(id) !== normalize(settings.databaseId)) this.adoptD1Id(id);
    const applied = this.listAppliedMigrations("DB");
    const local = listLocalMigrations(this.paths.migrationsDir);
    const tracks = splitMigrationTracks(applied);
    report.devLatest = tracks.upstream.at(-1) ?? null;
    report.devFork = tracks.fork;
    const pending = local.filter((name) => !applied.includes(name));
    this.log(
      `  D1 ${DEV.d1Name}: ${id}, latest migration ${report.devLatest ?? "none"}${forkSuffix(tracks.fork)}, ${pending.length} pending in this checkout`,
    );
  }

  statusBucket(report, resources) {
    const listed = this.wrangler(["r2", "bucket", "list"]);
    report.bucket = listedResourceExists(listed.output, resources.bucketName);
    this.log(
      `  R2 ${resources.bucketName}: ${report.bucket ? "exists" : "MISSING"}`,
    );
  }

  statusQueues(report, resources) {
    const listed = this.wrangler(["queues", "list"]);
    report.queues = {};
    for (const queue of resources.queues) {
      report.queues[queue] = listedResourceExists(listed.output, queue);
      this.log(
        `  Queue ${queue}: ${report.queues[queue] ? "exists" : "MISSING"}`,
      );
    }
  }

  statusVectorize(report, resources) {
    const indexes = this.listVectorizeIndexes();
    report.indexes = {};
    for (const name of resources.indexes) {
      report.indexes[name] = indexes.some((item) => item?.name === name);
      this.log(
        `  Vectorize ${name}: ${report.indexes[name] ? "exists" : "MISSING"}`,
      );
    }
  }

  statusWorker(report) {
    const names = this.listWorkerSecrets();
    report.worker = names !== null;
    if (names === null) {
      this.log(`  Worker ${DEV.workerName}: not deployed yet`);
      return;
    }
    report.secrets = Object.fromEntries(
      REQUIRED_WORKER_SECRETS.map((name) => [name, names.includes(name)]),
    );
    const secrets = REQUIRED_WORKER_SECRETS.map(
      (name) => `${name}=${report.secrets[name] ? "set" : "MISSING"}`,
    );
    this.log(
      `  Worker ${DEV.workerName}: exists; secrets ${secrets.join(", ")}`,
    );
  }

  statusProduction(report) {
    const target = this.verifyProdTarget();
    const tracks = splitMigrationTracks(this.listAppliedMigrations(target));
    report.prodLatest = tracks.upstream.at(-1) ?? null;
    report.prodFork = tracks.fork;
    this.log(
      `  Production D1 ${PROD.d1Name}: latest migration ${report.prodLatest}${forkSuffix(tracks.fork)}`,
    );
  }

  // -- deploy ---------------------------------------------------------------

  deploy(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const settings = this.resolveSettings(options, {
      allowPlaceholder: dryRun,
    });
    this.writeConfig(settings);
    if (options.skipBuild) {
      this.log("Skipping the web build (--skip-build)");
    } else {
      this.step("build the web app", () =>
        this.runLocal("pnpm", ["--filter", "@flaremo/web", "build"], {
          cwd: this.paths.repoRoot,
        }),
      );
    }
    if (dryRun) {
      this.log(
        "\n--dry-run: not applying migrations or setting secrets (both need Cloudflare)",
      );
    } else {
      this.requireRealD1Id();
      this.step("check the dev D1", () => {
        if (!this.syncDevD1()) {
          throw new Error(
            `D1 ${DEV.d1Name} does not exist: run provision first.`,
          );
        }
      });
      this.step("Worker secrets", () => this.ensureSecrets());
      this.step("apply pending migrations to dev", () =>
        this.applyMigrations(),
      );
    }
    this.step(
      dryRun ? "wrangler deploy --dry-run" : "deploy the dev Worker",
      () =>
        this.wrangler(["deploy", ...(dryRun ? ["--dry-run"] : [])], {
          capture: false,
        }),
    );
    if (!dryRun) {
      this.log(`\nDeployed. Open ${this.settings.publicUrl}`);
      this.log(
        "Sign in with your live credentials: the clone copied your account.",
      );
    }
    return { dryRun };
  }

  // -- clone ----------------------------------------------------------------

  /**
   * Rehearse the live upgrade on real data: bring dev to production's exact
   * migration level, copy production's data in, then apply the remaining
   * migrations. Production is only read.
   */
  clone(options = {}) {
    const run = this.startCloneRun(options);
    try {
      if (options.reset) this.resetDevD1(options, run.dryRun);

      this.step("verify the dev D1 and the production D1", () =>
        this.verifyCloneTargets(run),
      );
      this.step("read migration levels (production is only read)", () =>
        this.readMigrationPlan(run),
      );
      this.bringDevToProductionLevel(run);
      this.step("inspect schemas and row counts", () =>
        this.inspectSchemas(run),
      );
      this.logCopyPlan(run);
      if (run.dryRun) {
        this.log("\n(dry-run) stopping before any write. Nothing was changed.");
        return run.summary;
      }

      run.exported = this.step("export production data (read-only)", () =>
        this.exportProductionData(run),
      );
      this.step("import into the dev D1", () => this.runSqlFile(run.dumpPath));
      this.step(
        `upgrade rehearsal: apply ${run.plan.upgrade.length} remaining migrations`,
        () => {
          this.log("    migration output follows");
          this.applyMigrations();
        },
      );
      // After the migrations on purpose: this SQL touches tables (memo_hourly_counts)
      // that only exist at the newest schema.
      this.step(
        "rebuild derived state (embedding work, activity counters)",
        () => this.runSqlFile(run.derivedPath),
      );
      run.summary.r2 = this.step("R2 attachment objects", () =>
        this.copyAttachmentObjects(run.prodTarget, run.dumpDir),
      );
      run.counted = this.step("compare row counts", () =>
        this.compareCounts(run),
      );
      return this.finishClone(run);
    } catch (error) {
      throw this.failClone(run, error);
    }
  }

  startCloneRun(options) {
    this.writeConfig(
      this.resolveSettings(options, { allowPlaceholder: false }),
    );
    const stamp = this.now().toISOString().replaceAll(/[:.]/g, "-");
    const dumpDir = join(this.paths.backupsDir, `fork-dev-${stamp}`);
    return {
      options,
      dryRun: Boolean(options.dryRun),
      includeSideEffectTables: Boolean(options.includeSideEffectTables),
      dumpDir,
      dumpPath: join(dumpDir, "prod-data.sql"),
      derivedPath: join(dumpDir, "derived.sql"),
      summary: { dryRun: Boolean(options.dryRun), steps: this.steps },
    };
  }

  verifyCloneTargets(run) {
    this.requireRealD1Id();
    if (!this.syncDevD1()) {
      throw new Error(`D1 ${DEV.d1Name} does not exist: run provision first.`);
    }
    run.prodTarget = this.verifyProdTarget();
    run.summary.prodTarget = run.prodTarget;
  }

  readMigrationPlan(run) {
    const plan = planMigrationLevels({
      localFiles: listLocalMigrations(this.paths.migrationsDir),
      prodApplied: this.listAppliedMigrations(run.prodTarget),
      devApplied: this.listAppliedMigrations("DB"),
    });
    for (const warning of plan.warnings) this.log(`    WARNING ${warning}`);
    this.log(
      `    production is at ${plan.prodLatest}${
        plan.forkApplied.length
          ? ` and has the fork migrations ${plan.forkApplied.join(", ")}`
          : ""
      }`,
    );
    this.log(`    dev is at ${plan.devLatest ?? "no migrations"}`);
    this.log(
      `    to rehearse: ${plan.upgrade.length ? plan.upgrade.join(", ") : "nothing (dev already matches this checkout)"}`,
    );
    run.plan = plan;
    run.summary.plan = plan;
  }

  /** Dev must sit at production's exact level before the data goes in. */
  bringDevToProductionLevel(run) {
    const { plan } = run;
    if (plan.devPending.length === 0) return;
    if (run.dryRun) {
      this.log(
        `\n(dry-run) would bring dev to ${plan.prodLatest}: ${plan.devPending.length} migrations`,
      );
      return;
    }
    this.step(`bring dev to production's level (${plan.prodLatest})`, () => {
      this.prepareLevelMigrations(plan.levelFiles);
      this.applyMigrations(this.paths.levelConfig);
    });
  }

  /**
   * Production tables the persistence manifest does not list (the planner
   * add-on's, say), in foreign-key order. They are copied after the manifest
   * tables, which they depend on.
   */
  discoverForkTables(prodTarget) {
    const [schemaRows] = this.d1Select(
      prodTarget,
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const extras = discoverExtraTables(schemaRows);
    if (extras.length === 0) return [];
    const sets = this.d1SelectMany(
      prodTarget,
      extras.map((table) => `PRAGMA foreign_key_list(${quoteIdent(table)})`),
    );
    const references = new Map(
      extras.map((table, at) => [
        table,
        (sets[at] ?? []).map((row) => String(row.table)),
      ]),
    );
    const { order, cyclic } = orderByForeignKeys(extras, references);
    if (cyclic.length > 0) {
      this.log(
        `    WARNING foreign keys between ${cyclic.join(", ")} form a cycle; copying them in name order`,
      );
    }
    this.log(
      `    tables outside the persistence manifest, copied too: ${order.join(", ")}`,
    );
    return order;
  }

  inspectSchemas(run) {
    const forkTables = this.discoverForkTables(run.prodTarget);
    const tables = [...RESTORE_TABLES, ...forkTables];
    const prodColumns = this.tableColumns(run.prodTarget, tables);
    // In a dry run dev may still be behind production's level; plan against
    // production's own columns then.
    const devColumns =
      run.dryRun && run.plan.devPending.length > 0
        ? new Map(tables.map((table) => [table, prodColumns.get(table) ?? []]))
        : this.tableColumns("DB", tables);
    const tablePlan = planTableCopy({
      tables,
      prodColumns,
      devColumns,
      includeSideEffectTables: run.includeSideEffectTables,
      optional: forkTables,
    });
    for (const { warnings } of tablePlan.copy) {
      for (const warning of warnings) this.log(`    WARNING ${warning}`);
    }
    const inProduction = tablePlan.skipped
      .map(({ table }) => table)
      .filter((table) => (prodColumns.get(table) ?? []).length > 0);
    const prodCounts = this.countRows(run.prodTarget, [
      ...tablePlan.copy.map(({ table }) => table),
      ...inProduction,
      ...DERIVED_INDEX_TABLES,
    ]);
    run.inspected = {
      tables,
      prodColumns,
      devColumns,
      ...tablePlan,
      prodCounts,
    };
    run.summary.copy = tablePlan.copy.map(({ table }) => table);
    run.summary.skipped = tablePlan.skipped;
  }

  logCopyPlan(run) {
    const { copy, skipped, prodCounts } = run.inspected;
    const rows = copy.reduce((sum, { table }) => sum + prodCounts[table], 0);
    this.log(`    copying ${copy.length} tables, ${rows} rows`);
    for (const { table, reason } of skipped) {
      this.log(`    skipping ${table}: ${reason}`);
    }
  }

  /** Read production and write the import file. Returns rows per table. */
  exportProductionData(run) {
    const { copy, devColumns, prodCounts, tables } = run.inspected;
    const batches = planExportBatches(
      copy.map(({ table }) => table),
      prodCounts,
    );
    if (batches.length > 1) {
      this.log(
        `    WARNING the export needs ${batches.length} calls, so it is not a single snapshot; keep production idle until the clone finishes`,
      );
    }
    const byTable = new Map(copy.map((entry) => [entry.table, entry]));
    const inserts = [];
    for (const batch of batches) {
      const sets = this.d1SelectMany(
        run.prodTarget,
        batch.map((table) => {
          const columns = byTable.get(table).columns.map(quoteIdent).join(", ");
          return `SELECT ${columns} FROM ${quoteIdent(table)}`;
        }),
      );
      batch.forEach((table, at) => {
        inserts.push({
          table,
          columns: byTable.get(table).columns,
          rows: sets[at] ?? [],
        });
      });
    }
    const sql = buildImportSql({
      clearTables: planClearTables(devColumns, tables),
      inserts,
    });
    mkdirSync(run.dumpDir, { recursive: true, mode: 0o700 });
    writeFileSync(run.dumpPath, sql, { mode: 0o600 });
    writeFileSync(run.derivedPath, `${POST_RESTORE_DERIVED_SQL.join("\n")}\n`);
    let longest = 0;
    for (const line of sql.split("\n")) {
      longest = Math.max(longest, Buffer.byteLength(line));
    }
    if (longest > D1_STATEMENT_LIMIT_BYTES) {
      this.log(
        `    WARNING a statement is ${longest} bytes; D1 caps statements near ${D1_STATEMENT_LIMIT_BYTES}`,
      );
    }
    return Object.fromEntries(
      inserts.map(({ table, rows }) => [table, rows.length]),
    );
  }

  compareCounts(run) {
    const { copy, skipped, prodColumns, tables } = run.inspected;
    const inProduction = [...copy, ...skipped]
      .map(({ table }) => table)
      .filter((table) => (prodColumns.get(table) ?? []).length > 0);
    const prod = this.countRows(run.prodTarget, [
      ...inProduction,
      ...DERIVED_INDEX_TABLES,
    ]);
    const devTables = tables.filter(
      (table) => (run.inspected.devColumns.get(table) ?? []).length > 0,
    );
    const dev = this.countRows("DB", [
      ...devTables,
      ...REBUILDABLE_TABLES,
      ...DERIVED_INDEX_TABLES,
    ]);
    const result = summarizeCounts({
      copy,
      skipped,
      exported: run.exported,
      prod,
      dev,
    });
    this.printCounts(result.rows);
    const problems = [...result.mismatches];
    try {
      assertDerivedIndexesComplete(dev);
    } catch (error) {
      problems.push(error.message);
    }
    this.log(
      `    derived: embedding_tasks=${dev.embedding_tasks}, memo_hourly_counts=${dev.memo_hourly_counts}`,
    );
    return { rows: result.rows, problems };
  }

  finishClone(run) {
    const { counted, summary } = run;
    summary.counts = counted.rows;
    if (run.options.keepDump) {
      this.log(
        `\nKept ${run.dumpPath}. It holds credential hashes: delete it when done.`,
      );
    } else {
      rmSync(run.dumpPath, { force: true });
    }
    this.writeReport(run.dumpDir, summary);
    if (counted.problems.length > 0) {
      throw new Error(
        `Row counts do not match:\n- ${counted.problems.join("\n- ")}`,
      );
    }
    if (summary.r2.failed.length > 0) {
      const failures = summary.r2.failed.map(
        ({ key, error }) => `${key}: ${error}`,
      );
      throw new Error(
        `${failures.length} R2 object(s) were not copied:\n- ${failures.join("\n- ")}`,
      );
    }
    this.log(
      "\nClone complete. Dev is at the latest migration and holds a copy of production.\nNext: node scripts/fork/dev-env.mjs deploy",
    );
    return summary;
  }

  /** Record the failure in the report and hand the error back to rethrow. */
  failClone(run, error) {
    run.summary.error = error instanceof Error ? error.message : String(error);
    try {
      this.writeReport(run.dumpDir, run.summary);
    } catch {
      // The report is a convenience; never mask the real failure.
    }
    if (existsSync(run.dumpPath)) {
      this.log(
        `\nThe import file ${run.dumpPath} was kept for diagnosis. It holds credential hashes: delete it when done.`,
      );
    }
    return error;
  }

  /** Delete and recreate the dev D1 (after a typed confirmation). */
  resetDevD1(options, dryRun) {
    if (options.confirm !== DEV.d1Name) {
      throw new Error(
        `--reset recreates the dev D1 and deletes its data. Re-run with --confirm ${DEV.d1Name} to proceed.`,
      );
    }
    this.step(`reset: delete and recreate D1 ${DEV.d1Name}`, () => {
      const id = this.findD1(DEV.d1Name);
      if (!id) {
        this.log("    the dev D1 does not exist yet; creating it");
      } else {
        if (normalize(id) === normalize(PROD.d1Id)) {
          throw new ProdGuardError(
            `D1 ${DEV.d1Name} resolves to the production id; refusing to delete it.`,
          );
        }
        if (dryRun) {
          this.log(`    (dry-run) would delete D1 ${DEV.d1Name} (${id})`);
          return;
        }
        this.log(`    deleting D1 ${DEV.d1Name} (${id})`);
        this.wrangler(["d1", "delete", DEV.d1Name, "--skip-confirmation"]);
      }
      if (dryRun) return;
      this.createResource(`D1 ${DEV.d1Name}`, ["d1", "create", DEV.d1Name], {
        created: [],
        existing: [],
      });
      const fresh = this.findD1(DEV.d1Name);
      if (!fresh) {
        throw new Error(`Created D1 ${DEV.d1Name} but could not read its id.`);
      }
      this.adoptD1Id(fresh);
      this.log(`    new D1 id ${fresh}; redeploy so the Worker binds to it`);
    });
  }

  /** A migrations directory holding only the files up to production's level. */
  prepareLevelMigrations(upto) {
    rmSync(this.paths.levelMigrationsDir, { recursive: true, force: true });
    mkdirSync(this.paths.levelMigrationsDir, { recursive: true });
    for (const name of upto) {
      copyFileSync(
        join(this.paths.migrationsDir, name),
        join(this.paths.levelMigrationsDir, name),
      );
    }
    writeFileSync(
      this.paths.levelConfig,
      buildMigrationLevelConfig(
        this.devConfigText,
        resolve(this.paths.levelMigrationsDir),
      ),
    );
  }

  printCounts(rows) {
    const show = rows.filter(
      (row) =>
        (row.prod ?? 0) > 0 ||
        (row.dev ?? 0) > 0 ||
        /MISMATCH/.test(row.status),
    );
    this.log(
      `    ${"table".padEnd(26)} ${"prod".padStart(6)} ${"dev".padStart(6)}  status`,
    );
    for (const row of show) {
      this.log(
        `    ${row.table.padEnd(26)} ${String(row.prod ?? "-").padStart(6)} ${String(row.dev ?? "-").padStart(6)}  ${row.status}`,
      );
    }
    const quiet = rows.length - show.length;
    if (quiet > 0)
      this.log(`    (${quiet} more tables are empty on both sides)`);
  }

  copyAttachmentObjects(prodTarget, dumpDir) {
    const [rows] = this.d1Select(
      prodTarget,
      "SELECT id, r2_key, content_type FROM attachments WHERE deleted_at IS NULL AND state = 'ready' ORDER BY id",
    );
    const result = { total: rows.length, copied: 0, failed: [] };
    if (rows.length === 0) {
      this.log("    production has no ready attachments; nothing to copy");
      return result;
    }
    const devBucket = this.devResources().bucketName;
    const objectDir = join(dumpDir, "r2");
    mkdirSync(objectDir, { recursive: true });
    for (const row of rows) {
      const key = String(row.r2_key);
      const file = join(objectDir, safeFilename(key));
      const verify = `${file}.verify`;
      try {
        this.copyObject(PROD.bucket, devBucket, key, file, verify, row);
        result.copied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ key, error: message.split("\n")[0] });
      } finally {
        rmSync(file, { force: true });
        rmSync(verify, { force: true });
      }
    }
    this.log(`    copied ${result.copied} of ${result.total} objects`);
    return result;
  }

  /** Copy one R2 object production -> dev and verify it by checksum. */
  copyObject(fromBucket, toBucket, key, file, verify, row) {
    this.wrangler([
      "r2",
      "object",
      "get",
      `${fromBucket}/${key}`,
      "--remote",
      "--file",
      file,
    ]);
    if (statSync(file).size > R2_PUT_LIMIT_BYTES) {
      throw new Error("larger than wrangler's 300 MiB upload limit");
    }
    this.wrangler([
      "r2",
      "object",
      "put",
      `${toBucket}/${key}`,
      "--remote",
      "--file",
      file,
      "--content-type",
      String(row.content_type || "application/octet-stream"),
    ]);
    this.wrangler([
      "r2",
      "object",
      "get",
      `${toBucket}/${key}`,
      "--remote",
      "--file",
      verify,
    ]);
    if (sha256(file) !== sha256(verify)) throw new Error("checksum mismatch");
  }

  writeReport(dumpDir, summary) {
    mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
    const lines = [
      "# flaremo-dev clone report",
      "",
      `- Created at: ${this.now().toISOString()}`,
      `- Dry run: ${summary.dryRun}`,
      `- Production level: ${summary.plan?.prodLatest ?? "unknown"}`,
      `- Error: ${summary.error ?? "none"}`,
      "",
      "## Steps",
      "",
      ...this.steps.map((item) => `- ${item}`),
      "",
    ];
    if (summary.counts) {
      lines.push("## Row counts", "");
      for (const row of summary.counts) {
        lines.push(
          `- ${row.table}: prod=${row.prod ?? "-"} dev=${row.dev ?? "-"} (${row.status})`,
        );
      }
      lines.push("");
    }
    writeFileSync(join(dumpDir, "report.md"), lines.join("\n"));
  }
}

function forkSuffix(forkMigrations) {
  return forkMigrations.length > 0
    ? `, fork migrations ${forkMigrations.join(", ")}`
    : "";
}

function generateSecret() {
  return randomBytes(48).toString("base64url");
}

// ---------------------------------------------------------------------------
// CLI

export const USAGE = `Usage: node scripts/fork/dev-env.mjs <command> [options]

Commands
  config      Write the dev wrangler config (.wrangler/fork-dev/wrangler.dev.jsonc).
  provision   Create the dev D1, R2, queues and Vectorize indexes if missing, and
              set the Worker secrets that are missing. Idempotent.
  clone       Copy production data into the dev D1 and rehearse the migrations the
              dev Worker has not run yet. Production is only read.
  deploy      Build the web app, apply pending migrations to dev and deploy the
              dev Worker. --dry-run builds and stops at wrangler's dry run.
  status      Show the dev resources and the dev D1's latest migration.

Options
  --d1-id <uuid>               Dev D1 id (env FLAREMO_DEV_D1_ID; provision saves it).
  --public-url <origin>        Dev origin (env FLAREMO_DEV_PUBLIC_URL).
  --trusted-origin <origin>    Extra trusted origin; repeatable.
  --ratelimit-namespace-id <n> Rate-limit namespace (default ${DEV.ratelimitNamespaceId}).
  --dry-run                    deploy: stop at wrangler's dry run. clone: read-only plan.
  --skip-build                 deploy: reuse apps/web/dist.
  --skip-secrets               provision: do not touch Worker secrets.
  --reset --confirm ${DEV.d1Name}   clone: delete and recreate the dev D1 first.
  --include-side-effect-tables clone: also copy webhook, push and integration tables.
  --keep-dump                  clone: keep the exported data file (credential hashes).
  --with-prod                  status: also read production's latest migration.
  -h, --help                   Show this help.

Auth: wrangler reads CLOUDFLARE_API_TOKEN. The script passes
CLOUDFLARE_API_TOKEN, else CLOUDFLARE_API, else the placeholder "proxy-injected"
(a network proxy supplies the real token), plus CLOUDFLARE_ACCOUNT_ID.
`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "d1-id": { type: "string" },
      "public-url": { type: "string" },
      "trusted-origin": { type: "string", multiple: true },
      "ratelimit-namespace-id": { type: "string" },
      "dry-run": { type: "boolean" },
      "skip-build": { type: "boolean" },
      "skip-secrets": { type: "boolean" },
      reset: { type: "boolean" },
      confirm: { type: "string" },
      "include-side-effect-tables": { type: "boolean" },
      "keep-dump": { type: "boolean" },
      "with-prod": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument "${positionals[1]}".`);
  }
  return {
    command: positionals[0],
    help: Boolean(values.help),
    options: {
      d1Id: values["d1-id"],
      publicUrl: values["public-url"],
      trustedOrigins: values["trusted-origin"] ?? [],
      ratelimitNamespaceId: values["ratelimit-namespace-id"],
      dryRun: values["dry-run"],
      skipBuild: values["skip-build"],
      skipSecrets: values["skip-secrets"],
      reset: values.reset,
      confirm: values.confirm,
      includeSideEffectTables: values["include-side-effect-tables"],
      keepDump: values["keep-dump"],
      withProd: values["with-prod"],
    },
  };
}

const COMMANDS = ["config", "provision", "clone", "deploy", "status"];

export function main(argv = process.argv.slice(2), deps = {}) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(cli.command)) {
    console.error(
      cli.command ? `Unknown command "${cli.command}".` : "Missing command.",
    );
    console.error(USAGE);
    return 2;
  }
  try {
    new DevEnv(deps)[cli.command](cli.options);
    return 0;
  } catch (error) {
    console.error(
      `\n${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = main();
}
