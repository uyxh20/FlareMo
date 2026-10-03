# Deploy FlareMo with GitHub Actions

This guide is for **your deployment repository** (a fork or copy of FlareMo). Upstream `realchendahuang/FlareMo` never runs `.github/workflows/deploy-cloudflare.yml`.

There are **two** ways to publish an existing Worker from GitHub. `cloudflare/wrangler-action` has **no** GitHub OIDC ([issue 402](https://github.com/cloudflare/wrangler-action/issues/402)), so the Actions path needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. When those secrets are empty, a push no longer dies in one second with no checkout: the log prints the dashboard step below. A manual `Run workflow` still fails until the secrets exist, so nobody thinks Actions published.

Do not put `BETTER_AUTH_SECRET`, `FLAREMO_BOOTSTRAP_SECRET`, or `RESEND_API_KEY` in the workflow file, issues, PRs, chat, or `workflow_dispatch` inputs. Mail keys stay in the Cloudflare Worker secret store (`wrangler secret put`).

## Preferred: Workers Builds (no long-lived token in GitHub)

The live Worker `flaremo` (for example `https://flaremo.ulysse-ha-19.workers.dev`) can publish on push to `main` after one Cloudflare dashboard connect. Cloudflare injects the API token. GitHub does not store it.

**The one action Ulysse must take:**

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → existing Worker **`flaremo`**.
2. **Settings → Builds → Connect**, authorize GitHub, select **`uyxh20/FlareMo`**.
3. Production branch: `main`.
4. Build command: `pnpm install --frozen-lockfile`.
5. Deploy command: `pnpm deploy:ci` (writes `wrangler.jsonc`, reuses D1 `flaremo` by name, builds the web app, applies remote migrations, `wrangler deploy --config ./wrangler.jsonc --keep-vars`).
6. Leave non-production as `wrangler versions upload`. Do **not** point preview branches at `pnpm deploy:ci` (that applies production D1 migrations).

Before connecting, confirm Worker → Settings → Bindings that D1 is named `flaremo` (the default). `pnpm deploy:ci` reuses that name; a different name would create an empty database. `--keep-vars` keeps Worker vars such as `FLAREMO_EMAIL_PROVIDER` / `FLAREMO_EMAIL_FROM`. Leave `RESEND_API_KEY` as a Worker secret; do not add it to GitHub or Builds environment variables.

Do not run plain `npx wrangler deploy` against the committed `wrangler.json`: its D1 `database_id` is a placeholder.

## Prerequisites

- The deployment repository includes `.github/workflows/deploy-cloudflare.yml`.
- The Cloudflare account has Workers enabled and an account-level `*.workers.dev` subdomain.
- Two distinct random secrets of at least 32 characters, stored in a password manager first:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use them as `BETTER_AUTH_SECRET` (session signing) and `FLAREMO_BOOTSTRAP_SECRET` (one-time `/setup` passphrase). GitHub cannot show a saved Secret again.

## 1. Optional: create a Cloudflare API token (Actions path only)

Open [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token. Start from **Edit Cloudflare Workers** and add:

- Account → D1 → Edit
- Account → Workers R2 Storage → Edit
- Account → Queues → Edit
- Account → Vectorize → Edit
- Account → Workers Scripts → Edit (usually included)

The Account ID is on the right side of the Cloudflare dashboard home page.

## 2. Enable Actions on the repository

In the deployment repository, open `Settings` → `Actions` → `General`:

- Allow GitHub Actions.
- If you also use the [update flow](./update.md) to open upgrade PRs: grant read/write workflow permissions and allow Actions to create pull requests. Deploy-only runs only need contents read.

## 3. Configure GitHub Secrets

Open `Settings` → `Secrets and variables` → `Actions` and add:

| Name | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Only for Actions publish | Token from step 1. Skip when using Workers Builds |
| `CLOUDFLARE_ACCOUNT_ID` | Only for Actions publish | Cloudflare account ID. Skip when using Workers Builds |
| `BETTER_AUTH_SECRET` | Yes if you need login | ≥32 characters; synced to the Worker secret store |
| `FLAREMO_BOOTSTRAP_SECRET` | Yes if you need `/setup` | ≥32 characters, different from the previous value |

Optional repository **Variables** (not secrets):

| Name | Purpose |
| --- | --- |
| `FLAREMO_PUBLIC_URL` | Custom-domain origin; if empty, `https://flaremo.<account workers.dev subdomain>.workers.dev` |
| `FLAREMO_EMAIL_PROVIDER` | Self-service reset: set to `resend` |
| `FLAREMO_EMAIL_FROM` | Verified sender address |

Do **not** store `RESEND_API_KEY` as a GitHub Actions secret. Set it only as a Worker secret:

```bash
pnpm exec wrangler secret put RESEND_API_KEY --config ./wrangler.jsonc
```

Do not set:

- `FLAREMO_D1_DATABASE_ID`: the workflow creates or reuses D1 `flaremo` by name.
- `WRANGLER_JSONC`: only if you already have a full `wrangler.jsonc` that cannot be generated from the example.

For a custom domain, bind it to the Worker in Cloudflare, set repository **Variable** `FLAREMO_PUBLIC_URL` to that origin (for example `https://notes.example.com`, no path), then run the workflow again.

## 4. Run Deploy to Cloudflare

A push to `main` runs a production publish (`dry_run` off, `provision` on). You can also open `Actions` → `Deploy to Cloudflare` → `Run workflow`:

1. On the first attempt, enable `dry_run`: build, Wrangler dry-run, and a **read-only check** of the D1 / R2 / Queue / Vectorize resources plus API token permissions. Nothing is created; remote D1 migration, publish, and secret sync are skipped. Missing resources or insufficient token permissions are reported right here.
2. Leave `provision` enabled: create missing D1, R2, Queue, and Vectorize resources. Existing names are skipped.
3. After dry-run succeeds, run again **without** `dry_run`, with `provision` still enabled.

A production run will:

1. Generate a job-local `wrangler.jsonc` from `wrangler.jsonc.example` (not committed), including Variables `FLAREMO_EMAIL_PROVIDER` / `FLAREMO_EMAIL_FROM` when set.
2. Create or reuse D1 `flaremo`, R2 `flaremo-attachments`, queues `flaremo-member-removal` and `flaremo-data-export`, and Vectorize indexes `flaremo-memos` and `flaremo-memories` (1024 dimensions, cosine).
3. If `FLAREMO_PUBLIC_URL` is unset, write `https://flaremo.<subdomain>.workers.dev`.
4. Build the web app; `cloudflare/wrangler-action` applies remote D1 migrations and runs `wrangler deploy`.
5. Copy GitHub Secrets `BETTER_AUTH_SECRET` and `FLAREMO_BOOTSTRAP_SECRET` onto the Worker. Logs show `***`. **`RESEND_API_KEY` is not synced.**
6. Smoke check: request `FLAREMO_PUBLIC_URL` to confirm the Worker serves traffic, retrying for about a minute; a site that stays unreachable marks the run red.

If those two GitHub Secrets are missing, the sync step skips and deploy still finishes; `/setup` and login will fail until you add the Secrets and run again without `dry_run`, or add them in Cloudflare Dashboard → Worker → Settings → Variables and Secrets.

## 5. Open /setup

The deploy log or Cloudflare Dashboard → Worker `flaremo` shows an origin such as:

```text
https://flaremo.<subdomain>.workers.dev
```

Open `https://<that origin>/setup` and enter:

- Setup secret: the `FLAREMO_BOOTSTRAP_SECRET` value
- Username, display name, email, and an initial password (8–128 characters)

Success redirects to `/login` and public signup closes. Do not paste secrets or passwords into issues, PRs, logs, or chat.

After Resend is configured, smoke-test (do not paste secrets or mail bodies into issues):

1. Submit a registered address on `/forgot-password`.
2. The email arrives; the link is this origin's `/reset?token=…`.
3. Set a new password.
4. Sign in with the new password. Self-service reset revokes cookie sessions and does not revoke existing `memos_pat_` tokens.

## 6. Later updates

| Situation | What to do |
| --- | --- |
| You changed application code | Push to `main`; the workflow publishes. Existing resource names are skipped. `Run workflow` still works. |
| Upstream published a stable release | Follow the [update guide](./update.md) to run `Prepare FlareMo update`, review and merge the PR. This workflow publishes after the merge lands on `main`. |
| Rotate auth secrets | Change the GitHub Secrets and run a production deploy (overwrites the Worker secrets). |
| Switch to a custom domain | Bind the domain in Cloudflare, set Variable `FLAREMO_PUBLIC_URL`, deploy again. |
| Enable forgot-password email | Set Variables `FLAREMO_EMAIL_PROVIDER=resend` and `FLAREMO_EMAIL_FROM`, then `wrangler secret put RESEND_API_KEY` on the Worker, then deploy. |

`Prepare FlareMo update` only opens an upgrade PR and does not hold Cloudflare credentials. Publishing is Workers Builds (`pnpm deploy:ci`), this workflow (push / `Run workflow` once the two secrets exist), or local `pnpm deploy`.

## 7. Not required on first install

These cannot be set in the FlareMo UI. Add them in Cloudflare when you need the feature:

| Item | When |
| --- | --- |
| `RESEND_API_KEY` | Forgot-password / verification mail; **only** `wrangler secret put`, never a GitHub Actions secret |
| `FLAREMO_RECOVERY_SECRET` | Break-glass owner password reset without email; delete or rotate after use. Skip this when Resend is configured |
| `FLAREMO_ASR_DASHSCOPE_API_KEY` | Default DashScope voice capture |
| Tencent ASR secret ID / key | When `FLAREMO_ASR_PROVIDER` is `tencent` |
| VAPID public/private keys | Web Push; these are vars, not secrets, and need a redeploy |
| Telegram / Cloudflare Access secrets | When those integrations are enabled |

## 8. Troubleshooting

- No `Deploy to Cloudflare` workflow: you are on the wrong repository, or the file is not on the default branch.
- workers.dev subdomain lookup fails: register the account subdomain under Workers in the Cloudflare dashboard.
- `/setup` fails: the two auth GitHub Secrets are missing or invalid, or the last run was `dry_run` only.
- Queue / Vectorize / D1 create fails: the API token is missing permissions from step 1.
- `provision` still checked on later deploys: existing names are skipped; that is expected.

The local equivalents (with Wrangler logged in) are `pnpm provision:remote`, `pnpm deploy`, and `pnpm secrets:sync`. The full CLI path is in the [deployment guide](./deploy.md).
