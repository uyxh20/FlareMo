import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { RESTORE_TABLES } from "../persistence-manifest.mjs";
import { inspectWorkerSecret } from "../sync-worker-secrets.mjs";
import {
  assertConfigDevOnly,
  assertSafeWranglerCall,
  buildCountsQuery,
  buildDevConfig,
  buildImportSql,
  buildMigrationLevelConfig,
  compareMigrationNames,
  DEV,
  DevEnv,
  devResourceName,
  discoverExtraTables,
  EPHEMERAL_TABLES,
  isProdIdentifier,
  isReadOnlySql,
  isTransientWranglerError,
  listLocalMigrations,
  main,
  orderByForeignKeys,
  PROD,
  ProdGuardError,
  parseCli,
  parseConfigText,
  parseWranglerArgv,
  planClearTables,
  planExportBatches,
  planMigrationLevels,
  planTableCopy,
  quoteIdent,
  REQUIRED_WORKER_SECRETS,
  SIDE_EFFECT_TABLES,
  splitMigrationTracks,
  splitSqlStatements,
  sqlLiteral,
  summarizeCounts,
  WranglerError,
  wranglerChildEnv,
} from "./dev-env.mjs";
import { FakeWrangler, sortedMigrationFiles } from "./fake-wrangler.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const exampleText = readFileSync(
  join(REPO_ROOT, "wrangler.jsonc.example"),
  "utf8",
);
const DEV_D1_ID = "11111111-1111-4111-8111-111111111111";

function devConfigText(overrides = {}) {
  return buildDevConfig({
    exampleText,
    repoRoot: REPO_ROOT,
    databaseId: DEV_D1_ID,
    ...overrides,
  });
}

const DEV_CONFIG = parseConfigText(devConfigText());
// What wrangler resolves without --config: the tracked deploy-button config.
const ROOT_WRANGLER_JSON = parseConfigText(
  readFileSync(join(REPO_ROOT, "wrangler.json"), "utf8"),
);
// The example with production's identifiers: what a live wrangler.jsonc is.
const PROD_CONFIG = parseConfigText(
  exampleText.replace("REPLACE_WITH_YOUR_D1_DATABASE_ID", PROD.d1Id),
);

// ---------------------------------------------------------------------------
// SQL classification

describe("isReadOnlySql", () => {
  const reads = [
    "SELECT 1",
    "select name from d1_migrations order by id desc limit 1;",
    "SELECT 'DELETE FROM x; DROP TABLE y'",
    'SELECT "update" FROM t',
    "SELECT replace(a, 'x', 'y') FROM t",
    " \n -- a comment\n SELECT 1 /* inline */ ;",
    "WITH recent AS (SELECT id FROM memos) SELECT * FROM recent",
    'PRAGMA table_info("memos")',
    "PRAGMA index_list(memos); PRAGMA foreign_key_list(memos)",
    "SELECT 1; SELECT 2",
    'SELECT (SELECT COUNT(*) FROM "users") AS "users";',
  ];
  for (const sql of reads) {
    test(`allows ${JSON.stringify(sql)}`, () => {
      assert.equal(isReadOnlySql(sql), true);
    });
  }

  const writes = [
    "",
    "   ",
    "DELETE FROM memos",
    "delete from memos",
    "UPDATE memos SET pinned = 1",
    "INSERT INTO a VALUES (1)",
    "INSERT OR REPLACE INTO a VALUES (1)",
    "REPLACE INTO a VALUES (1)",
    "DROP TABLE a",
    "CREATE TABLE a (b)",
    "ALTER TABLE a ADD b",
    "VACUUM",
    "ATTACH DATABASE 'x' AS y",
    "PRAGMA foreign_keys = OFF",
    "PRAGMA writable_schema=1",
    "PRAGMA user_version = 3",
    "BEGIN",
    "SELECT 1; DELETE FROM memos",
    "SELECT 1;DROP TABLE a",
    "SELECT 1 -- hi\n; DELETE FROM a",
    "/* SELECT */ DELETE FROM a",
    "WITH x AS (SELECT 1) DELETE FROM a",
    "WITH x AS (SELECT 1) INSERT INTO a SELECT * FROM x",
    "WITH x AS (SELECT 1) UPDATE a SET b = 1",
    "WITH x AS (SELECT 1) REPLACE INTO a SELECT * FROM x",
    "EXPLAIN DELETE FROM a",
    "(SELECT 1)",
    "VALUES (1)",
  ];
  for (const sql of writes) {
    test(`refuses ${JSON.stringify(sql)}`, () => {
      assert.equal(isReadOnlySql(sql), false);
    });
  }

  test("splits statements outside quotes and drops comments", () => {
    assert.deepEqual(
      splitSqlStatements("SELECT 'a;b'; -- tail\n SELECT \"c;d\" /* x */; "),
      ["SELECT 'a;b'", 'SELECT "c;d"'],
    );
  });
});

// ---------------------------------------------------------------------------
// The production guard

