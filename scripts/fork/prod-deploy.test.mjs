import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { PROD } from "./dev-env-guard.mjs";
import {
  assertProdConfig,
  bindingDrift,
  buildProdConfig,
  compareCounts,
  deploy,
  pendingMigrations,
  previousDeployment,
  redact,
  rollback,
  strayMigrations,
} from "./prod-deploy.mjs";

const example = readFileSync(
  new URL("../../wrangler.jsonc.example", import.meta.url),
  "utf8",
);

describe("prod-deploy", () => {
  test("builds a config that passes the production check", () => {
    const config = buildProdConfig(example, {
      FLAREMO_PUBLIC_URL: PROD.publicUrl,
    });
    assert.doesNotThrow(() => assertProdConfig(config));
  });

  test("refuses a config that does not point at production", () => {
    const config = buildProdConfig(example, {
      FLAREMO_PUBLIC_URL: "https://x.dev",
    });
    assert.throws(() => assertProdConfig(config), /FLAREMO_PUBLIC_URL/);
    config.name = "flaremo-dev";
    assert.throws(() => assertProdConfig(config), /worker name/);
  });

  test("lists pending migrations in order", () => {
    assert.deepEqual(
      pendingMigrations(["b.sql", "a.sql", "c.sql"], ["a.sql"]),
      ["b.sql", "c.sql"],
    );
  });

  test("row count drops are fatal except for ephemeral tables", () => {
    const { fatal, notes } = compareCounts(
      { memo: 10, auth_sessions: 5, planner_task_event: 3 },
      { memo: 9, auth_sessions: 2, planner_task_event: 4, extra: 1 },
    );
    assert.equal(fatal.length, 1);
    assert.match(fatal[0], /memo: 10 -> 9/);
    assert.equal(notes.length, 2);
    assert.equal(compareCounts({ a: 1 }, {}).fatal.length, 1);
  });

  test("redacts var values from wrangler output", () => {
    assert.equal(redact("key=abcd1234 ok", ["abcd1234", "ab"]), "key=*** ok");
  });

  test("finds migration files that are not committed", () => {
    assert.deepEqual(
      strayMigrations(
        ["0001_a.sql", "9011_x.sql", "0002_b.sql"],
        ["migrations/0001_a.sql", "migrations/0002_b.sql"],
      ),
      ["9011_x.sql"],
    );
  });

  test("tokens are guarded; sessions and job queues are not", () => {
    const { fatal, notes } = compareCounts(
      { personal_access_tokens: 2, auth_sessions: 3, member_removal_jobs: 1 },
      { personal_access_tokens: 0, auth_sessions: 1, member_removal_jobs: 0 },
    );
    assert.deepEqual(fatal, ["personal_access_tokens: 2 -> 0"]);
    assert.equal(notes.length, 2);
  });

  test("flags live bindings a deploy would remove, and vars it would restore", () => {
    const config = buildProdConfig(example, {
      FLAREMO_PUBLIC_URL: PROD.publicUrl,
    });
    const live = [
      { name: "DB", type: "d1" },
      { name: "AI", type: "ai" },
      { name: "RATE_LIMITER", type: "ratelimit" },
      { name: "MEMBER_REMOVAL_QUEUE", type: "queue" },
      { name: "EXTRA_KV", type: "kv_namespace" },
      { name: "BETTER_AUTH_SECRET", type: "secret_text" },
      { name: "FLAREMO_PUBLIC_URL", type: "plain_text" },
    ];
    const drift = bindingDrift(live, config);
    assert.deepEqual(drift.unknown, ["EXTRA_KV (kv_namespace)"]);
    assert.ok(drift.restored.includes("FLAREMO_SINGLE_USER_EMAIL"));
    assert.ok(!drift.restored.includes("FLAREMO_PUBLIC_URL"));
  });

  test("manual rollback skips the live version and versions that failed", () => {
    const at = (day, id, message) => ({
      created_on: `2026-10-${day}T10:00:00Z`,
      versions: [{ version_id: id, percentage: 100 }],
      ...(message ? { annotations: { "workers/message": message } } : {}),
    });
    const deployments = [
      at(10, "v9"),
      at(11, "v10"),
      at(11, "v9", "prod-deploy: rolled back from v10"),
      at(12, "v11"),
    ];
    // v10 failed its checks, so the previous healthy one is v9.
    assert.equal(previousDeployment(deployments, "v11").versionId, "v9");
    assert.equal(previousDeployment([at(10, "v9")], "v9"), null);
    const split = {
      created_on: "2026-10-13T10:00:00Z",
      versions: [
        { version_id: "v12", percentage: 50 },
        { version_id: "v11", percentage: 50 },
      ],
    };
    assert.equal(
      previousDeployment([...deployments, split], "v11").versionId,
      "v9",
    );
  });
});

