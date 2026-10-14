import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards for the fork's non-negotiables (fork-owned; docs/fork-data-sources.md).
// Each reads source files as text, so it is instant and needs no database.

const repo = (path: string) =>
  fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

/** Source files under the given folders, without tests, builds or dependencies. */
function sourceFiles(...roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(repo(dir))) {
      if (
        ["node_modules", "dist", ".wrangler", "memos-generated"].includes(name)
      )
        continue;
      const path = `${dir}/${name}`;
      if (statSync(repo(path)).isDirectory()) walk(path);
      else if (
        /\.(ts|tsx|mjs|js)$/.test(name) &&
        !/\.test\.|\.spec\./.test(name)
      )
        files.push(path);
    }
  };
  for (const root of roots) walk(root);
  return files;
}

describe("the task history archive only grows", () => {
  // planner_task_event is the permanent data flywheel: kept even after a task is
  // purged. No app or script code may delete or rewrite its rows. The restore
  // replay in scripts/persistence-manifest.mjs empties every table by name in a
  // loop, so it does not match these patterns.
  const FORBIDDEN = [
    /\.delete\(\s*plannerTaskEvent\b/,
    /\.update\(\s*plannerTaskEvent\b/,
    /DELETE\s+FROM\s+[`"]?planner_task_event\b/i,
    /UPDATE\s+[`"]?planner_task_event\b/i,
    /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?[`"]?planner_task_event\b/i,
  ];

  it("has no code that deletes or rewrites an archived event", () => {
    const offenders = sourceFiles("packages", "apps", "scripts").flatMap(
      (file) => {
        const text = readFileSync(repo(file), "utf8");
        return FORBIDDEN.filter((pattern) => pattern.test(text)).map(
          (pattern) => `${file}: ${pattern}`,
        );
      },
    );
    expect(
      offenders,
      "planner_task_event must never lose or change rows (project brief, DATA SAFETY)",
    ).toEqual([]);
  });

  it("is never dropped or emptied by a migration", () => {
    const offenders = readdirSync(repo("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .filter((name) =>
        FORBIDDEN.some((pattern) =>
          pattern.test(readFileSync(repo(`migrations/${name}`), "utf8")),
        ),
      );
    expect(offenders).toEqual([]);
  });
});

describe("applied fork migrations are frozen", () => {
  // G12: a 9NNN file is never edited once it ran on a real database, because
  // Wrangler will not run it again and dev and live would silently differ from
  // the file. The hashes are recorded in fork-migration-hashes.json. A new file
  // is added to it with FORK_MIGRATION_HASHES_WRITE=1; an existing hash is never
  // rewritten by that switch.
  const lockPath = repo("packages/domain/src/fork/fork-migration-hashes.json");

  it("matches the recorded hash of every 9NNN migration", () => {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<
      string,
      string
    >;
    const files = readdirSync(repo("migrations")).filter((name) =>
      /^9\d{3}_.+\.sql$/.test(name),
    );
    const hashes = Object.fromEntries(
      files.map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(repo(`migrations/${name}`)))
          .digest("hex"),
      ]),
    );
    const added = files.filter((name) => !lock[name]);
    if (process.env.FORK_MIGRATION_HASHES_WRITE === "1" && added.length) {
      const next = { ...lock };
      for (const name of added) next[name] = hashes[name] as string;
      writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    expect(
      added,
      "New fork migrations: record them with FORK_MIGRATION_HASHES_WRITE=1 pnpm exec vitest run packages/domain/src/fork/guards.test.ts",
    ).toEqual([]);
    const edited = files.filter((name) => lock[name] !== hashes[name]);
    expect(
      edited,
      "These applied migrations were edited. Revert the edit and put the change in a new 9NNN_planner_ file (G12).",
    ).toEqual([]);
    expect(
      Object.keys(lock).filter((name) => !files.includes(name)),
      "Recorded migrations that are gone: an applied migration must never be deleted",
    ).toEqual([]);
  });
});

describe("upstream files still call the fork's hooks", () => {
  // An upstream sync that drops one of these lines would not break any build:
  // the archive would quietly stop recording tasks purged while the cockpit is
  // closed, or the cockpit's API would stop answering.
  it("archives tasks before and after the nightly trash purge", () => {
    const text = readFileSync(
      repo("apps/worker/src/scheduled-tasks.ts"),
      "utf8",
    );
    const before = text.indexOf("await plannerSyncAllUsers(");
    const projects = text.indexOf("await hardDeleteExpiredProjects(");
    const tasks = text.indexOf("await hardDeleteExpiredTasks(");
    const after = text.indexOf("await plannerSyncAllUsers(", tasks);
    expect(before, "sync before the purge").toBeGreaterThan(-1);
    expect(projects).toBeGreaterThan(before);
    expect(tasks).toBeGreaterThan(projects);
    expect(after, "sync after the purge").toBeGreaterThan(tasks);
  });

  it("mounts the planner API before upstream's catch-all /api/app", () => {
    const text = readFileSync(repo("apps/worker/src/index.ts"), "utf8");
    const planner = text.indexOf('"/api/app/planner"');
    const catchAll = text.indexOf('app.route("/api/app", ');
    expect(planner).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(planner);
  });
});

describe("Claude sessions ask before writing to live", () => {
  // The repo's .claude/settings.json once allowed raw `wrangler deploy` and
  // remote migrations with no prompt, which skipped every safeguard of
  // scripts/fork/prod-deploy.mjs (clean tree, Time Travel bookmark, row counts,
  // automatic rollback). Every route that can write to live must prompt,
  // including the deploy script's own real deploy and rollback; only its
  // dry run and status stay unprompted.
  const settings = JSON.parse(
    readFileSync(repo(".claude/settings.json"), "utf8"),
  ) as { permissions?: { allow?: string[]; ask?: string[] } };
  const LIVE_WRITES = [
    "npx wrangler deploy --config wrangler.jsonc --keep-vars",
    "wrangler deploy --config ../../wrangler.jsonc --keep-vars",
    "npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc",
    "npx wrangler d1 execute flaremo --remote --command 'DELETE FROM memos'",
    "npx wrangler rollback --config wrangler.jsonc",
    "npx wrangler versions deploy --config wrangler.jsonc",
    "npx wrangler versions upload --config wrangler.jsonc",
    "npx wrangler d1 time-travel restore flaremo --bookmark x",
    "node node_modules/wrangler/bin/wrangler.js deploy",
    "npx wrangler2 deploy",
    "npx cf-wrangler deploy",
    "npx wrangler secret put BETTER_AUTH_SECRET",
    "npx wrangler secret delete BETTER_AUTH_SECRET",
    "npx wrangler delete flaremo",
    "npx wrangler d1 delete flaremo",
    "npx wrangler r2 object put flaremo-attachments/x --file y --remote",
    "npx wrangler r2 object delete flaremo-attachments/x --remote",
    "npx wrangler r2 bucket delete flaremo-attachments",
    "npx wrangler queues delete flaremo-data-export",
    "npx wrangler vectorize delete flaremo-memos",
    "npx wrangler vectorize insert flaremo-memos --file x",
    "pnpm migrate:remote",
    "pnpm run deploy",
    "pnpm deploy",
    "pnpm --filter @flaremo/worker deploy",
    "npm run deploy",
    "node scripts/fork/prod-deploy.mjs deploy --confirm flaremo",
    "node scripts/fork/prod-deploy.mjs rollback --confirm flaremo",
    "cf d1 execute flaremo --remote",
    "npx cf workers deploy",
    "pnpm cf d1 execute flaremo",
    "pnpm exec cf d1 execute flaremo",
    "node_modules/.bin/cf d1 execute flaremo",
    "npx cloudflare d1 execute flaremo",
    "curl -X POST https://api.cloudflare.com/client/v4/accounts/x/d1/database/y/query",
  ];
  const MCP_LIVE_WRITES = [
    "d1_database_query",
    "d1_database_delete",
    "r2_bucket_delete",
    "kv_namespace_delete",
    "kv_namespace_update",
    "hyperdrive_config_delete",
    "hyperdrive_config_edit",
  ].map((tool) => `mcp__Cloudflare_Developer_Platform__${tool}`);

  /** A permission rule as Claude Code reads it: `*` matches any text. */
  const matches = (rule: string, command: string) => {
    const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
    if (inner === undefined) return false;
    const pattern = inner
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${pattern}$`).test(command);
  };
  const asks = (command: string) =>
    (settings.permissions?.ask ?? []).some((rule) => matches(rule, command));

  it("allows no live write without a prompt", () => {
    const allow = settings.permissions?.allow ?? [];
    const allowed = LIVE_WRITES.filter((command) =>
      allow.some((rule) => matches(rule, command)),
    );
    expect(allowed).toEqual([]);
    expect(allow.filter((rule) => rule.startsWith("mcp__Cloudflare"))).toEqual(
      [],
    );
  });

  it("asks before every live write", () => {
    expect(LIVE_WRITES.filter((command) => !asks(command))).toEqual([]);
  });

  it("asks before every Cloudflare MCP tool that can write", () => {
    const ask = settings.permissions?.ask ?? [];
    expect(MCP_LIVE_WRITES.filter((tool) => !ask.includes(tool))).toEqual([]);
  });

  it("leaves dry runs, status, dev work and local work unprompted", () => {
    const asked = [
      "node scripts/fork/prod-deploy.mjs deploy --dry-run",
      "node scripts/fork/prod-deploy.mjs status",
      "node scripts/fork/dev-env.mjs deploy",
      "node scripts/fork/dev-env.mjs clone --dry-run",
      "npx wrangler d1 migrations apply DB --local",
      "pnpm exec vitest run packages/domain/src/fork",
      "node --test scripts/fork/prod-deploy.test.mjs",
      "pnpm build",
      "git status",
    ].filter(asks);
    expect(asked).toEqual([]);
  });
});