describe("assertSafeWranglerCall", () => {
  const cfg = "/tmp/fork-dev/wrangler.dev.jsonc";
  const allowed = (argv, config = DEV_CONFIG) =>
    assertSafeWranglerCall([...argv, "--config", cfg], config);
  const refused = (argv, pattern = /./, config = DEV_CONFIG) =>
    assert.throws(
      () => assertSafeWranglerCall([...argv, "--config", cfg], config),
      (error) => error instanceof ProdGuardError && pattern.test(error.message),
    );

  describe("allows dev writes", () => {
    const cases = {
      "d1 create": ["d1", "create", "flaremo-dev"],
      "d1 delete": ["d1", "delete", "flaremo-dev", "--skip-confirmation"],
      "d1 execute --file by binding": [
        "d1",
        "execute",
        "DB",
        "--remote",
        "--file",
        "/tmp/x.sql",
        "--yes",
      ],
      "d1 execute DELETE on the dev name": [
        "d1",
        "execute",
        "flaremo-dev",
        "--remote",
        "--command",
        "DELETE FROM memos",
      ],
      "d1 migrations apply": ["d1", "migrations", "apply", "DB", "--remote"],
      "r2 bucket create": ["r2", "bucket", "create", "flaremo-dev-attachments"],
      "r2 object put": [
        "r2",
        "object",
        "put",
        "flaremo-dev-attachments/a/b.png",
        "--remote",
        "--file",
        "/tmp/b.png",
        "--content-type",
        "image/png",
      ],
      "queues create": ["queues", "create", "flaremo-dev-member-removal"],
      "vectorize create": [
        "vectorize",
        "create",
        "flaremo-dev-memos",
        "--dimensions",
        "1024",
        "--metric",
        "cosine",
      ],
      "secret put": [
        "secret",
        "put",
        "BETTER_AUTH_SECRET",
        "--name",
        "flaremo-dev",
      ],
      deploy: ["deploy"],
      "deploy --dry-run": ["deploy", "--dry-run"],
    };
    for (const [label, argv] of Object.entries(cases)) {
      test(label, () => assert.ok(allowed(argv)));
    }
  });

  describe("allows reads, including against production", () => {
    const cases = {
      "d1 list": ["d1", "list", "--json"],
      "SELECT on the production D1 by name": [
        "d1",
        "execute",
        PROD.d1Name,
        "--remote",
        "--command",
        "SELECT name FROM d1_migrations ORDER BY id",
        "--json",
      ],
      "SELECT on the production D1 by id": [
        "d1",
        "execute",
        PROD.d1Id,
        "--remote",
        "--command",
        "SELECT 1",
      ],
      "PRAGMA table_info batch on production": [
        "d1",
        "execute",
        PROD.d1Name,
        "--remote",
        "--command",
        'PRAGMA table_info("memos"); PRAGMA table_info("users");',
        "--json",
      ],
      "d1 export of production": [
        "d1",
        "export",
        PROD.d1Name,
        "--remote",
        "--output",
        "/tmp/x.sql",
        "--no-schema",
        "--table",
        "memos",
      ],
      "r2 object get from the production bucket": [
        "r2",
        "object",
        "get",
        `${PROD.bucket}/some/key.png`,
        "--remote",
        "--file",
        "/tmp/key.png",
      ],
      "r2 bucket list": ["r2", "bucket", "list"],
      "queues list": ["queues", "list"],
      "vectorize list": ["vectorize", "list", "--json"],
      "secret list of the production Worker": [
        "secret",
        "list",
        "--name",
        PROD.workerName,
      ],
      "deploy --dry-run of a production config": ["deploy", "--dry-run"],
    };
    for (const [label, argv] of Object.entries(cases)) {
      test(label, () => {
        const verdict = allowed(argv, PROD_CONFIG);
        assert.equal(verdict.writeCapable, false);
      });
    }
  });

  describe("refuses writes that target production", () => {
    const cases = {
      "deploy with a production config": [
        ["deploy"],
        /Worker name "flaremo"/,
        PROD_CONFIG,
      ],
      "deploy --name flaremo": [
        ["deploy", "--name", "flaremo"],
        /Worker --name "flaremo" is a production resource/,
      ],
      "deploy with the production D1 id in an otherwise dev config": [
        ["deploy"],
        /production id/,
        {
          ...DEV_CONFIG,
          d1_databases: [
            { ...DEV_CONFIG.d1_databases[0], database_id: PROD.d1Id },
          ],
        },
      ],
      "d1 migrations apply with a production config": [
        ["d1", "migrations", "apply", "DB", "--remote"],
        /production/,
        PROD_CONFIG,
      ],
      "d1 execute DELETE on production by name": [
        [
          "d1",
          "execute",
          PROD.d1Name,
          "--remote",
          "--command",
          "DELETE FROM memos",
        ],
        /D1 database "flaremo" is a production resource/,
      ],
      "d1 execute DELETE on production by id": [
        [
          "d1",
          "execute",
          PROD.d1Id,
          "--remote",
          "--command",
          "DELETE FROM memos",
        ],
        /production resource/,
      ],
      "d1 execute SELECT chained with a DELETE": [
        [
          "d1",
          "execute",
          PROD.d1Name,
          "--remote",
          "--command",
          "SELECT 1; DELETE FROM memos",
        ],
        /production resource/,
      ],
      "d1 execute --file on production": [
        [
          "d1",
          "execute",
          PROD.d1Name,
          "--remote",
          "--file",
          "/tmp/x.sql",
          "--yes",
        ],
        /production resource/,
      ],
      "d1 execute on the DB binding of a production config": [
        ["d1", "execute", "DB", "--remote", "--file", "/tmp/x.sql"],
        /production/,
        PROD_CONFIG,
      ],
      "d1 delete production": [
        ["d1", "delete", PROD.d1Name, "--skip-confirmation"],
        /production resource/,
      ],
      "d1 create with the production name": [
        ["d1", "create", PROD.d1Name],
        /production resource/,
      ],
      "d1 migrations apply by the production name": [
        ["d1", "migrations", "apply", PROD.d1Name, "--remote"],
        /production resource/,
      ],
      "d1 migrations list (it can create the migrations table)": [
        ["d1", "migrations", "list", PROD.d1Name, "--remote"],
        /production resource/,
      ],
      "secret put on the production Worker": [
        ["secret", "put", "BETTER_AUTH_SECRET", "--name", PROD.workerName],
        /production resource/,
      ],
      "secret put with a production config": [
        ["secret", "put", "BETTER_AUTH_SECRET"],
        /Worker name "flaremo"/,
        PROD_CONFIG,
      ],
      "secret delete on the production Worker": [
        ["secret", "delete", "BETTER_AUTH_SECRET", "--name", PROD.workerName],
        /production resource/,
      ],
      "r2 object put into the production bucket": [
        [
          "r2",
          "object",
          "put",
          `${PROD.bucket}/k`,
          "--remote",
          "--file",
          "/tmp/k",
        ],
        /R2 bucket "flaremo-attachments" is a production resource/,
      ],
      "r2 object delete from the production bucket": [
        ["r2", "object", "delete", `${PROD.bucket}/k`, "--remote"],
        /production resource/,
      ],
      "r2 bucket delete production": [
        ["r2", "bucket", "delete", PROD.bucket],
        /production resource/,
      ],
      "r2 bucket create with the production name": [
        ["r2", "bucket", "create", PROD.bucket],
        /production resource/,
      ],
      "queues create production": [
        ["queues", "create", PROD.queues[0]],
        /production resource/,
      ],
      "queues delete production": [
        ["queues", "delete", PROD.queues[1]],
        /production resource/,
      ],
      "vectorize create production": [
        [
          "vectorize",
          "create",
          PROD.vectorizeIndexes[0],
          "--dimensions",
          "1024",
          "--metric",
          "cosine",
        ],
        /production resource/,
      ],
      "vectorize delete production": [
        ["vectorize", "delete", PROD.vectorizeIndexes[1]],
        /production resource/,
      ],
      "production names are matched case-insensitively": [
        ["queues", "create", " FlareMo-Member-Removal "],
        /production resource/,
      ],
    };
    for (const [label, [argv, pattern, config]] of Object.entries(cases)) {
      test(label, () => refused(argv, pattern, config));
    }
  });

  describe("refuses anything it cannot verify as dev", () => {
    test("a write-capable call without --config", () => {
      assert.throws(
        () => assertSafeWranglerCall(["deploy"], DEV_CONFIG),
        /must pass --config/,
      );
      assert.throws(
        () =>
          assertSafeWranglerCall(
            ["secret", "put", "X", "--name", "flaremo-dev"],
            DEV_CONFIG,
          ),
        /must pass --config/,
      );
    });

    test("a second --config, which the guard could not vet", () => {
      assert.throws(
        () =>
          assertSafeWranglerCall(
            ["deploy", "--config", cfg, "--config", "/tmp/prod.jsonc"],
            DEV_CONFIG,
          ),
        /exactly once/,
      );
      assert.throws(
        () =>
          assertSafeWranglerCall(
            ["deploy", "--config", cfg, `--config=${cfg}`],
            DEV_CONFIG,
          ),
        /exactly once/,
      );
    });

    test("the tracked root wrangler.json, which names the production Worker", () => {
      refused(["deploy"], /Worker name "flaremo"/, ROOT_WRANGLER_JSON);
      refused(
        ["d1", "migrations", "apply", "DB", "--remote"],
        /production/,
        ROOT_WRANGLER_JSON,
      );
    });

    test("a write-capable call with no parsed config", () => {
      assert.throws(() => allowed(["deploy"], null), /parsed --config/);
    });

    test("a resource that is merely not a dev resource", () => {
      refused(
        ["r2", "bucket", "create", "someone-elses-bucket"],
        /not a flaremo-dev\* resource/,
      );
      refused(
        ["queues", "create", "flaremo-devious"],
        /not a flaremo-dev\* resource/,
      );
      refused(
        ["d1", "delete", "other-database"],
        /not a flaremo-dev\* resource/,
      );
      refused(
        ["r2", "object", "put", "/flaremo-dev-attachments/k", "--file", "/x"],
        /R2 bucket is missing/,
      );
    });

    test("a --name that differs from the config's Worker", () => {
      refused(
        ["secret", "put", "X", "--name", "flaremo-dev-other"],
        /differs from the config's Worker/,
      );
    });

    test("unknown commands and flags", () => {
      refused(["delete", "--name", "flaremo"], /unsupported wrangler command/);
      refused(["delete", "flaremo-dev"], /unsupported wrangler command/);
      refused(["rollback"], /unsupported wrangler command/);
      refused(["versions", "deploy"], /unsupported wrangler command/);
      refused(["kv", "namespace", "delete"], /unsupported wrangler command/);
      refused(
        ["d1", "time-travel", "restore", "flaremo-dev"],
        /unsupported wrangler command/,
      );
      refused(
        ["deploy", "--env", "production"],
        /unsupported wrangler flag --env/,
      );
      refused(
        ["deploy", "--routes", "x.example.com"],
        /unsupported wrangler flag/,
      );
      refused(
        ["d1", "create", "flaremo-dev", "--update-config"],
        /unsupported wrangler flag/,
      );
      refused(
        ["d1", "execute", "DB", "--preview", "--command", "SELECT 1"],
        /unsupported wrangler flag/,
      );
      assert.throws(
        () =>
          assertSafeWranglerCall(
            ["delete", "--name", PROD.workerName, "--config", cfg],
            DEV_CONFIG,
          ),
        /names the production resource "flaremo"/,
      );
    });

    test("extra positional arguments (so no secret value can ride in argv)", () => {
      refused(
        ["secret", "put", "X", "super-secret-value", "--name", "flaremo-dev"],
        /unexpected extra argument/,
      );
      refused(
        ["d1", "create", "flaremo-dev", "extra"],
        /unexpected extra argument/,
      );
    });

    test("a bare -- and a flag with no value", () => {
      assert.throws(() => parseWranglerArgv(["deploy", "--"]), /bare --/);
      assert.throws(
        () => parseWranglerArgv(["d1", "execute", "DB", "--command"]),
        /needs a value/,
      );
    });

    test("a missing target", () => {
      refused(["d1", "create"], /missing its d1 target/);
    });
  });

  describe("assertConfigDevOnly", () => {
    test("accepts the generated dev config", () => {
      assertConfigDevOnly(DEV_CONFIG);
    });

    const bad = {
      "the example's production names": PROD_CONFIG,
      "a top-level key nobody reviewed": {
        ...DEV_CONFIG,
        kv_namespaces: [{ binding: "K", id: "abc" }],
      },
      "a route that could hijack a production hostname": {
        ...DEV_CONFIG,
        routes: ["notes.example.com/*"],
      },
      "an env block": { ...DEV_CONFIG, env: { production: {} } },
      "the production origin as the public URL": {
        ...DEV_CONFIG,
        vars: { ...DEV_CONFIG.vars, FLAREMO_PUBLIC_URL: `${PROD.publicUrl}/` },
      },
      "the production origin among trusted origins": {
        ...DEV_CONFIG,
        vars: {
          ...DEV_CONFIG.vars,
          FLAREMO_TRUSTED_ORIGINS: `${DEV.publicUrl}, ${PROD.publicUrl}`,
        },
      },
      "a real email provider": {
        ...DEV_CONFIG,
        vars: { ...DEV_CONFIG.vars, FLAREMO_EMAIL_PROVIDER: "resend" },
      },
      "a VAPID key": {
        ...DEV_CONFIG,
        vars: { ...DEV_CONFIG.vars, FLAREMO_VAPID_PRIVATE_KEY: "k" },
      },
      "the production rate-limit namespace": {
        ...DEV_CONFIG,
        ratelimits: [{ ...DEV_CONFIG.ratelimits[0], namespace_id: "1001" }],
      },
      "a production queue consumer": {
        ...DEV_CONFIG,
        queues: {
          ...DEV_CONFIG.queues,
          consumers: [{ queue: "flaremo-data-export" }],
        },
      },
      "a production Vectorize index": {
        ...DEV_CONFIG,
        vectorize: [{ binding: "V", index_name: "flaremo-memos" }],
      },
      "the production D1 id hidden in a var": {
        ...DEV_CONFIG,
        vars: { ...DEV_CONFIG.vars, FLAREMO_CF_D1_ID: PROD.d1Id.toUpperCase() },
      },
      "the production host hidden in a var": {
        ...DEV_CONFIG,
        vars: {
          ...DEV_CONFIG.vars,
          NOTE: "see flaremo.ulysse-ha-19.workers.dev",
        },
      },
      "a production resource name hidden in a var": {
        ...DEV_CONFIG,
        vars: { ...DEV_CONFIG.vars, BUCKET: "flaremo-attachments" },
      },
      "a missing Worker name": { ...DEV_CONFIG, name: undefined },
    };
    for (const [label, config] of Object.entries(bad)) {
      test(`rejects ${label}`, () => {
        assert.throws(() => assertConfigDevOnly(config), ProdGuardError);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Dev config

describe("buildDevConfig", () => {
  test("names every resource flaremo-dev* and points at the dev origin", () => {
    assert.equal(DEV_CONFIG.name, "flaremo-dev");
    assert.deepEqual(
      DEV_CONFIG.d1_databases.map((db) => [
        db.binding,
        db.database_name,
        db.database_id,
      ]),
      [["DB", "flaremo-dev", DEV_D1_ID]],
    );
    assert.deepEqual(
      DEV_CONFIG.r2_buckets.map((bucket) => bucket.bucket_name),
      ["flaremo-dev-attachments"],
    );
    assert.deepEqual(
      DEV_CONFIG.queues.producers.map((entry) => [entry.binding, entry.queue]),
      [
        ["MEMBER_REMOVAL_QUEUE", "flaremo-dev-member-removal"],
        ["DATA_EXPORT_QUEUE", "flaremo-dev-data-export"],
      ],
    );
    assert.deepEqual(
      DEV_CONFIG.queues.consumers.map((entry) => entry.queue),
      ["flaremo-dev-member-removal", "flaremo-dev-data-export"],
    );
    assert.deepEqual(
      DEV_CONFIG.vectorize.map((index) => [index.binding, index.index_name]),
      [
        ["VECTORIZE_MEMOS", "flaremo-dev-memos"],
        ["VECTORIZE_MEMORIES", "flaremo-dev-memories"],
      ],
    );
    assert.equal(DEV_CONFIG.ratelimits[0].namespace_id, "2001");
    assert.notEqual(
      DEV_CONFIG.ratelimits[0].namespace_id,
      PROD.ratelimitNamespaceId,
    );
    assert.equal(DEV_CONFIG.vars.FLAREMO_PUBLIC_URL, DEV.publicUrl);
    assert.equal(DEV_CONFIG.vars.FLAREMO_TRUSTED_ORIGINS, DEV.publicUrl);
    assert.deepEqual(DEV_CONFIG.triggers, { crons: ["17 3 * * *"] });
  });

  test("keeps the binding keys and everything else from the example", () => {
    const example = parseConfigText(exampleText);
    assert.deepEqual(
      DEV_CONFIG.assets.run_worker_first,
      example.assets.run_worker_first,
    );
    assert.deepEqual(DEV_CONFIG.ai, example.ai);
    assert.equal(DEV_CONFIG.compatibility_date, example.compatibility_date);
    assert.deepEqual(
      DEV_CONFIG.compatibility_flags,
      example.compatibility_flags,
    );
    assert.equal(
      DEV_CONFIG.vars.FLAREMO_EMBEDDING_DIMENSIONS,
      example.vars.FLAREMO_EMBEDDING_DIMENSIONS,
    );
  });

  test("uses absolute paths, because the config lives outside the repo root", () => {
    assert.ok(isAbsolute(DEV_CONFIG.main));
    assert.ok(DEV_CONFIG.main.endsWith("apps/worker/src/index.ts"));
    assert.ok(existsSync(DEV_CONFIG.main));
    assert.ok(isAbsolute(DEV_CONFIG.assets.directory));
    assert.ok(isAbsolute(DEV_CONFIG.d1_databases[0].migrations_dir));
    assert.ok(existsSync(DEV_CONFIG.d1_databases[0].migrations_dir));
  });

  test("never lets a production identifier through", () => {
    const text = devConfigText();
    for (const identifier of [
      PROD.d1Id,
      PROD.bucket,
      ...PROD.queues,
      ...PROD.vectorizeIndexes,
      "flaremo.ulysse-ha-19.workers.dev",
    ]) {
      assert.ok(
        !text.includes(identifier),
        `${identifier} leaked into the dev config`,
      );
    }
    assert.ok(!/"name":\s*"flaremo"/.test(text));
    assert.ok(!/"database_name":\s*"flaremo"/.test(text));
    assert.ok(!text.includes("REPLACE_WITH_YOUR"));
  });

  test("keeps the example's comments and marks the file as generated", () => {
    const text = devConfigText();
    assert.match(text, /^\/\/ GENERATED by scripts\/fork\/dev-env\.mjs/);
    assert.match(text, /Throttling for credential endpoints/);
  });

  test("keeps outbound email and push empty even if the example enabled them", () => {
    const tampered = exampleText
      .replace(
        '"FLAREMO_EMAIL_PROVIDER": ""',
        '"FLAREMO_EMAIL_PROVIDER": "resend"',
      )
      .replace(
        '"FLAREMO_EMAIL_FROM": ""',
        '"FLAREMO_EMAIL_FROM": "FlareMo <me@example.com>"',
      )
      .replace(
        '"FLAREMO_VAPID_PUBLIC_KEY": ""',
        '"FLAREMO_VAPID_PUBLIC_KEY": "pub"',
      )
      .replace(
        '"FLAREMO_VAPID_PRIVATE_KEY": ""',
        '"FLAREMO_VAPID_PRIVATE_KEY": "priv"',
      )
      .replace(
        '"FLAREMO_DEPLOY_REPOSITORY": ""',
        '"FLAREMO_DEPLOY_REPOSITORY": "me/flaremo"',
      );
    assert.notEqual(tampered, exampleText);
    const config = parseConfigText(devConfigText({ exampleText: tampered }));
    for (const key of [
      "FLAREMO_EMAIL_PROVIDER",
      "FLAREMO_EMAIL_FROM",
      "FLAREMO_VAPID_PUBLIC_KEY",
      "FLAREMO_VAPID_PRIVATE_KEY",
      "FLAREMO_DEPLOY_REPOSITORY",
    ]) {
      assert.equal(config.vars[key], "", key);
    }
  });

  test("accepts extra trusted origins and a different dev URL", () => {
    const config = parseConfigText(
      devConfigText({
        publicUrl: "https://dev.example.com/",
        trustedOrigins: ["https://other.example.com", ""],
      }),
    );
    assert.equal(config.vars.FLAREMO_PUBLIC_URL, "https://dev.example.com");
    assert.equal(
      config.vars.FLAREMO_TRUSTED_ORIGINS,
      "https://dev.example.com,https://other.example.com",
    );
  });

  test("refuses unsafe inputs", () => {
    assert.throws(
      () => devConfigText({ databaseId: PROD.d1Id }),
      /Refusing to use the production D1 id/,
    );
    assert.throws(
      () => devConfigText({ databaseId: PROD.d1Id.toUpperCase() }),
      /Refusing to use the production D1 id/,
    );
    assert.throws(() => devConfigText({ databaseId: "not-a-uuid" }), /UUID/);
    assert.throws(() => devConfigText({ databaseId: "" }), /UUID/);
    assert.throws(
      () => devConfigText({ publicUrl: PROD.publicUrl }),
      /differ from the live URL/,
    );
    assert.throws(
      () => devConfigText({ publicUrl: "http://x.example.com" }),
      /https/,
    );
    assert.throws(
      () => devConfigText({ ratelimitNamespaceId: "1001" }),
      /differ from the example/,
    );
    assert.throws(
      () => devConfigText({ ratelimitNamespaceId: "abc" }),
      /positive integer/,
    );
  });

  test("fails closed on an example it does not fully understand", () => {
    const withKv = exampleText.replace(
      '"ai": {',
      '"kv_namespaces": [{ "binding": "KV", "id": "prod-kv" }],\n  "ai": {',
    );
    assert.notEqual(withKv, exampleText);
    assert.throws(
      () => devConfigText({ exampleText: withKv }),
      /not reviewed \(kv_namespaces\)/,
    );
    const withRoute = exampleText.replace(
      '"triggers": {',
      '"routes": ["notes.example.com/*"],\n  "triggers": {',
    );
    assert.throws(
      () => devConfigText({ exampleText: withRoute }),
      /not reviewed \(routes\)/,
    );
    const twoDatabases = exampleText.replace(
      '"d1_databases": [',
      '"d1_databases": [{ "binding": "OTHER", "database_name": "flaremo-other", "database_id": "x" },',
    );
    assert.throws(
      () => devConfigText({ exampleText: twoDatabases }),
      /exactly one D1/,
    );
    assert.throws(
      () =>
        devConfigText({
          exampleText: exampleText.replace(
            '"name": "flaremo",',
            '"name": "something-else",',
          ),
        }),
      /Cannot derive a dev name/,
    );
  });

  test("buildMigrationLevelConfig only swaps the migrations directory", () => {
    const text = buildMigrationLevelConfig(devConfigText(), "/tmp/level");
    const config = parseConfigText(text);
    assert.equal(config.d1_databases[0].migrations_dir, "/tmp/level");
    assert.deepEqual(
      { ...config, d1_databases: null },
      { ...DEV_CONFIG, d1_databases: null },
    );
    assert.equal(config.d1_databases[0].database_id, DEV_D1_ID);
  });

  test("devResourceName derives the dev name", () => {
    assert.equal(devResourceName("flaremo"), "flaremo-dev");
    assert.equal(
      devResourceName("flaremo-attachments"),
      "flaremo-dev-attachments",
    );
    assert.throws(
      () => devResourceName("flaremo-dev-attachments"),
      /Cannot derive/,
    );
    assert.throws(() => devResourceName("other"), /Cannot derive/);
  });
});

// ---------------------------------------------------------------------------
// Pure planners and builders

describe("wranglerChildEnv", () => {
  test("defaults to the proxy placeholder token", () => {
    const env = wranglerChildEnv({ PATH: "/bin" });
    assert.equal(env.CLOUDFLARE_API_TOKEN, "proxy-injected");
    assert.equal(env.WRANGLER_SEND_METRICS, "false");
    assert.equal(env.CI, "true");
    assert.equal(env.PATH, "/bin");
    assert.equal("CLOUDFLARE_ACCOUNT_ID" in env, false);
  });

  test("CLOUDFLARE_API_TOKEN wins, then the owner's CLOUDFLARE_API", () => {
    assert.equal(
      wranglerChildEnv({
        CLOUDFLARE_API_TOKEN: "real",
        CLOUDFLARE_API: "alias",
      }).CLOUDFLARE_API_TOKEN,
      "real",
    );
    const aliased = wranglerChildEnv({ CLOUDFLARE_API: "alias" });
    assert.equal(aliased.CLOUDFLARE_API_TOKEN, "alias");
    assert.equal("CLOUDFLARE_API" in aliased, false);
  });

  test("blank values count as unset", () => {
    assert.equal(
      wranglerChildEnv({ CLOUDFLARE_API_TOKEN: "  ", CLOUDFLARE_API: "" })
        .CLOUDFLARE_API_TOKEN,
      "proxy-injected",
    );
  });

  test("passes the account id through and does not mutate its input", () => {
    const parent = { CLOUDFLARE_ACCOUNT_ID: "acct-1" };
    assert.equal(wranglerChildEnv(parent).CLOUDFLARE_ACCOUNT_ID, "acct-1");
    assert.deepEqual(parent, { CLOUDFLARE_ACCOUNT_ID: "acct-1" });
  });
});

describe("migration levels", () => {
  const local = listLocalMigrations(MIGRATIONS_DIR);
  const prodLevel = "0029_faithful_mandrill.sql";
  const upto = local.slice(0, local.indexOf(prodLevel) + 1);

  test("this checkout contains production's level and newer migrations", () => {
    assert.ok(local.includes(prodLevel));
    assert.ok(
      local.length > upto.length,
      "expected migrations newer than 0029",
    );
  });

  test("a fresh dev needs everything up to production's level and rehearses the rest", () => {
    const plan = planMigrationLevels({
      localFiles: local,
      prodApplied: upto,
      devApplied: [],
    });
    assert.equal(plan.prodLatest, prodLevel);
    assert.equal(plan.devLatest, null);
    assert.deepEqual(plan.upto, upto);
    assert.deepEqual(plan.devPending, upto);
    assert.deepEqual(plan.upgrade, local.slice(upto.length));
  });

  test("a partly migrated dev only needs the difference", () => {
    const plan = planMigrationLevels({
      localFiles: local,
      prodApplied: upto,
      devApplied: upto.slice(0, 5),
    });
    assert.deepEqual(plan.devPending, upto.slice(5));
  });

  test("a dev at production's level needs nothing", () => {
    const plan = planMigrationLevels({
      localFiles: local,
      prodApplied: upto,
      devApplied: upto,
    });
    assert.deepEqual(plan.devPending, []);
  });

  test("a dev past production asks for --reset with the typed confirmation", () => {
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: local,
          prodApplied: upto,
          devApplied: local,
        }),
      /already past production's level.*--reset --confirm flaremo-dev/s,
    );
  });

  test("refuses when production is ahead of this checkout", () => {
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: upto.slice(0, -1),
          prodApplied: upto,
          devApplied: [],
        }),
      /does not contain \(0029_faithful_mandrill\.sql\)/,
    );
  });

  test("refuses when production skipped a migration", () => {
    const gap = upto.filter((name) => name !== upto[3]);
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: local,
          prodApplied: gap,
          devApplied: [],
        }),
      /skipped migrations.*0003/s,
    );
  });

  test("refuses an empty production migration table", () => {
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: local,
          prodApplied: [],
          devApplied: [],
        }),
      /no applied upstream D1 migrations/,
    );
  });

  test("refuses a dev with migrations production lacks", () => {
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: local,
          prodApplied: upto.slice(0, 10),
          devApplied: upto.slice(0, 12),
        }),
      /already past/,
    );
    assert.throws(
      () =>
        planMigrationLevels({
          localFiles: local,
          prodApplied: upto,
          devApplied: ["0000_unknown.sql"],
        }),
      /lacks or this checkout does not contain/,
    );
  });

  test("orders by the numeric prefix like wrangler does", () => {
    assert.deepEqual(
      ["0010_b.sql", "0002_a.sql", "0001_z.sql"].sort(compareMigrationNames),
      ["0001_z.sql", "0002_a.sql", "0010_b.sql"],
    );
  });
});

