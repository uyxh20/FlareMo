# Fork dev environment

A separate `flaremo-dev` deployment on the same Cloudflare account. It holds a
copy of the live data, so a new commit (an upstream upgrade, the planner
add-on) is tested on real rows before it goes live. Fork-only tooling:
`scripts/fork/dev-env.mjs`.

| | Live | Dev |
| --- | --- | --- |
| Worker | `flaremo` | `flaremo-dev` |
| D1 | `flaremo` | `flaremo-dev` |
| R2 | `flaremo-attachments` | `flaremo-dev-attachments` |
| Queues | `flaremo-member-removal`, `flaremo-data-export` | `flaremo-dev-member-removal`, `flaremo-dev-data-export` |
| Vectorize (1024 dims, cosine) | `flaremo-memos`, `flaremo-memories` | `flaremo-dev-memos`, `flaremo-dev-memories` |
| Rate-limit namespace | `1001` | `2001` |
| URL | `https://flaremo.ulysse-ha-19.workers.dev` | `https://flaremo-dev.ulysse-ha-19.workers.dev` |

## Safety

- Production is never written. Every wrangler call goes through
  `assertSafeWranglerCall` (`scripts/fork/dev-env-guard.mjs`). Reads of
  production are allowed (`SELECT`, `PRAGMA table_info`, `d1 list`, `r2 object
  get`, `secret list`, `deploy --dry-run`). Everything else must name only
  `flaremo-dev*` resources, with a dev-only `--config`; unknown commands, flags
  and config keys are refused.
- The dev config is generated from `wrangler.jsonc.example` into
  `.wrangler/fork-dev/` (gitignored). Email and push vars stay empty and
  `RESEND_API_KEY` is never set, so dev cannot send real email or push.
- Secrets are random, go to wrangler's stdin only, and are never printed or
  written. Dev gets `BETTER_AUTH_SECRET` (required to start) and
  `FLAREMO_BOOTSTRAP_SECRET` (the one-time bootstrap gate), both read in
  `apps/worker/src/auth-env.ts`, and nothing else.
- The data export holds credential hashes (password, PATs). It is written
  owner-only under `backups/` and deleted after a successful clone unless you
  pass `--keep-dump`.

## Auth

Wrangler reads `CLOUDFLARE_API_TOKEN`. The script passes `CLOUDFLARE_API_TOKEN`,
else the owner's `CLOUDFLARE_API`, else the placeholder `proxy-injected`. In the
sandbox a network proxy replaces the placeholder header for `api.cloudflare.com`
with the real token, so no token needs to exist in the container. Set
`CLOUDFLARE_ACCOUNT_ID` too. The token needs D1, R2, Queues, Vectorize and
Workers Scripts edit rights. Nothing prints the environment.

## Commands

```bash
node scripts/fork/dev-env.mjs config      # local: write the dev wrangler config
node scripts/fork/dev-env.mjs provision   # create dev resources and secrets
node scripts/fork/dev-env.mjs clone       # copy live data, rehearse migrations
node scripts/fork/dev-env.mjs deploy      # build, migrate, deploy the dev Worker
node scripts/fork/dev-env.mjs status      # what exists, the dev D1 level (--with-prod adds live's)
```

First time: `provision`, `clone --dry-run` (a read-only plan), `clone`,
`deploy`. Test a new commit: `deploy`. Refresh the data: `clone --reset
--confirm flaremo-dev`, then `deploy`. `deploy --dry-run` builds and stops at
wrangler's dry run without touching Cloudflare.

## What `clone` does

1. Reads live's applied migrations (`SELECT` only) and brings the dev D1 to
   exactly that level, through a temporary migrations directory.
2. Refuses if dev is already past live. `--reset --confirm flaremo-dev` deletes
   and recreates the dev D1 (new id, so run `deploy` afterwards). Live is never
   touched.
3. Exports each table in the persistence manifest (never FTS tables), as one D1
   batch when the data is small, and imports it children-first.
4. Applies the remaining migrations (0030 and later): the upgrade rehearsal,
   with wrangler's output printed.
5. Rebuilds the derived state (`POST_RESTORE_DERIVED_SQL`) after the migrations,
   not before: it touches `memo_hourly_counts`, which only exists from 0033.
6. Copies ready attachment objects to the dev bucket (live has none today).
7. Compares row counts, live against dev, and fails on any mismatch.

Not copied: `auth_sessions` and `auth_verifications`, plus the outbound
integration tables (`memos_webhooks`, `memos_webhook_events`,
`memos_webhook_deliveries`, `push_subscriptions`, `integration_config`,
`voice_service_config`), so dev cannot call live webhooks or reuse encrypted
third-party credentials. `--include-side-effect-tables` copies them.

## Good to know

- Sign in to dev with your live credentials. The password hash and the PATs are
  copied, so the same PATs work against the dev URL.
- The dev URL is public, like live's, and sits behind no Cloudflare Access
  policy unless you add one for its hostname.
- The daily cron (`17 3 * * *`) runs on dev too, including embedding work on
  Workers AI for the fresh Vectorize indexes.
- The import briefly makes the dev D1 unavailable (wrangler warns about it).
- If a clone fails after the import, run `clone` again: the import clears the
  tables first. A dev already upgraded needs `--reset`.
- Tests: `node --test scripts/fork/dev-env.test.mjs`. They run the real
  migrations against an in-memory fake of Cloudflare and need Node 22.5+
  (`node:sqlite`); without it the end-to-end part is skipped.
