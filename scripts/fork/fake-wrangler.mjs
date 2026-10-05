// Test support for scripts/fork/dev-env.test.mjs: an in-memory stand-in for the
// wrangler CLI and the Cloudflare account behind it. D1 databases are real
// SQLite databases (node:sqlite, with double-quoted string literals enabled the
// way D1 has them), so the repo's real migrations and the import SQL run
// against genuine SQLite semantics. Nothing here touches the network.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parseWranglerArgv, splitSqlStatements } from "./dev-env-guard.mjs";

function leadingNumber(name) {
  return Number.parseInt(String(name).split("_")[0], 10);
}

export function sortedMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => leadingNumber(a) - leadingNumber(b));
}

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr) => ({ status: 1, stdout: "", stderr });

export class FakeWrangler {
  constructor({ DatabaseSync }) {
    this.DatabaseSync = DatabaseSync;
    this.databases = new Map();
    this.buckets = new Map();
    this.queues = new Set();
    this.indexes = new Map();
    this.workers = new Map();
    this.calls = [];
    this.envs = [];
    // { when(argv), stderr, stdout, status = 1, once = true }: make a
    // matching call return this instead of running.
    this.faults = [];
    // Answer a multi-statement --command with only its last result set.
    this.collapseBatches = false;
    // Drop `PRAGMA defer_foreign_keys` from imported files, as if D1's import
    // path did not carry it across: every FK is then checked immediately.
    this.stripDeferredForeignKeys = false;
    this.nextId = 1;
    this.exec = this.exec.bind(this);
  }

  newId() {
    const suffix = String(this.nextId).padStart(12, "0");
    this.nextId += 1;
    return `aaaaaaaa-0000-4000-8000-${suffix}`;
  }

  addDatabase(name, id = this.newId()) {
    const db = new this.DatabaseSync(":memory:", {
      enableDoubleQuotedStringLiterals: true,
    });
    this.databases.set(name, { id, db });
    return db;
  }

  dbByName(name) {
    return this.databases.get(name)?.db;
  }

  /** Apply migration files directly (test setup, not a wrangler call). */
  applyMigrationFiles(db, dir, names) {
    ensureMigrationsTable(db);
    for (const name of names) {
      db.exec("BEGIN");
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.prepare('INSERT INTO "d1_migrations" (name) VALUES (?)').run(name);
      db.exec("COMMIT");
    }
  }

  secretNames(worker) {
    return [...(this.workers.get(worker)?.secrets.keys() ?? [])];
  }

  secretValues(worker) {
    return [...(this.workers.get(worker)?.secrets.entries() ?? [])];
  }

  exec(argv, { input, env } = {}) {
    // The call log never keeps stdin: it may carry a secret value.
    this.calls.push({ argv: [...argv], hadInput: input !== undefined });
    this.envs.push(env);
    const faultAt = this.faults.findIndex((fault) => fault.when(argv));
    if (faultAt !== -1) {
      const fault = this.faults[faultAt];
      if (fault.once !== false) this.faults.splice(faultAt, 1);
      return {
        status: fault.status ?? 1,
        stdout: fault.stdout ?? "",
        stderr: fault.stderr ?? "",
      };
    }
    const parsed = parseWranglerArgv(argv);
    const configPath = parsed.flags.get("--config")?.at(-1);
    const config = configPath
      ? parseJsonc(readFileSync(configPath, "utf8"), [], {
          allowTrailingComma: true,
        })
      : null;
    const handler = this[`cmd ${parsed.command}`];
    if (!handler) return fail(`fake wrangler: unsupported ${parsed.command}`);
    return handler.call(this, { parsed, config, input });
  }

  // -- D1 ---------------------------------------------------------------------

  resolveDatabase(value, config) {
    const entry = (config?.d1_databases ?? []).find(
      (candidate) =>
        candidate.binding === value || candidate.database_name === value,
    );
    if (entry) {
      for (const database of this.databases.values()) {
        if (database.id === entry.database_id) return { ...database, entry };
      }
      return null;
    }
    for (const [name, database] of this.databases) {
      if (name === value || database.id === value) return { ...database };
    }
    return null;
  }

  "cmd d1 list"() {
    return ok(
      JSON.stringify(
        [...this.databases].map(([name, { id }]) => ({ uuid: id, name })),
      ),
    );
  }

  "cmd d1 create"({ parsed }) {
    const [name] = parsed.positionals;
    if (this.databases.has(name)) {
      return fail("A database with that name already exists. [code: 7502]");
    }
    this.addDatabase(name);
    return ok(`Successfully created DB '${name}'`);
  }

  "cmd d1 delete"({ parsed, config }) {
    const found = this.resolveDatabase(parsed.positionals[0], config);
    if (!found) return fail("Couldn't find a D1 DB with that name.");
    for (const [name, database] of this.databases) {
      if (database.id === found.id) this.databases.delete(name);
    }
    return ok("Deleted");
  }

  "cmd d1 execute"({ parsed, config }) {
    const found = this.resolveDatabase(parsed.positionals[0], config);
    if (!found) return fail("Couldn't find a D1 DB with that name or binding.");
    const { db } = found;
    const file = parsed.flags.get("--file")?.at(-1);
    if (file) {
      try {
        let sql = readFileSync(file, "utf8");
        if (this.stripDeferredForeignKeys) {
          sql = sql.replace(/^PRAGMA defer_foreign_keys=TRUE;\n/m, "");
        }
        db.exec("BEGIN");
        db.exec(sql);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        return fail(`${error.message} [code: 7500]`);
      }
      return ok("Executed queries");
    }
    const sql = parsed.flags.get("--command").join(";");
    const results = [];
    try {
      for (const statement of splitSqlStatements(sql)) {
        const reads = /^\s*(select|pragma|with)\b/i.test(statement);
        if (reads) {
          results.push({
            results: db
              .prepare(statement)
              .all()
              .map((row) => ({ ...row })),
            success: true,
            meta: {},
          });
        } else {
          db.exec(statement);
          results.push({ results: [], success: true, meta: {} });
        }
      }
    } catch (error) {
      return fail(`${error.message} [code: 7500]`);
    }
    return ok(
      JSON.stringify(
        this.collapseBatches && results.length > 1
          ? results.slice(-1)
          : results,
      ),
    );
  }