describe("migration tracks (upstream 0xxx, fork 9xxx_planner_)", () => {
  // Synthetic names keep these cases independent of what upstream adds next.
  const upstream = (last, first = 0) =>
    Array.from({ length: last - first + 1 }, (_, at) => {
      const number = first + at;
      return `${String(number).padStart(4, "0")}_step_${number}.sql`;
    });
  const PLANNER = "9000_planner_init.sql";
  const plan = (localFiles, prodApplied, devApplied = []) =>
    planMigrationLevels({ localFiles, prodApplied, devApplied });

  test("splits names into the two tracks in wrangler's order", () => {
    assert.deepEqual(
      splitMigrationTracks([
        "9001_planner_more.sql",
        "0010_b.sql",
        PLANNER,
        "0002_a.sql",
        "5000_scratch.sql",
        "9001_other.sql",
        "notes.sql",
      ]),
      {
        upstream: ["0002_a.sql", "0010_b.sql"],
        fork: [PLANNER, "9001_planner_more.sql"],
        unknown: ["5000_scratch.sql", "9001_other.sql", "notes.sql"],
      },
    );
  });

  test("live at [0000..0033, 9000] with 0034 in the checkout: level 0033 plus the fork file, no throw", () => {
    const result = plan([...upstream(34), PLANNER], [...upstream(33), PLANNER]);
    assert.equal(result.prodLatest, "0033_step_33.sql");
    assert.deepEqual(result.forkApplied, [PLANNER]);
    assert.deepEqual(result.levelFiles, [...upstream(33), PLANNER]);
    assert.deepEqual(result.upgrade, ["0034_step_34.sql"]);
    assert.deepEqual(result.devPending, result.levelFiles);
    assert.deepEqual(result.warnings, []);
  });

  test("live at [0000..0029] with 0030..0033 and 9000 in the checkout: level 0029, no fork files yet", () => {
    const result = plan([...upstream(33), PLANNER], upstream(29));
    assert.equal(result.prodLatest, "0029_step_29.sql");
    assert.deepEqual(result.forkApplied, []);
    assert.deepEqual(result.levelFiles, upstream(29));
    assert.deepEqual(result.upgrade, [...upstream(33, 30), PLANNER]);
  });

  test("the fork file sorts after upstream files by number, in the level and the upgrade", () => {
    const result = plan([...upstream(35), PLANNER], [...upstream(33), PLANNER]);
    assert.equal(result.levelFiles.at(-1), PLANNER);
    assert.deepEqual(result.upgrade, ["0034_step_34.sql", "0035_step_35.sql"]);
    const pending = plan([...upstream(35), PLANNER], upstream(33)).upgrade;
    assert.deepEqual(pending, [
      "0034_step_34.sql",
      "0035_step_35.sql",
      PLANNER,
    ]);
  });

  test("a genuine gap on the upstream track still throws", () => {
    const withGap = [
      ...upstream(33).filter((name) => !name.startsWith("0010_")),
      PLANNER,
    ];
    assert.throws(
      () => plan([...upstream(34), PLANNER], withGap),
      /skipped migrations older than its latest \(0010_step_10\.sql\)/,
    );
    // The fork file production has does not paper over the gap.
    assert.throws(
      () => plan([...upstream(33), PLANNER], withGap),
      /skipped migrations/,
    );
  });

  test("a gap on the fork track throws too", () => {
    assert.throws(
      () =>
        plan(
          [...upstream(33), PLANNER, "9001_planner_more.sql"],
          [...upstream(33), "9001_planner_more.sql"],
        ),
      /fork-track migrations older than its latest fork migration \(9000_planner_init\.sql\)/,
    );
  });

  test("a name that matches neither track is ignored with a warning", () => {
    const result = plan(
      [
        ...upstream(30),
        "5000_scratch.sql",
        "9001_other_thing.sql",
        "notes.sql",
      ],
      [...upstream(29), "5000_scratch.sql"],
      ["abc.sql"],
    );
    assert.deepEqual(result.levelFiles, upstream(29));
    assert.deepEqual(result.upgrade, ["0030_step_30.sql"]);
    assert.deepEqual(result.warnings, [
      "Ignoring checkout migration 5000_scratch.sql: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).",
      "Ignoring checkout migration 9001_other_thing.sql: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).",
      "Ignoring checkout migration notes.sql: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).",
      "Ignoring production migration 5000_scratch.sql: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).",
      "Ignoring dev migration abc.sql: it matches neither the upstream track (0xxx_) nor the fork planner track (9xxx_planner_).",
    ]);
  });

  test("production with only fork migrations has no upstream level", () => {
    assert.throws(
      () => plan([...upstream(5), PLANNER], [PLANNER]),
      /no applied upstream D1 migrations/,
    );
  });

  test("a fork migration production has but the checkout lacks means the checkout is behind", () => {
    assert.throws(
      () => plan(upstream(33), [...upstream(33), PLANNER]),
      /does not contain \(9000_planner_init\.sql\)/,
    );
  });

  test("dev already holding the fork files production has needs nothing more", () => {
    const result = plan(
      [...upstream(34), PLANNER],
      [...upstream(33), PLANNER],
      [...upstream(33), PLANNER],
    );
    assert.deepEqual(result.devPending, []);
    assert.equal(result.devLatest, "0033_step_33.sql");
  });

  test("dev with a fork migration production lacks is past production", () => {
    assert.throws(
      () =>
        plan([...upstream(33), PLANNER], upstream(29), [
          ...upstream(29),
          PLANNER,
        ]),
      /past production on the fork track \(9000_planner_init\.sql\).*--reset --confirm flaremo-dev/s,
    );
  });

  test("a dev past production on the upstream track is still refused when fork files are present", () => {
    assert.throws(
      () =>
        plan(
          [...upstream(34), PLANNER],
          [...upstream(33), PLANNER],
          upstream(34),
        ),
      /already past production's level/,
    );
  });
});

