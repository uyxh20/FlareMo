import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { PROD } from "./dev-env-guard.mjs";
import {
  assertProdConfig,
  buildProdConfig,
  compareCounts,
  pendingMigrations,
  redact,
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
      { memo: 10, session: 5, planner_task_event: 3 },
      { memo: 9, session: 2, planner_task_event: 4, extra: 1 },
    );
    assert.equal(fatal.length, 1);
    assert.match(fatal[0], /memo: 10 -> 9/);
    assert.equal(notes.length, 2);
    assert.equal(compareCounts({ a: 1 }, {}).fatal.length, 1);
  });

  test("redacts var values from wrangler output", () => {
    assert.equal(redact("key=abcd1234 ok", ["abcd1234", "ab"]), "key=*** ok");
  });
});