  "cmd d1 migrations apply"({ parsed, config }) {
    const found = this.resolveDatabase(parsed.positionals[0], config);
    if (!found) return fail("Couldn't find a D1 DB with that name or binding.");
    const { db, entry } = found;
    ensureMigrationsTable(db);
    const applied = db
      .prepare('SELECT name FROM "d1_migrations" ORDER BY id')
      .all()
      .map((row) => row.name);
    const pending = sortedMigrationFiles(entry.migrations_dir).filter(
      (name) => !applied.includes(name),
    );
    const lines = [`Migrations to be applied: ${pending.join(", ") || "none"}`];
    for (const name of pending) {
      try {
        db.exec("BEGIN");
        db.exec(readFileSync(join(entry.migrations_dir, name), "utf8"));
        db.prepare('INSERT INTO "d1_migrations" (name) VALUES (?)').run(name);
        db.exec("COMMIT");
        lines.push(`${name} applied`);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        return fail(`${name}: ${error.message} [code: 7500]`);
      }
    }
    return ok(lines.join("\n"));
  }

  // -- R2 -----------------------------------------------------------------------

  "cmd r2 bucket list"() {
    return ok(
      [...this.buckets.keys()]
        .map((name) => `name:           ${name}\ncreation_date:  2026-10-04`)
        .join("\n\n"),
    );
  }

  "cmd r2 bucket create"({ parsed }) {
    const [name] = parsed.positionals;
    if (this.buckets.has(name)) {
      return fail(
        "The bucket you tried to create already exists. [code: 10004]",
      );
    }
    this.buckets.set(name, new Map());
    return ok(`Created bucket ${name}`);
  }

  splitObjectPath(path) {
    const at = path.indexOf("/");
    return [path.slice(0, at), path.slice(at + 1)];
  }

  "cmd r2 object get"({ parsed }) {
    const [bucket, key] = this.splitObjectPath(parsed.positionals[0]);
    const object = this.buckets.get(bucket)?.get(key);
    if (!object) return fail("The specified key does not exist. [code: 10007]");
    writeFileSync(parsed.flags.get("--file").at(-1), object.bytes);
    return ok("Download complete.");
  }

  "cmd r2 object put"({ parsed }) {
    const [bucket, key] = this.splitObjectPath(parsed.positionals[0]);
    if (!this.buckets.has(bucket)) return fail("No such bucket. [code: 10006]");
    this.buckets.get(bucket).set(key, {
      bytes: readFileSync(parsed.flags.get("--file").at(-1)),
      contentType: parsed.flags.get("--content-type")?.at(-1),
    });
    return ok("Upload complete.");
  }

  // -- Queues and Vectorize -------------------------------------------------------

  "cmd queues list"() {
    return ok(
      [...this.queues]
        .map((name) => `│ q-${name.length} │ ${name} │`)
        .join("\n"),
    );
  }

  "cmd queues create"({ parsed }) {
    const [name] = parsed.positionals;
    if (this.queues.has(name)) {
      return fail("Queue already exists. [code: 11009]");
    }
    this.queues.add(name);
    return ok(`Created queue ${name}`);
  }

  "cmd vectorize list"() {
    return ok(
      JSON.stringify(
        [...this.indexes].map(([name, config]) => ({ name, config })),
      ),
    );
  }

  "cmd vectorize create"({ parsed }) {
    const [name] = parsed.positionals;
    this.indexes.set(name, {
      dimensions: Number(parsed.flags.get("--dimensions")?.at(-1)),
      metric: parsed.flags.get("--metric")?.at(-1),
    });
    return ok(`Created index ${name}`);
  }

  // -- Workers ------------------------------------------------------------------------

  "cmd secret list"({ parsed }) {
    const worker = parsed.flags.get("--name")?.at(-1);
    if (!this.workers.has(worker)) {
      return fail(
        `Worker "${worker}" not found.\n\nIf this is a new Worker, run \`wrangler deploy\` first to create it.`,
      );
    }
    return ok(
      JSON.stringify(
        this.secretNames(worker).map((name) => ({ name, type: "secret_text" })),
      ),
    );
  }

  "cmd secret put"({ parsed, input }) {
    const worker = parsed.flags.get("--name")?.at(-1);
    if (!this.workers.has(worker)) {
      this.workers.set(worker, { secrets: new Map(), deployed: false });
    }
    this.workers
      .get(worker)
      .secrets.set(
        parsed.positionals[0],
        String(input ?? "").replace(/\n$/, ""),
      );
    return ok("Success! Uploaded secret");
  }

  "cmd deploy"({ parsed, config }) {
    if (parsed.flags.has("--dry-run")) return ok("--dry-run: exiting now.");
    if (!this.workers.has(config.name)) {
      this.workers.set(config.name, { secrets: new Map(), deployed: false });
    }
    this.workers.get(config.name).deployed = true;
    return ok(`Deployed ${config.name}`);
  }
}

function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
}