describe("tables outside the persistence manifest", () => {
  test("discoverExtraTables finds the fork's tables and skips everything else", () => {
    const fts =
      "CREATE VIRTUAL TABLE `memos_fts` USING fts5(memo_id UNINDEXED, content)";
    const rows = [
      { name: "users", sql: "CREATE TABLE users (id)" },
      { name: "planner_goals", sql: "CREATE TABLE planner_goals (id)" },
      { name: "planner_entries", sql: "CREATE TABLE planner_entries (id)" },
      // Looks like a shadow table but belongs to no virtual table.
      { name: "planner_data", sql: "CREATE TABLE planner_data (id)" },
      { name: "memos_fts", sql: fts },
      {
        name: "memos_fts_data",
        sql: "CREATE TABLE 'memos_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
      },
      {
        name: "memos_fts_idx",
        sql: "CREATE TABLE 'memos_fts_idx'(segid, term, pgno)",
      },
      {
        name: "memos_fts_content",
        sql: "CREATE TABLE 'memos_fts_content'(id INTEGER PRIMARY KEY)",
      },
      {
        name: "memos_fts_docsize",
        sql: "CREATE TABLE 'memos_fts_docsize'(id INTEGER PRIMARY KEY)",
      },
      {
        name: "memos_fts_config",
        sql: "CREATE TABLE 'memos_fts_config'(k PRIMARY KEY, v)",
      },
      { name: "d1_migrations", sql: "CREATE TABLE d1_migrations(id)" },
      {
        name: "sqlite_sequence",
        sql: "CREATE TABLE sqlite_sequence(name,seq)",
      },
      { name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key TEXT)" },
      { name: "embedding_tasks", sql: "CREATE TABLE embedding_tasks (id)" },
      {
        name: "memo_hourly_counts",
        sql: "CREATE TABLE memo_hourly_counts (id)",
      },
      { name: "scratch_notes", sql: null },
    ];
    assert.deepEqual(discoverExtraTables(rows), [
      "planner_data",
      "planner_entries",
      "planner_goals",
      "scratch_notes",
    ]);
    assert.deepEqual(discoverExtraTables([]), []);
  });

  test("orderByForeignKeys puts referenced tables first", () => {
    const references = new Map([
      ["planner_entries", ["planner_goals", "tasks"]],
      ["planner_goals", ["users"]],
      ["planner_notes", ["planner_entries"]],
    ]);
    assert.deepEqual(
      orderByForeignKeys(
        ["planner_notes", "planner_entries", "planner_goals"],
        references,
      ),
      {
        order: ["planner_goals", "planner_entries", "planner_notes"],
        cyclic: [],
      },
    );
  });

  test("orderByForeignKeys ignores self references and falls back to name order for a cycle", () => {
    assert.deepEqual(
      orderByForeignKeys(["tree"], new Map([["tree", ["tree"]]])),
      { order: ["tree"], cyclic: [] },
    );
    assert.deepEqual(
      orderByForeignKeys(
        ["b", "a", "free"],
        new Map([
          ["a", ["b"]],
          ["b", ["a"]],
        ]),
      ),
      { order: ["free", "a", "b"], cyclic: ["a", "b"] },
    );
  });

  test("planTableCopy skips a discovered table dev lacks, but still refuses a manifest table", () => {
    const columns = (map) => new Map(Object.entries(map));
    const result = planTableCopy({
      tables: ["users", "scratch_notes"],
      prodColumns: columns({ users: ["id"], scratch_notes: ["id"] }),
      devColumns: columns({ users: ["id"] }),
      optional: ["scratch_notes"],
    });
    assert.deepEqual(
      result.copy.map(({ table }) => table),
      ["users"],
    );
    assert.match(
      result.skipped[0].reason,
      /no migration creates it at dev's level/,
    );
    assert.throws(
      () =>
        planTableCopy({
          tables: ["users"],
          prodColumns: columns({ users: ["id"] }),
          devColumns: columns({}),
          optional: ["scratch_notes"],
        }),
      /diverged/,
    );
  });
});

describe("table copy policy", () => {
  const columns = (map) => new Map(Object.entries(map));

  test("the policy lists only name real restore tables", () => {
    for (const table of [...EPHEMERAL_TABLES, ...SIDE_EFFECT_TABLES]) {
      assert.ok(
        RESTORE_TABLES.includes(table),
        `${table} is not a restore table`,
      );
    }
    assert.deepEqual(EPHEMERAL_TABLES, ["auth_sessions", "auth_verifications"]);
    assert.ok(!RESTORE_TABLES.includes("d1_migrations"));
  });

  test("never copies sessions or verification tokens, and skips outbound integrations by default", () => {
    const shared = ["id", "user_id"];
    const present = Object.fromEntries(
      [...EPHEMERAL_TABLES, ...SIDE_EFFECT_TABLES, "users", "memos"].map(
        (table) => [table, shared],
      ),
    );
    const tables = [
      "users",
      "memos",
      ...EPHEMERAL_TABLES,
      ...SIDE_EFFECT_TABLES,
    ];
    const defaults = planTableCopy({
      tables,
      prodColumns: columns(present),
      devColumns: columns(present),
    });
    assert.deepEqual(
      defaults.copy.map(({ table }) => table),
      ["users", "memos"],
    );
    assert.deepEqual(
      defaults.skipped.map(({ table }) => table).sort(),
      [...EPHEMERAL_TABLES, ...SIDE_EFFECT_TABLES].sort(),
    );
    const included = planTableCopy({
      tables,
      prodColumns: columns(present),
      devColumns: columns(present),
      includeSideEffectTables: true,
    });
    assert.deepEqual(
      included.copy.map(({ table }) => table).sort(),
      ["memos", "users", ...SIDE_EFFECT_TABLES].sort(),
    );
    assert.deepEqual(
      included.skipped.map(({ table }) => table).sort(),
      [...EPHEMERAL_TABLES].sort(),
    );
  });

  test("copies in dependency order and skips tables the upgrade will create", () => {
    const plan = planTableCopy({
      prodColumns: columns({ users: ["id"], memos: ["id"] }),
      devColumns: columns({ users: ["id"], memos: ["id"] }),
    });
    assert.deepEqual(
      plan.copy.map(({ table }) => table),
      ["users", "memos"],
    );
    const created = plan.skipped.find(
      ({ table }) => table === "memory_evidence",
    );
    assert.match(created.reason, /created by the upgrade migrations/);
  });

  test("copies the columns both sides have, in dev order, and says what it drops", () => {
    const plan = planTableCopy({
      tables: ["memos"],
      prodColumns: columns({ memos: ["id", "content", "legacy"] }),
      devColumns: columns({ memos: ["id", "team_id", "content"] }),
    });
    assert.deepEqual(plan.copy[0].columns, ["id", "content"]);
    assert.equal(plan.copy[0].warnings.length, 2);
    assert.match(plan.copy[0].warnings.join("\n"), /legacy/);
    assert.match(plan.copy[0].warnings.join("\n"), /team_id/);
  });

  test("refuses diverged schemas", () => {
    assert.throws(
      () =>
        planTableCopy({
          tables: ["memos"],
          prodColumns: columns({ memos: ["id"] }),
          devColumns: columns({}),
        }),
      /diverged/,
    );
    assert.throws(
      () =>
        planTableCopy({
          tables: ["memos"],
          prodColumns: columns({ memos: ["a"] }),
          devColumns: columns({ memos: ["b"] }),
        }),
      /no common columns/,
    );
  });
});

describe("import order", () => {
  const everything = new Map(RESTORE_TABLES.map((table) => [table, ["id"]]));

  test("clears children before parents, the reverse of the restore order", () => {
    const order = planClearTables(everything);
    assert.deepEqual(order, [...RESTORE_TABLES].reverse());
    // The ON DELETE RESTRICT relationships in the schema.
    const clearedBefore = (child, parent) =>
      order.indexOf(child) < order.indexOf(parent);
    assert.ok(clearedBefore("auth_bootstrap", "users"));
    assert.ok(clearedBefore("auth_bootstrap", "auth_users"));
    assert.ok(clearedBefore("articles", "auth_organizations"));
  });

  test("only clears tables that exist in dev at the current level", () => {
    const partial = new Map([...everything, ["memory_evidence", []]]);
    const order = planClearTables(partial);
    assert.ok(!order.includes("memory_evidence"));
    assert.equal(order.length, RESTORE_TABLES.length - 1);
  });
});