// ---------------------------------------------------------------------------
// The deploy flow against a fake Cloudflare account
// ---------------------------------------------------------------------------

function fakeLive({
  local = ["0001_a.sql", "0002_b.sql"],
  tracked = local,
  applied = ["0001_a.sql"],
  counts = { memos: 10, planner_task_event: 5 },
} = {}) {
  const state = {
    versions: [{ id: "v1", number: 1 }],
    deployments: [
      {
        created_on: "2026-10-01T00:00:00Z",
        versions: [{ version_id: "v1", percentage: 100 }],
      },
    ],
    applied: [...applied],
    counts: { ...counts },
    rootConfig: "LOCAL DEV CONFIG",
    faults: {},
    events: [],
    out: [],
    fetchStatus: { "/": 200, "/openapi.json": 200, "/feed.xml": 200 },
  };
  const live = () => state.deployments.at(-1).versions[0].version_id;
  const fail = (key) => {
    if (state.faults[key]) throw new Error(state.faults[key]);
  };
  const io = {
    async cf(path, { method = "GET", body } = {}) {
      if (path.endsWith("/settings")) {
        return {
          bindings: [
            {
              name: "FLAREMO_PUBLIC_URL",
              type: "plain_text",
              text: PROD.publicUrl,
            },
            ...(state.extraBinding ? [state.extraBinding] : []),
          ],
        };
      }
      if (path.endsWith("/versions")) return { items: state.versions };
      if (path.endsWith("/deployments") && method === "GET") {
        return { deployments: [...state.deployments].reverse() };
      }
      if (path.endsWith("/deployments") && method === "POST") {
        fail("rollback");
        state.events.push(`rollback ${body.versions[0].version_id}`);
        state.deployments.push({
          created_on: `2026-10-0${state.deployments.length + 1}T00:00:00Z`,
          versions: body.versions,
          annotations: body.annotations,
        });
        return {};
      }
      if (path.endsWith("/time_travel/bookmark")) return { bookmark: "bm-1" };
      if (path.endsWith("/query")) {
        const sql = body.sql;
        if (sql.startsWith("SELECT name, sql FROM sqlite_master")) {
          state.events.push("count");
          return [
            {
              results: Object.keys(state.counts).map((name) => ({
                name,
                sql: "",
              })),
            },
          ];
        }
        if (sql.includes("d1_migrations")) {
          return [{ results: state.applied.map((name) => ({ name })) }];
        }
        const table = /FROM "(.+)"/.exec(sql)[1];
        return [{ results: [{ n: state.counts[table] }] }];
      }
      throw new Error(`unexpected Cloudflare call ${method} ${path}`);
    },
    run(command, args) {
      if (command === "git") {
        if (args[0] === "ls-tree") {
          return tracked.map((f) => `migrations/${f}`).join("\n");
        }
        if (args[0] === "rev-parse") return "abc123";
        return "";
      }
      fail("build");
      state.events.push("build web");
      return "";
    },
    wrangler(args) {
      if (args[0] === "deploy" && args.includes("--dry-run")) {
        fail("bundle");
        state.events.push("bundle");
      } else if (args[0] === "d1") {
        state.events.push("migrate");
        state.applied = [...local];
        if (state.migrationDropsRows) state.counts.memos -= 1;
      } else if (args[0] === "deploy") {
        fail("deploy");
        const next = state.versions.length + 1;
        state.versions.unshift({ id: `v${next}`, number: next });
        state.deployments.push({
          created_on: `2026-10-0${state.deployments.length + 1}T00:00:00Z`,
          versions: [{ version_id: `v${next}`, percentage: 100 }],
        });
        state.events.push("deploy");
      }
      return "";
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      return { status: state.fetchStatus[path] };
    },
    sleep: async () => {},
    say: (line = "") => state.out.push(line),
    localMigrations: () => [...local],
    readExample: () => example,
    readRootConfig: () => state.rootConfig,
    writeRootConfig: (text) => {
      state.rootConfig = text;
    },
    removeRootConfig: () => {
      state.rootConfig = null;
    },
    makeTempDir: () => "/tmp/bundle",
    removeDir: () => {},
  };
  return { io, state, live };
}