describe("SQL builders", () => {
  test("sqlLiteral escapes and types values", () => {
    assert.equal(sqlLiteral(null), "NULL");
    assert.equal(sqlLiteral(undefined), "NULL");
    assert.equal(sqlLiteral(12), "12");
    assert.equal(sqlLiteral(1.5), "1.5");
    assert.equal(sqlLiteral(Number.NaN), "NULL");
    assert.equal(sqlLiteral(true), "1");
    assert.equal(sqlLiteral(false), "0");
    assert.equal(sqlLiteral(10n), "10");
    assert.equal(sqlLiteral("it's"), "'it''s'");
    assert.equal(sqlLiteral("a\nb;--c"), "'a\nb;--c'");
    assert.equal(sqlLiteral([0, 255, 16]), "X'00ff10'");
    assert.equal(sqlLiteral({ a: "x'y" }), `'{"a":"x''y"}'`);
  });

  test("quoteIdent doubles embedded quotes", () => {
    assert.equal(quoteIdent("memos"), '"memos"');
    assert.equal(quoteIdent('we"ird'), '"we""ird"');
  });

  test("buildCountsQuery is one statement", () => {
    const sql = buildCountsQuery(["users", "memos_fts"]);
    assert.equal(
      sql,
      'SELECT (SELECT COUNT(*) FROM "users") AS "users", (SELECT COUNT(*) FROM "memos_fts") AS "memos_fts";',
    );
    assert.equal(splitSqlStatements(sql).length, 1);
    assert.equal(isReadOnlySql(sql), true);
  });

  test("buildImportSql defers FKs, clears tables, then inserts in order", () => {
    const sql = buildImportSql({
      clearTables: ["memos", "users"],
      inserts: [
        {
          table: "users",
          columns: ["id", "name"],
          rows: [{ id: "u1", name: "O'Neil" }],
        },
        {
          table: "memos",
          columns: ["id", "content", "pinned", "deleted_at"],
          rows: [
            {
              id: "m1",
              content: "line one\nline two",
              pinned: 0,
              deleted_at: null,
            },
            { id: "m2", content: "x", pinned: 1, deleted_at: "2026-01-01" },
          ],
        },
      ],
    });
    assert.deepEqual(sql.trimEnd().split("\n"), [
      "PRAGMA defer_foreign_keys=TRUE;",
      'DELETE FROM "memos";',
      'DELETE FROM "users";',
      `INSERT INTO "users" ("id", "name") VALUES ('u1', 'O''Neil');`,
      `INSERT INTO "memos" ("id", "content", "pinned", "deleted_at") VALUES ('m1', 'line one`,
      `line two', 0, NULL);`,
      `INSERT INTO "memos" ("id", "content", "pinned", "deleted_at") VALUES ('m2', 'x', 1, '2026-01-01');`,
    ]);
  });

  test("planExportBatches keeps small data in one call and splits big data", () => {
    const counts = { a: 10, b: 20, c: 5000, d: 1, e: 0 };
    assert.deepEqual(planExportBatches(["a", "b", "d", "e"], counts), [
      ["a", "b", "d", "e"],
    ]);
    assert.deepEqual(planExportBatches(["a", "b", "c", "d", "e"], counts), [
      ["a", "b"],
      ["c"],
      ["d", "e"],
    ]);
    assert.deepEqual(planExportBatches(["a", "b", "d"], counts, 25), [
      ["a"],
      ["b", "d"],
    ]);
    assert.deepEqual(planExportBatches(["c"], { c: 99999 }), [["c"]]);
    assert.deepEqual(planExportBatches([], {}), []);
  });

  test("summarizeCounts flags a mismatch and tolerates production drifting", () => {
    const { rows, mismatches } = summarizeCounts({
      copy: [{ table: "memos" }, { table: "users" }, { table: "tags" }],
      skipped: [{ table: "auth_sessions", reason: "ephemeral" }],
      exported: { memos: 3, users: 1, tags: 2 },
      prod: { memos: 4, users: 1, tags: 2, auth_sessions: 7 },
      dev: { memos: 3, users: 1, tags: 1, auth_sessions: 0 },
    });
    assert.deepEqual(mismatches, ["tags: exported 2 rows but dev holds 1"]);
    assert.match(
      rows.find((row) => row.table === "memos").status,
      /production changed since the export: now 4/,
    );
    assert.equal(rows.find((row) => row.table === "users").status, "ok");
    assert.equal(rows.find((row) => row.table === "tags").status, "MISMATCH");
    assert.match(
      rows.find((row) => row.table === "auth_sessions").status,
      /not copied: ephemeral/,
    );
  });
});

describe("command line", () => {
  test("parses commands and options", () => {
    const cli = parseCli([
      "clone",
      "--reset",
      "--confirm",
      "flaremo-dev",
      "--d1-id",
      DEV_D1_ID,
      "--trusted-origin",
      "https://a.example.com",
      "--trusted-origin",
      "https://b.example.com",
      "--include-side-effect-tables",
      "--keep-dump",
      "--dry-run",
    ]);
    assert.equal(cli.command, "clone");
    assert.equal(cli.options.reset, true);
    assert.equal(cli.options.confirm, "flaremo-dev");
    assert.equal(cli.options.d1Id, DEV_D1_ID);
    assert.deepEqual(cli.options.trustedOrigins, [
      "https://a.example.com",
      "https://b.example.com",
    ]);
    assert.equal(cli.options.includeSideEffectTables, true);
    assert.equal(cli.options.keepDump, true);
    assert.equal(cli.options.dryRun, true);
  });

  test("rejects unknown options and extra arguments", () => {
    assert.throws(() => parseCli(["clone", "--force"]));
    assert.throws(() => parseCli(["clone", "extra"]), /Unexpected argument/);
  });

  test("main prints help, rejects unknown commands, and reports failures", (t) => {
    const out = [];
    const err = [];
    t.mock.method(console, "log", (line) => out.push(String(line)));
    t.mock.method(console, "error", (line) => err.push(String(line)));
    assert.equal(main(["--help"]), 0);
    assert.match(out.join("\n"), /Usage: node scripts\/fork\/dev-env\.mjs/);
    assert.equal(main([]), 2);
    assert.equal(main(["bogus"]), 2);
    assert.equal(main(["clone", "--nope"]), 2);
    assert.match(err.join("\n"), /Unknown command "bogus"/);
    // No state, no id: clone fails before any wrangler call.
    const exec = () => assert.fail("wrangler must not run");
    assert.equal(
      main(["clone"], {
        env: {},
        exec,
        stateDir: mkdtempSync(join(tmpdir(), "dev-env-main-")),
        log: () => {},
      }),
      1,
    );
    assert.match(err.join("\n"), /run provision first/);
  });

  test("transient wrangler failures are recognised, SQL errors are not", () => {
    const transient = (output) =>
      new WranglerError("x", { status: 1, stdout: "", stderr: output });
    assert.equal(
      isTransientWranglerError(transient("Authentication error [code: 10000]")),
      true,
    );
    assert.equal(isTransientWranglerError(transient("fetch failed")), true);
    assert.equal(
      isTransientWranglerError(
        transient("no such table: d1_migrations [code: 7500]"),
      ),
      false,
    );
    assert.equal(
      isTransientWranglerError(new Error("Authentication error")),
      false,
    );
    assert.equal(isTransientWranglerError(new ProdGuardError("x")), false);
  });

  test("WranglerError redacts values it was told about", () => {
    const error = new WranglerError(
      "secret put X",
      { status: 1, stdout: "", stderr: "bad value hunter2hunter2 supplied" },
      ["hunter2hunter2"],
    );
    assert.ok(!error.message.includes("hunter2hunter2"));
    assert.match(error.message, /\[redacted\]/);
  });
});

// ---------------------------------------------------------------------------
// End to end against a fake Cloudflare

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // node:sqlite needs Node 22.5 or newer; skip the end-to-end suite without it.
}

const PROD_LEVEL = "0029_faithful_mandrill.sql";
const ATTACHMENT_KEY = "attachments/memos-1/photo.png";
const NOW = "2026-09-01T10:00:00.000Z";

function harness(t, { env = {}, migrationsDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dev-env-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = new FakeWrangler({ DatabaseSync });
  const logs = [];
  const localRuns = [];
  const devEnv = new DevEnv({
    stateDir: join(root, "state"),
    backupsDir: join(root, "backups"),
    ...(migrationsDir ? { migrationsDir } : {}),
    env,
    exec: fake.exec,
    runLocal: (command, args) => localRuns.push([command, ...args]),
    log: (line) => logs.push(String(line)),
    sleep: () => {},
    retryDelayMs: 0,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
  });
  return { root, fake, devEnv, logs, localRuns };
}

/** A production D1 at 0029 with one user, memos, memories, two PATs, ... */
function seedProduction(
  fake,
  {
    withObject = true,
    withAttachment = true,
    migrationsDir = MIGRATIONS_DIR,
    applied,
    planner = false,
    scratchTable = false,
  } = {},
) {
  const db = fake.addDatabase(PROD.d1Name, PROD.d1Id);
  const files = sortedMigrationFiles(MIGRATIONS_DIR);
  fake.applyMigrationFiles(
    db,
    migrationsDir,
    applied ?? files.slice(0, files.indexOf(PROD_LEVEL) + 1),
  );
  const insert = (sql, ...params) => db.prepare(sql).run(...params);
  const ms = 1767225600000;
  insert(
    "INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('users/owner', 'owner@example.com', 'Owner', ?, ?)",
    NOW,
    NOW,
  );
  insert(
    "INSERT INTO auth_users (id, name, email, email_verified, username, display_username, created_at, updated_at) VALUES ('au_1', 'Owner', 'owner@example.com', 1, 'owner', 'owner', ?, ?)",
    ms,
    ms,
  );
  insert(
    "INSERT INTO auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('acc_1', 'au_1', 'credential', 'au_1', 'scrypt$login-hash', ?, ?)",
    ms,
    ms,
  );
  insert(
    "INSERT INTO auth_user_links (auth_user_id, flaremo_user_id, created_at) VALUES ('au_1', 'users/owner', ?)",
    ms,
  );
  insert(
    "INSERT INTO auth_bootstrap (id, state, auth_user_id, flaremo_user_id, created_at, completed_at) VALUES ('default', 'completed', 'au_1', 'users/owner', ?, ?)",
    ms,
    ms,
  );
  insert(
    "INSERT INTO auth_members (id, organization_id, user_id, role, created_at) VALUES ('members/1', 'orgs/default-team', 'au_1', 'owner', ?)",
    ms,
  );
  for (const [id, key] of [
    ["k1", "hash-1"],
    ["k2", "hash-2"],
  ]) {
    insert(
      "INSERT INTO auth_apikeys (id, name, reference_id, key, start, prefix, created_at, updated_at) VALUES (?, ?, 'au_1', ?, 'memos_pat_ab', 'memos_pat_', ?, ?)",
      id,
      `client ${id}`,
      key,
      ms,
      ms,
    );
  }
  for (const [id, content, status] of [
    ["memos/1", "first note #alpha", "normal"],
    [
      "memos/2",
      "it's a second note\nwith a newline; and a semicolon",
      "normal",
    ],
    ["memos/3", "a trashed note", "trashed"],
  ]) {
    insert(
      "INSERT INTO memos (id, user_id, content, status, created_at, updated_at) VALUES (?, 'users/owner', ?, ?, ?, ?)",
      id,
      content,
      status,
      NOW,
      NOW,
    );
  }
  insert(
    "INSERT INTO memo_tags (memo_id, user_id, tag, created_at) VALUES ('memos/1', 'users/owner', 'alpha', ?)",
    NOW,
  );
  for (const [id, content, verification] of [
    ["mem/1", "prefers dark mode", "observed"],
    ["mem/2", "might like tea", "inferred"],
    ["mem/3", "uses pnpm", "observed"],
  ]) {
    insert(
      "INSERT INTO memory_items (id, user_id, content, fingerprint, verification, created_at, updated_at) VALUES (?, 'users/owner', ?, ?, ?, ?, ?)",
      id,
      content,
      `fp-${id}`,
      verification,
      NOW,
      NOW,
    );
  }
  insert(
    "INSERT INTO settings (user_id, key, value, updated_at) VALUES ('users/owner', 'theme', 'dark', ?)",
    NOW,
  );
  if (withAttachment) {
    insert(
      "INSERT INTO attachments (id, user_id, memo_id, r2_key, filename, content_type, size, created_at, updated_at) VALUES ('att1', 'users/owner', 'memos/1', ?, 'photo.png', 'image/png', 9, ?, ?)",
      ATTACHMENT_KEY,
      NOW,
      NOW,
    );
  }
  if (planner) {
    for (const [id, title] of [
      ["g1", "Ship the planner"],
      ["g2", "Read more"],
    ]) {
      insert(
        "INSERT INTO planner_goals (id, user_id, title, created_at) VALUES (?, 'users/owner', ?, ?)",
        id,
        title,
        NOW,
      );
    }
    for (const [id, goal] of [
      ["e1", "g1"],
      ["e2", "g1"],
      ["e3", "g2"],
    ]) {
      insert(
        "INSERT INTO planner_entries (id, goal_id, horizon, period_start) VALUES (?, ?, 'week', '2026-09-28')",
        id,
        goal,
      );
    }
  }
  if (scratchTable) {
    db.exec("CREATE TABLE scratch_notes (id TEXT PRIMARY KEY, note TEXT)");
    insert("INSERT INTO scratch_notes VALUES ('s1', 'made by hand')");
  }
  // Rows that must not reach dev.
  insert(
    "INSERT INTO auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES ('s1', ?, 'live-session-token', ?, ?, 'au_1')",
    ms,
    ms,
    ms,
  );
  insert(
    "INSERT INTO memos_webhooks (id, user_id, url, signing_secret, created_at, updated_at) VALUES ('wh1', 'users/owner', 'https://hooks.example.com/notify', 'whsec', ?, ?)",
    NOW,
    NOW,
  );
  insert(
    "INSERT INTO integration_config (id, revision, enabled, ciphertext) VALUES ('email', 'r1', 1, 'ciphertext')",
  );
  insert(
    "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES ('ps1', 'users/owner', 'https://push.example.com/abc', 'k', 'a', ?, ?)",
    NOW,
    NOW,
  );
  fake.buckets.set(
    PROD.bucket,
    new Map(
      withObject
        ? [
            [
              ATTACHMENT_KEY,
              { bytes: Buffer.from("png-bytes"), contentType: "image/png" },
            ],
          ]
        : [],
    ),
  );
  return db;
}

function fingerprint(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name",
    )
    .all();
  return createHash("sha256")
    .update(
      JSON.stringify(
        tables.map(({ name }) => [
          name,
          db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ]),
      ),
    )
    .digest("hex");
}

// The production columns, minus the embedding bookkeeping the restore resets.
// Dev gains columns from the upgrade migrations, so compare on these only.
function copiedData(db, prod, table) {
  const columns = prod
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((column) => column.name)
    .filter((name) => !name.startsWith("embedding_"));
  return db
    .prepare(
      `SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM "${table}" ORDER BY rowid`,
    )
    .all()
    .map((row) => ({ ...row }));
}

const rowsOf = (db, table) =>
  db
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
    .all()
    .map((row) => ({ ...row }));
const count = (db, table) =>
  db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
const latestMigration = (db) =>
  db.prepare('SELECT name FROM "d1_migrations" ORDER BY id DESC LIMIT 1').get()
    .name;

function writeCapableCalls(fake, devEnv, from = 0) {
  const config = parseConfigText(readFileSync(devEnv.paths.devConfig, "utf8"));
  return fake.calls
    .slice(from)
    .filter((call) => assertSafeWranglerCall(call.argv, config).writeCapable);
}

const e2e = DatabaseSync ? describe : describe.skip;

e2e("dev environment against a fake Cloudflare", () => {
  test("provision creates every dev resource and secret once, and is idempotent", (t) => {
    const h = harness(t);
    const first = h.devEnv.provision({});
    assert.deepEqual([...h.fake.databases.keys()], ["flaremo-dev"]);
    assert.deepEqual([...h.fake.buckets.keys()], ["flaremo-dev-attachments"]);
    assert.deepEqual([...h.fake.queues].sort(), [
      "flaremo-dev-data-export",
      "flaremo-dev-member-removal",
    ]);
    assert.deepEqual([...h.fake.indexes].sort(), [
      ["flaremo-dev-memories", { dimensions: 1024, metric: "cosine" }],
      ["flaremo-dev-memos", { dimensions: 1024, metric: "cosine" }],
    ]);
    assert.deepEqual(
      h.fake.secretNames("flaremo-dev").sort(),
      [...REQUIRED_WORKER_SECRETS].sort(),
    );
    assert.equal(first.created.length, 6);

    // Secrets: random, valid, and never printed.
    const output = h.logs.join("\n");
    for (const [name, value] of h.fake.secretValues("flaremo-dev")) {
      assert.equal(inspectWorkerSecret(name, value).status, "ok", name);
      assert.ok(!output.includes(value), `${name} must never be logged`);
    }
    for (const [, value] of h.fake.secretValues("flaremo-dev")) {
      for (const call of h.fake.calls) {
        assert.ok(
          !call.argv.includes(value),
          "a secret value must never ride in argv",
        );
      }
    }
    for (const call of h.fake.calls) {
      assert.ok(!call.argv.includes("RESEND_API_KEY"));
    }
    const [valueA, valueB] = h.fake
      .secretValues("flaremo-dev")
      .map(([, value]) => value);
    assert.notEqual(valueA, valueB);

    // The real D1 id is remembered and written into the config.
    const id = h.fake.databases.get("flaremo-dev").id;
    assert.equal(h.devEnv.readState().d1Id, id);
    assert.equal(
      parseConfigText(readFileSync(h.devEnv.paths.devConfig, "utf8"))
        .d1_databases[0].database_id,
      id,
    );

    // Nothing in provision names a production resource.
    assert.ok(
      h.fake.calls.every(
        (call) =>
          !call.argv.some((token) => isProdIdentifier(token.split("/")[0])),
      ),
    );

    // A second run changes nothing.
    const before = h.fake.calls.length;
    const secrets = h.fake.secretValues("flaremo-dev");
    const second = h.devEnv.provision({});
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.secretsSet, []);
    assert.equal(writeCapableCalls(h.fake, h.devEnv, before).length, 0);
    assert.deepEqual(h.fake.secretValues("flaremo-dev"), secrets);
  });

  test("provision refuses a Vectorize index with the wrong dimensions", (t) => {
    const h = harness(t);
    h.fake.indexes.set("flaremo-dev-memos", {
      dimensions: 768,
      metric: "cosine",
    });
    assert.throws(
      () => h.devEnv.provision({}),
      /768 dimensions; FlareMo needs 1024/,
    );
  });

  test("clone copies live data into dev at the same level, rehearses the upgrade, and verifies", (t) => {
    const h = harness(t);
    const prod = seedProduction(h.fake);
    const prodBefore = fingerprint(prod);
    h.devEnv.provision({});
    const summary = h.devEnv.clone({});
    const dev = h.fake.dbByName("flaremo-dev");

    // Production was only read.
    assert.equal(fingerprint(prod), prodBefore);
    const touchedProduction = h.fake.calls.filter((call) =>
      call.argv.some((token) => isProdIdentifier(token.split("/")[0])),
    );
    assert.ok(touchedProduction.length >= 5, "expected production reads");
    assert.deepEqual(
      writeCapableCalls(h.fake, h.devEnv).filter((call) =>
        touchedProduction.includes(call),
      ),
      [],
    );

    // Dev ran the upgrade rehearsal: it is at the newest migration.
    const local = sortedMigrationFiles(MIGRATIONS_DIR);
    assert.equal(latestMigration(dev), local.at(-1));
    assert.equal(count(dev, "d1_migrations"), local.length);
    assert.ok(
      dev
        .prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_evidence'")
        .get(),
    );
    assert.equal(summary.plan.prodLatest, PROD_LEVEL);
    assert.deepEqual(
      summary.plan.upgrade,
      local.slice(local.indexOf(PROD_LEVEL) + 1),
    );

    // The data is a faithful copy, including quoting and newlines.
    for (const [table, expected] of Object.entries({
      users: 1,
      auth_users: 1,
      auth_accounts: 1,
      auth_user_links: 1,
      auth_bootstrap: 1,
      auth_members: 1,
      auth_organizations: 1,
      auth_apikeys: 2,
      memos: 3,
      memo_tags: 1,
      memory_items: 3,
      settings: 1,
      attachments: 1,
    })) {
      assert.equal(count(dev, table), expected, table);
      assert.deepEqual(
        copiedData(dev, prod, table),
        copiedData(prod, prod, table),
        `${table} content`,
      );
    }
    assert.equal(
      dev.prepare("SELECT password FROM auth_accounts").get().password,
      "scrypt$login-hash",
    );
    assert.equal(
      dev.prepare("SELECT content FROM memos WHERE id = 'memos/2'").get()
        .content,
      "it's a second note\nwith a newline; and a semicolon",
    );

    // Never copied: sessions, and the outbound integrations.
    for (const table of [
      "auth_sessions",
      "auth_verifications",
      "memos_webhooks",
      "memos_webhook_events",
      "memos_webhook_deliveries",
      "push_subscriptions",
      "integration_config",
      "voice_service_config",
    ]) {
      assert.equal(count(dev, table), 0, `${table} must stay empty in dev`);
    }
    const skipped = summary.skipped.map(({ table }) => table);
    for (const table of [
      "auth_sessions",
      "auth_verifications",
      "memos_webhooks",
      "integration_config",
      "push_subscriptions",
    ]) {
      assert.ok(
        skipped.includes(table),
        `${table} should be reported as skipped`,
      );
    }

    // Derived state is rebuilt for the fresh Vectorize indexes: memos that are
    // normal/archived, and active memories that are not unconfirmed guesses.
    assert.equal(count(dev, "embedding_tasks"), 2 + 2);
    assert.equal(
      dev
        .prepare(
          "SELECT COUNT(*) AS n FROM memos WHERE embedding_status = 'pending'",
        )
        .get().n,
      2,
    );
    assert.ok(count(dev, "memo_hourly_counts") > 0);
    assert.equal(count(dev, "memos_fts"), count(dev, "memos"));
    assert.equal(count(dev, "memory_fts"), count(dev, "memory_items"));

    // R2: the one attachment object was copied with its content type.
    const copied = h.fake.buckets
      .get("flaremo-dev-attachments")
      .get(ATTACHMENT_KEY);
    assert.equal(copied.bytes.toString(), "png-bytes");
    assert.equal(copied.contentType, "image/png");
    assert.deepEqual(summary.r2, { total: 1, copied: 1, failed: [] });
    assert.equal(h.fake.buckets.get(PROD.bucket).size, 1);

    // The credential-bearing export is gone; the report stays.
    const dumpDir = join(
      h.root,
      "backups",
      readdirSync(join(h.root, "backups"))[0],
    );
    assert.ok(!existsSync(join(dumpDir, "prod-data.sql")));
    assert.match(
      readFileSync(join(dumpDir, "report.md"), "utf8"),
      /Production level: 0029_faithful_mandrill\.sql/,
    );
    assert.match(h.logs.join("\n"), /Clone complete/);
  });

  test("clone keeps the export when asked, with owner-only permissions", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    h.devEnv.provision({});
    h.devEnv.clone({ keepDump: true });
    const dumpDir = join(
      h.root,
      "backups",
      readdirSync(join(h.root, "backups"))[0],
    );
    const dump = join(dumpDir, "prod-data.sql");
    assert.ok(existsSync(dump));
    assert.match(
      readFileSync(dump, "utf8"),
      /^PRAGMA defer_foreign_keys=TRUE;/,
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(dump).mode & 0o777, 0o600);
    }
  });

  test("clone can include the outbound integration tables on request", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    h.devEnv.provision({});
    h.devEnv.clone({ includeSideEffectTables: true });
    const dev = h.fake.dbByName("flaremo-dev");
    assert.equal(count(dev, "memos_webhooks"), 1);
    assert.equal(count(dev, "integration_config"), 1);
    assert.equal(count(dev, "push_subscriptions"), 1);
    assert.equal(count(dev, "auth_sessions"), 0, "sessions are never copied");
  });

  test("clone --dry-run reads production and plans, but writes nothing", (t) => {
    const h = harness(t);
    const prod = seedProduction(h.fake);
    const prodBefore = fingerprint(prod);
    h.devEnv.provision({});
    const before = h.fake.calls.length;
    const summary = h.devEnv.clone({ dryRun: true });
    assert.equal(writeCapableCalls(h.fake, h.devEnv, before).length, 0);
    assert.equal(fingerprint(prod), prodBefore);
    assert.equal(
      h.fake
        .dbByName("flaremo-dev")
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master")
        .get().n,
      0,
    );
    assert.ok(summary.copy.includes("memos"));
    assert.match(h.logs.join("\n"), /dry-run/);
  });

  for (const strict of [false, true]) {
    test(`a clone that failed after the import can simply be run again${
      strict ? " (foreign keys checked immediately)" : ""
    }`, (t) => {
      const h = harness(t);
      h.fake.stripDeferredForeignKeys = strict;
      const prod = seedProduction(h.fake);
      const prodBefore = fingerprint(prod);
      h.devEnv.provision({});
      // The first migrations apply after the import is the upgrade rehearsal.
      h.fake.faults.push({
        when: (argv) =>
          argv[0] === "d1" &&
          argv[1] === "migrations" &&
          argv.includes("apply") &&
          h.fake.calls.some((call) => call.argv.includes("--file")),
        stderr: "migration 0030 failed: disk I/O error [code: 7500]",
      });
      assert.throws(() => h.devEnv.clone({}), /migration 0030 failed/);
      const dev = h.fake.dbByName("flaremo-dev");
      assert.equal(
        latestMigration(dev),
        PROD_LEVEL,
        "dev is left at production's level",
      );
      assert.equal(count(dev, "memos"), 3, "the imported data is still there");
      assert.match(h.logs.join("\n"), /import file .* was kept for diagnosis/);

      // Dev already holds data at production's level: the import must clear it
      // children-first (auth_bootstrap and articles RESTRICT their parents).
      h.devEnv.clone({});
      assert.equal(
        latestMigration(dev),
        sortedMigrationFiles(MIGRATIONS_DIR).at(-1),
      );
      assert.equal(count(dev, "memos"), 3);
      assert.equal(count(dev, "auth_bootstrap"), 1);
      assert.equal(fingerprint(prod), prodBefore);
    });
  }

  test("clone falls back to one query per statement when D1 does not answer per statement", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    h.fake.collapseBatches = true;
    h.devEnv.provision({});
    h.devEnv.clone({});
    assert.match(h.logs.join("\n"), /querying one by one/);
    const dev = h.fake.dbByName("flaremo-dev");
    assert.equal(count(dev, "memos"), 3);
    assert.equal(count(dev, "auth_apikeys"), 2);
    assert.equal(
      latestMigration(dev),
      sortedMigrationFiles(MIGRATIONS_DIR).at(-1),
    );
  });

  test("a transient Cloudflare error is retried; a SQL error is not", (t) => {
    const h = harness(t);
    h.devEnv.provision({});
    const selects = () =>
      h.fake.calls.filter((call) => call.argv[1] === "execute").length;

    h.fake.faults.push({
      when: (argv) => argv[1] === "execute",
      stderr: "Authentication error [code: 10000]",
    });
    h.devEnv.d1Select("DB", "SELECT 1");
    assert.equal(selects(), 2, "one failure, one retry");
    assert.match(h.logs.join("\n"), /transient failure \(attempt 1\/3\)/);

    const base = selects();
    h.fake.faults.push({
      when: (argv) => argv[1] === "execute",
      stderr: "Authentication error [code: 10000]",
      once: false,
    });
    assert.throws(
      () => h.devEnv.d1Select("DB", "SELECT 1"),
      /Authentication error/,
    );
    assert.equal(selects() - base, 3, "gives up after three attempts");

    h.fake.faults.length = 0;
    const sqlBase = selects();
    h.fake.faults.push({
      when: (argv) => argv[1] === "execute",
      stderr: "no such table: nope [code: 7500]",
      once: false,
    });
    assert.throws(
      () => h.devEnv.d1Select("DB", "SELECT * FROM nope"),
      /no such table/,
    );
    assert.equal(selects() - sqlBase, 1, "SQL errors are not retried");
  });

  test("a missing migrations table is recognised even when wrangler reports the error as JSON", (t) => {
    const h = harness(t);
    h.devEnv.provision({});
    for (const status of [0, 1]) {
      h.fake.faults.push({
        when: (argv) => argv[1] === "execute",
        status,
        stdout: JSON.stringify({
          error: {
            text: "no such table: d1_migrations: SQLITE_ERROR [code: 7500]",
          },
        }),
      });
      assert.deepEqual(h.devEnv.listAppliedMigrations("DB"), []);
    }
    h.fake.faults.push({
      when: (argv) => argv[1] === "execute",
      status: 0,
      stdout: JSON.stringify({
        error: { text: "D1_ERROR: database is locked" },
      }),
    });
    assert.throws(
      () => h.devEnv.listAppliedMigrations("DB"),
      /database is locked/,
    );
  });

  test("clone with no attachments (the live case) makes no R2 calls", (t) => {
    const h = harness(t);
    seedProduction(h.fake, { withAttachment: false });
    h.devEnv.provision({});
    const before = h.fake.calls.length;
    const summary = h.devEnv.clone({});
    assert.deepEqual(summary.r2, { total: 0, copied: 0, failed: [] });
    assert.ok(
      h.fake.calls.slice(before).every((call) => call.argv[0] !== "r2"),
    );
    assert.equal(count(h.fake.dbByName("flaremo-dev"), "attachments"), 0);
  });

  test("provision adopts a dev D1 that already exists instead of creating one", (t) => {
    const h = harness(t);
    h.fake.addDatabase("flaremo-dev", "22222222-2222-4222-8222-222222222222");
    h.devEnv.provision({});
    assert.equal(
      h.devEnv.readState().d1Id,
      "22222222-2222-4222-8222-222222222222",
    );
    assert.ok(
      h.fake.calls.every(
        (call) => !(call.argv[0] === "d1" && call.argv[1] === "create"),
      ),
    );
  });

  test("clone refuses a dev D1 that is already past production and says how to reset", (t) => {
    const h = harness(t);
    const prod = seedProduction(h.fake);
    h.devEnv.provision({});
    h.devEnv.clone({});
    const prodBefore = fingerprint(prod);
    const before = h.fake.calls.length;
    assert.throws(
      () => h.devEnv.clone({}),
      /already past production's level.*--reset --confirm flaremo-dev/s,
    );
    assert.equal(writeCapableCalls(h.fake, h.devEnv, before).length, 0);
    assert.equal(fingerprint(prod), prodBefore);
  });

  test("--reset needs the typed confirmation, then recreates dev with a new id and clones again", (t) => {
    const h = harness(t);
    const prod = seedProduction(h.fake);
    h.devEnv.provision({});
    h.devEnv.clone({});
    const oldId = h.fake.databases.get("flaremo-dev").id;
    const prodBefore = fingerprint(prod);

    for (const options of [
      { reset: true },
      { reset: true, confirm: "flaremo" },
      { reset: true, confirm: "yes" },
    ]) {
      const before = h.fake.calls.length;
      assert.throws(() => h.devEnv.clone(options), /--confirm flaremo-dev/);
      assert.equal(
        h.fake.calls.length,
        before,
        "no wrangler call before the confirmation",
      );
    }
    assert.equal(h.fake.databases.get("flaremo-dev").id, oldId);

    h.devEnv.clone({ reset: true, confirm: "flaremo-dev" });
    const newId = h.fake.databases.get("flaremo-dev").id;
    assert.notEqual(newId, oldId);
    assert.equal(h.devEnv.readState().d1Id, newId);
    assert.equal(
      parseConfigText(readFileSync(h.devEnv.paths.devConfig, "utf8"))
        .d1_databases[0].database_id,
      newId,
    );
    const dev = h.fake.dbByName("flaremo-dev");
    assert.equal(
      latestMigration(dev),
      sortedMigrationFiles(MIGRATIONS_DIR).at(-1),
    );
    assert.equal(count(dev, "memos"), 3);
    assert.equal(fingerprint(prod), prodBefore);

    // The only deletion was of the dev D1.
    const deletes = h.fake.calls.filter(
      (call) => call.argv[0] === "d1" && call.argv[1] === "delete",
    );
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].argv[2], "flaremo-dev");
  });

  test("clone fails loudly, after the data is in, when an R2 object cannot be copied", (t) => {
    const h = harness(t);
    seedProduction(h.fake, { withObject: false });
    h.devEnv.provision({});
    assert.throws(
      () => h.devEnv.clone({}),
      new RegExp(`1 R2 object\\(s\\) were not copied:\\n- ${ATTACHMENT_KEY}`),
    );
    assert.equal(count(h.fake.dbByName("flaremo-dev"), "memos"), 3);
  });

  test("clone refuses to read a D1 named flaremo that is not the production database", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    h.fake.databases.get("flaremo").id = "99999999-9999-4999-8999-999999999999";
    h.devEnv.provision({});
    assert.throws(() => h.devEnv.clone({}), /expected d4ad3911/);
  });

  test("clone needs provision first", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    assert.throws(() => h.devEnv.clone({}), /run provision first/);
    assert.equal(h.fake.calls.length, 0);
  });

  test("clone stops when production is ahead of this checkout", (t) => {
    const h = harness(t);
    const prod = seedProduction(h.fake);
    prod
      .prepare('INSERT INTO "d1_migrations" (name) VALUES (?)')
      .run("0099_from_the_future.sql");
    h.devEnv.provision({});
    const before = h.fake.calls.length;
    assert.throws(
      () => h.devEnv.clone({}),
      /does not contain \(0099_from_the_future\.sql\)/,
    );
    assert.equal(writeCapableCalls(h.fake, h.devEnv, before).length, 0);
  });

  describe("with the fork's planner migration (9xxx_planner_)", () => {
    const PLANNER_SQL = [
      "-- Hand-written, unjournaled. planner_entries comes first on purpose: the",
      "-- copy must order tables by their foreign keys, not by this file.",
      "CREATE TABLE `planner_entries` (",
      "  `id` text PRIMARY KEY NOT NULL,",
      "  `goal_id` text NOT NULL,",
      "  `task_id` text,",
      "  `horizon` text NOT NULL,",
      "  `period_start` text NOT NULL,",
      "  FOREIGN KEY (`goal_id`) REFERENCES `planner_goals`(`id`) ON DELETE cascade,",
      "  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null",
      ");",
      "CREATE TABLE `planner_goals` (",
      "  `id` text PRIMARY KEY NOT NULL,",
      "  `user_id` text NOT NULL,",
      "  `title` text NOT NULL,",
      "  `created_at` text NOT NULL,",
      "  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade",
      ");",
      "",
    ].join("\n");
    const PLANNER = "9000_planner_init.sql";
    const NEXT_UPSTREAM = "0099_fixture_future_upgrade.sql";

    // The real migrations, upstream's next release (0099), and the planner file.
    function fixtureMigrations(t) {
      const dir = mkdtempSync(join(tmpdir(), "dev-env-migrations-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      for (const name of sortedMigrationFiles(MIGRATIONS_DIR)) {
        copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
      }
      writeFileSync(
        join(dir, NEXT_UPSTREAM),
        "ALTER TABLE `memos` ADD `future_flag` text;\n",
      );
      writeFileSync(join(dir, PLANNER), PLANNER_SQL);
      const upstream = sortedMigrationFiles(MIGRATIONS_DIR).filter((name) =>
        /^0\d{3}_/.test(name),
      );
      return { dir, upstream };
    }

    test("live is at the newest upstream migration plus 9000: dev gets both, the data, and 0099 as the rehearsal", (t) => {
      const { dir, upstream } = fixtureMigrations(t);
      const h = harness(t, { migrationsDir: dir });
      // Foreign keys checked immediately: the table order has to be right.
      h.fake.stripDeferredForeignKeys = true;
      const prod = seedProduction(h.fake, {
        migrationsDir: dir,
        applied: [...upstream, PLANNER],
        planner: true,
      });
      const prodBefore = fingerprint(prod);
      h.devEnv.provision({});
      const summary = h.devEnv.clone({});
      const dev = h.fake.dbByName("flaremo-dev");

      assert.equal(summary.plan.prodLatest, upstream.at(-1));
      assert.deepEqual(summary.plan.forkApplied, [PLANNER]);
      assert.deepEqual(summary.plan.levelFiles, [...upstream, PLANNER]);
      assert.deepEqual(summary.plan.upgrade, [NEXT_UPSTREAM]);
      assert.deepEqual(summary.plan.warnings, []);

      // Dev has every file: the level (with the fork file) first, then 0099.
      const applied = dev
        .prepare('SELECT name FROM "d1_migrations" ORDER BY id')
        .all()
        .map((row) => row.name);
      assert.deepEqual(applied, [...upstream, PLANNER, NEXT_UPSTREAM]);
      assert.ok(
        dev
          .prepare(
            "SELECT 1 FROM pragma_table_info('memos') WHERE name = 'future_flag'",
          )
          .get(),
        "the 0099 rehearsal ran",
      );

      // The planner tables are not in the persistence manifest, yet their data
      // came across, parents before children.
      const copied = summary.copy;
      assert.ok(
        copied.indexOf("planner_goals") < copied.indexOf("planner_entries"),
      );
      assert.ok(copied.indexOf("settings") < copied.indexOf("planner_goals"));
      assert.equal(count(dev, "planner_goals"), 2);
      assert.equal(count(dev, "planner_entries"), 3);
      assert.deepEqual(
        rowsOf(dev, "planner_entries"),
        rowsOf(prod, "planner_entries"),
      );
      assert.match(
        h.logs.join("\n"),
        /tables outside the persistence manifest, copied too: planner_goals, planner_entries/,
      );
      assert.equal(fingerprint(prod), prodBefore);
      // Only the fixture's two stand-ins for fork tables outside the manifest.
      // The real planner tables are in the manifest and exist in neither fake
      // database here, so the clone skips them.
      assert.deepEqual(
        summary.counts
          .filter((row) =>
            ["planner_goals", "planner_entries"].includes(row.table),
          )
          .map((row) => [row.table, row.prod, row.dev, row.status]),
        [
          ["planner_goals", 2, 2, "ok"],
          ["planner_entries", 3, 3, "ok"],
        ],
      );

      // Status reports both tracks, and a second clone is refused as past.
      const report = h.devEnv.status({ withProd: true });
      assert.equal(report.devLatest, NEXT_UPSTREAM);
      assert.deepEqual(report.devFork, [PLANNER]);
      assert.equal(report.prodLatest, upstream.at(-1));
      assert.deepEqual(report.prodFork, [PLANNER]);
      assert.throws(
        () => h.devEnv.clone({}),
        /already past production's level/,
      );
    });

    test("live has no planner migration yet: dev rehearses 9000 along with the upstream migrations", (t) => {
      const { dir } = fixtureMigrations(t);
      const h = harness(t, { migrationsDir: dir });
      h.fake.stripDeferredForeignKeys = true;
      const prod = seedProduction(h.fake, { migrationsDir: dir });
      const prodBefore = fingerprint(prod);
      h.devEnv.provision({});
      const summary = h.devEnv.clone({});
      const dev = h.fake.dbByName("flaremo-dev");

      assert.equal(summary.plan.prodLatest, PROD_LEVEL);
      assert.deepEqual(summary.plan.forkApplied, []);
      assert.deepEqual(summary.plan.upgrade.slice(-2), [
        NEXT_UPSTREAM,
        PLANNER,
      ]);
      assert.ok(
        dev
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'planner_goals'")
          .get(),
      );
      assert.equal(count(dev, "planner_goals"), 0);
      assert.equal(count(dev, "memos"), 3);
      assert.equal(
        dev
          .prepare('SELECT name FROM "d1_migrations" ORDER BY id DESC LIMIT 1')
          .get().name,
        PLANNER,
      );
      assert.equal(fingerprint(prod), prodBefore);
    });

    test("a production table no migration creates is reported and skipped, not fatal", (t) => {
      const h = harness(t);
      const prod = seedProduction(h.fake, { scratchTable: true });
      h.devEnv.provision({});
      const summary = h.devEnv.clone({});
      assert.ok(
        summary.skipped.some(
          ({ table, reason }) =>
            table === "scratch_notes" && /no migration creates it/.test(reason),
        ),
      );
      assert.ok(!summary.copy.includes("scratch_notes"));
      assert.match(
        h.logs.join("\n"),
        /skipping scratch_notes: no migration creates it at dev's level/,
      );
      assert.equal(count(h.fake.dbByName("flaremo-dev"), "memos"), 3);
      assert.equal(count(prod, "scratch_notes"), 1);
    });

    test("an unrecognised migration name in production is ignored with a warning", (t) => {
      const h = harness(t);
      const prod = seedProduction(h.fake);
      prod
        .prepare('INSERT INTO "d1_migrations" (name) VALUES (?)')
        .run("5000_hand_applied.sql");
      h.devEnv.provision({});
      const summary = h.devEnv.clone({});
      assert.equal(summary.plan.prodLatest, PROD_LEVEL);
      assert.match(
        h.logs.join("\n"),
        /WARNING Ignoring production migration 5000_hand_applied\.sql/,
      );
    });
  });

  test("the runner passes every wrangler call through the production guard", (t) => {
    const h = harness(t);
    h.devEnv.provision({});
    const before = h.fake.calls.length;
    for (const [args, options] of [
      [["d1", "delete", "flaremo", "--skip-confirmation"], {}],
      [
        [
          "d1",
          "execute",
          "flaremo",
          "--remote",
          "--command",
          "DELETE FROM memos",
        ],
        {},
      ],
      [["d1", "execute", "flaremo", "--remote", "--file", "/tmp/x.sql"], {}],
      [
        ["secret", "put", "BETTER_AUTH_SECRET", "--name", "flaremo"],
        { input: "x" },
      ],
      [
        [
          "r2",
          "object",
          "put",
          "flaremo-attachments/k",
          "--remote",
          "--file",
          "/tmp/k",
        ],
        {},
      ],
      [["queues", "delete", "flaremo-data-export"], {}],
      [["vectorize", "delete", "flaremo-memos"], {}],
      [["deploy", "--name", "flaremo"], {}],
    ]) {
      assert.throws(
        () => h.devEnv.wrangler(args, options),
        ProdGuardError,
        args.join(" "),
      );
    }
    assert.equal(
      h.fake.calls.length,
      before,
      "refused calls never reach wrangler",
    );
  });

  test("the runner only accepts the generated dev configs", (t) => {
    const h = harness(t);
    h.devEnv.provision({});
    const other = join(h.root, "wrangler.jsonc");
    writeFileSync(other, JSON.stringify(PROD_CONFIG));
    const before = h.fake.calls.length;
    assert.throws(
      () => h.devEnv.wrangler(["d1", "list"], { config: other }),
      /only the generated dev configs/,
    );
    assert.throws(
      () =>
        h.devEnv.wrangler(["deploy", "--dry-run"], {
          config: "wrangler.jsonc",
        }),
      /only the generated dev configs/,
    );
    assert.equal(h.fake.calls.length, before);
  });

  test("wrangler children get the proxy placeholder token unless a real one is set", (t) => {
    const h = harness(t, {
      env: { CLOUDFLARE_ACCOUNT_ID: "acct-1", PATH: "/usr/bin" },
    });
    h.devEnv.provision({ skipSecrets: true });
    assert.ok(h.fake.envs.length > 3);
    for (const env of h.fake.envs) {
      assert.equal(env.CLOUDFLARE_API_TOKEN, "proxy-injected");
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "acct-1");
      assert.equal(env.WRANGLER_SEND_METRICS, "false");
      assert.equal(env.PATH, "/usr/bin");
    }
    const owner = harness(t, { env: { CLOUDFLARE_API: "owner-token-value" } });
    owner.devEnv.provision({ skipSecrets: true });
    for (const env of owner.fake.envs) {
      assert.equal(env.CLOUDFLARE_API_TOKEN, "owner-token-value");
      assert.equal("CLOUDFLARE_API" in env, false);
    }
    assert.ok(!owner.logs.join("\n").includes("owner-token-value"));
  });

  test("status reports what exists and the dev level, optionally production's too", (t) => {
    const h = harness(t);
    seedProduction(h.fake);
    const empty = h.devEnv.status({});
    assert.equal(empty.d1, null);
    assert.equal(empty.worker, false);
    h.devEnv.provision({});
    h.devEnv.clone({});
    const before = h.fake.calls.length;
    const report = h.devEnv.status({ withProd: true });
    assert.deepEqual(report.problems, []);
    // The level is the newest upstream-track migration; the fork's 9xxx_planner_
    // files are tracked beside it (devFork), so they never count as the level.
    assert.equal(
      report.devLatest,
      sortedMigrationFiles(MIGRATIONS_DIR)
        .filter((name) => /^0\d{3}_/.test(name))
        .at(-1),
    );
    assert.equal(report.prodLatest, PROD_LEVEL);
    assert.equal(report.bucket, true);
    assert.deepEqual(Object.values(report.queues), [true, true]);
    assert.deepEqual(Object.values(report.indexes), [true, true]);
    assert.deepEqual(report.secrets, {
      BETTER_AUTH_SECRET: true,
      FLAREMO_BOOTSTRAP_SECRET: true,
    });
    assert.equal(
      writeCapableCalls(h.fake, h.devEnv, before).length,
      0,
      "status only reads",
    );
  });

  test("deploy --dry-run builds and stops at wrangler's dry run without touching Cloudflare", (t) => {
    const h = harness(t);
    h.devEnv.deploy({
      dryRun: true,
      d1Id: "00000000-0000-0000-0000-000000000000",
    });
    assert.deepEqual(h.localRuns, [
      ["pnpm", "--filter", "@flaremo/web", "build"],
    ]);
    assert.deepEqual(
      h.fake.calls.map((call) => call.argv.slice(0, 2)),
      [["deploy", "--dry-run"]],
    );
    h.devEnv.deploy({ dryRun: true, skipBuild: true, d1Id: DEV_D1_ID });
    assert.equal(h.localRuns.length, 1, "--skip-build skips the build");
  });

  test("deploy applies pending migrations and secrets before it deploys", (t) => {
    const h = harness(t);
    h.devEnv.provision({ skipSecrets: true });
    h.devEnv.deploy({ skipBuild: true });
    const verbs = h.fake.calls.map((call) => call.argv.slice(0, 3).join(" "));
    assert.ok(
      verbs.indexOf("secret put BETTER_AUTH_SECRET") <
        verbs.findIndex((verb) => verb.startsWith("deploy")),
    );
    assert.ok(
      verbs.findIndex((verb) => verb.startsWith("d1 migrations apply")) <
        verbs.findIndex((verb) => verb.startsWith("deploy")),
    );
    assert.equal(h.fake.workers.get("flaremo-dev").deployed, true);
    assert.equal(
      latestMigration(h.fake.dbByName("flaremo-dev")),
      sortedMigrationFiles(MIGRATIONS_DIR).at(-1),
    );
    assert.deepEqual(
      h.fake.secretNames("flaremo-dev").sort(),
      [...REQUIRED_WORKER_SECRETS].sort(),
    );
  });

  test("deploy needs a provisioned D1", (t) => {
    const h = harness(t);
    assert.throws(
      () => h.devEnv.deploy({ skipBuild: true }),
      /run provision first/,
    );
    const unprovisioned = harness(t);
    assert.throws(
      () => unprovisioned.devEnv.deploy({ skipBuild: true, d1Id: DEV_D1_ID }),
      /does not exist: run provision first/,
    );
  });

  test("config writes the file, remembers a real id, and never remembers a placeholder", (t) => {
    const h = harness(t);
    h.devEnv.config({ d1Id: "00000000-0000-0000-0000-000000000000" });
    assert.deepEqual(h.devEnv.readState(), {});
    assert.ok(existsSync(h.devEnv.paths.devConfig));
    h.devEnv.config({ d1Id: DEV_D1_ID });
    assert.equal(h.devEnv.readState().d1Id, DEV_D1_ID);
    assert.equal(
      parseConfigText(readFileSync(h.devEnv.paths.devConfig, "utf8"))
        .d1_databases[0].database_id,
      DEV_D1_ID,
    );
    assert.equal(h.fake.calls.length, 0, "config is local only");
    assert.throws(
      () => h.devEnv.config({ d1Id: PROD.d1Id }),
      /production D1 id/,
    );
  });
});