describe("prod-deploy flow", () => {
  test("builds everything before the first write, counts last, then deploys", async () => {
    const { io, state, live } = fakeLive();
    assert.equal(await deploy(io, { dryRun: false }), true);
    assert.deepEqual(state.events, [
      "build web",
      "bundle",
      "count",
      "migrate",
      "count",
      "deploy",
      "count",
    ]);
    assert.equal(live(), "v2");
    assert.equal(state.rootConfig, "LOCAL DEV CONFIG", "root config put back");
  });

  test("a dry run builds and counts but never migrates or deploys", async () => {
    const { io, state, live } = fakeLive();
    assert.equal(await deploy(io, { dryRun: true }), true);
    assert.deepEqual(state.events, ["build web", "bundle", "count"]);
    assert.equal(live(), "v1");
  });

  test("a stray migration file stops the deploy before anything else", async () => {
    const { io, state } = fakeLive({
      local: ["0001_a.sql", "9011_x.sql"],
      tracked: ["0001_a.sql"],
    });
    await assert.rejects(deploy(io, { dryRun: true }), /9011_x\.sql/);
    assert.deepEqual(state.events, []);
  });

  test("a bundle error stops the deploy before the migrations", async () => {
    const { io, state, live } = fakeLive();
    state.faults.bundle = "esbuild failed";
    await assert.rejects(deploy(io, { dryRun: false }), /esbuild failed/);
    assert.ok(!state.events.includes("migrate"));
    assert.equal(live(), "v1");
    assert.equal(state.rootConfig, "LOCAL DEV CONFIG");
  });

  test("a migration that drops rows stops before the Worker deploy", async () => {
    const { io, state, live } = fakeLive();
    state.migrationDropsRows = true;
    assert.equal(await deploy(io, { dryRun: false }), false);
    assert.ok(!state.events.includes("deploy"));
    assert.equal(live(), "v1");
    const out = state.out.join("\n");
    assert.match(out, /Worker was not changed/);
    assert.match(out, /schema is NOT rolled back/);
    assert.match(out, /bm-1/);
  });

  test("a site check that fails rolls the Worker back and labels the bad version", async () => {
    const { io, state, live } = fakeLive();
    state.fetchStatus["/feed.xml"] = 500;
    assert.equal(await deploy(io, { dryRun: false }), false);
    assert.equal(live(), "v1");
    assert.equal(
      state.deployments.at(-1).annotations["workers/message"],
      "prod-deploy: rolled back from v2",
    );
    assert.match(state.out.join("\n"), /\/feed\.xml answered 500/);
  });

  test("a failed rollback says live is on the new version and how to fix it", async () => {
    const { io, state, live } = fakeLive();
    state.fetchStatus["/"] = 503;
    state.faults.rollback = "network down";
    assert.equal(await deploy(io, { dryRun: false }), false);
    assert.equal(live(), "v2");
    const out = state.out.join("\n");
    assert.match(out, /ROLLBACK FAILED: network down/);
    assert.match(out, /NEW, unchecked version #2 \(v2\)/);
    assert.match(out, /rollback --confirm flaremo --version v1/);
    assert.match(out, /bm-1/);
  });

  test("an unknown live binding stops the deploy, and a leftover prod config is removed", async () => {
    const { io, state } = fakeLive();
    state.rootConfig = `{"d1_databases":[{"database_id":"${PROD.d1Id}"}]}`;
    state.extraBinding = { name: "EXTRA_KV", type: "kv_namespace" };
    await assert.rejects(deploy(io, { dryRun: true }), /EXTRA_KV/);
    assert.deepEqual(state.events, []);
    assert.equal(state.rootConfig, null);
  });

  test("manual rollback after a failed deploy skips the failed version", async () => {
    const { io, state, live } = fakeLive();
    state.fetchStatus["/feed.xml"] = 500;
    await deploy(io, { dryRun: false }); // v2 fails, back to v1
    state.fetchStatus["/feed.xml"] = 200;
    await deploy(io, { dryRun: false }); // v3 is fine
    assert.equal(live(), "v3");
    await rollback(io);
    assert.equal(live(), "v1");
    await assert.rejects(rollback(io, { version: "v1" }), /already live/);
    await rollback(io, { version: "v3" });
    assert.equal(live(), "v3");
  });
});
