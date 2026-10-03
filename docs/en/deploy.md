# Deploy FlareMo

FlareMo deploys to Cloudflare Workers. The same Worker serves the web UI and API. D1 stores canonical data, and R2 stores attachments and export bundles.

## One-click deploy (community-supported)

The repository tracks a button-ready `wrangler.json` for [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/realchendahuang/FlareMo) (the D1 `database_id` is a placeholder; Cloudflare provisions the resources and rewrites the IDs during deployment). The button flow clones the repository into your GitHub account and connects Workers Builds.

Known issues and notes:

- A first attempt can fail with "Github API Limit Exceeded"; this is transient rate limiting on Cloudflare's clone step — wait a few minutes and retry.
- After the initial deploy, point the Worker's `FLAREMO_PUBLIC_URL` variable at your real origin (a workers.dev subdomain or a custom domain), add `BETTER_AUTH_SECRET` (and optionally `FLAREMO_BOOTSTRAP_SECRET`) with `wrangler secret put`, then deploy once more so the new settings take effect.
- The Vectorize index used by semantic search is provisioned by the button flow together with R2, D1, and Queues.

Manual deployment remains the fully supported path; the button flow is best for quick trials.

## GitHub Action deploy (self-hosted fork)

A fork or deployment repository can publish an existing Worker from GitHub. **Prefer** connecting the live Worker `flaremo` under Dashboard → Settings → Builds to this repository and setting the production deploy command to `pnpm deploy:ci` (no API token in GitHub secrets; `wrangler-action` has no OIDC). You can instead set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for `.github/workflows/deploy-cloudflare.yml` and publish with `cloudflare/wrangler-action` on push to `main` or `Run workflow`. Upstream `realchendahuang/FlareMo` never runs that job. Mail credentials (`RESEND_API_KEY`) stay in the Worker secret store; do not add them as GitHub Actions secrets.

Full steps: [Deploy with GitHub Actions](./github-action-deploy.md).

## Manual Deployment

The repository does not track `wrangler.jsonc` (manual deployers keep their config as a local file), and there is no CI or automatic deployer. Create the resources, copy the config template, fill in your own values, then run the deploy commands.

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc
pnpm provision:remote
```

`pnpm provision:remote` creates the missing D1, R2, Queue, and Vectorize resources and writes the D1 `database_id` back into `wrangler.jsonc`. It is idempotent — existing resources are skipped.

The manual equivalent is:

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler d1 create flaremo
pnpm exec wrangler r2 bucket create flaremo-attachments
```

When you create the resources manually, write the generated D1 `database_id` into `wrangler.jsonc` and set `FLAREMO_PUBLIC_URL` to your public origin. The bucket, queue, and Vectorize index names can stay as the suggested defaults.

Then run:

```bash
pnpm verify
pnpm deploy:dry-run
pnpm deploy
```

`pnpm deploy` builds the web app, applies pending remote D1 migrations, and publishes the Worker.

## Better Auth and optional Cloudflare Access

FlareMo's application authentication is provided by Better Auth. The first deployment uses the one-time `/setup` flow to create the single owner; browsers use an `HttpOnly` cookie session, while scripts, MCP, and Memos-compatible clients use a revocable `memos_pat_` PAT. Cloudflare Access is optional outer policy and never replaces the application session or PAT.

The current release supports username/password login, authenticated password changes, and self-service forgot-password when transactional email is configured. Set `FLAREMO_EMAIL_PROVIDER=resend`, `FLAREMO_EMAIL_FROM`, and Worker secret `RESEND_API_KEY` (see below). Without a provider, forgot-password stays disabled rather than pretending to work. A completed single-user instance may still use a separately configured break-glass operator recovery route; it targets the existing owner, revokes sessions and PATs, and must be rotated or removed immediately after use. Prefer Resend when you need user-facing password recovery.

The current `/api/v1` wire is the current Memos-style camelCase/protobuf-JSON subset. The legacy snake_case wire is selected explicitly with `X-FlareMo-Wire: legacy`. Better Auth remains the identity source while the current auth facade returns a Memos-style HS256 access JWT and rotates the `memos_refresh` HttpOnly cookie. The release also exposes the bounded social REST subset, UserService webhook/notification resource subset, a bounded D1 outbox for four memo webhook events with retries, Connect JSON/protobuf/gRPC-Web unary subset, heartbeat SSE, and stateless `/mcp` Streamable HTTP subset; complete upstream webhook event/egress semantics, full notification filtering and multi-user ACL, complete Memos Server, protobuf/gRPC, and third-party-client parity are not promised.

### Transactional email (Resend) and forgot-password

The app flow is request reset on `/forgot-password` → email link to `/reset?token=…` → set a new password → sign in. The UI posts to `POST /api/auth/flaremo/forgot-password` (same success body for unknown addresses). The same `sendPasswordResetEmail` function is Better Auth's `emailAndPassword.sendResetPassword` hook, so native `POST /api/auth/forget-password` also sends mail.

Worker **vars** (not secrets; `wrangler.jsonc` or GitHub Actions **Variables** that the deploy workflow writes into config):

| Name | Purpose |
| --- | --- |
| `FLAREMO_EMAIL_PROVIDER` | `resend` enables Resend. `cloudflare` uses the Workers Paid `EMAIL` binding. Empty or `none` disables mail. |
| `FLAREMO_EMAIL_FROM` | Verified sender, for example `FlareMo <no-reply@example.com>`. |

Worker **secret** (not git, not the workflow file, not GitHub Actions secrets):

```bash
pnpm exec wrangler secret put RESEND_API_KEY --config ./wrangler.jsonc
```

A fully configured environment wins over owner-saved D1 email settings. Keep `RESEND_API_KEY` in the Worker secret store; the GitHub Action does not sync it.

Smoke-test:

1. Open `/forgot-password` and submit a registered address (unknown addresses show the same success copy).
2. The reset email arrives; the link is this origin's `/reset?token=…` (about one hour).
3. Set a new password (8–128 characters) on the reset page.
4. Sign in on `/login` with the new password; the old password fails.

Credential behavior after a successful self-service reset (unchanged policy):

- **Cookie sessions**: Better Auth `revokeSessionsOnPasswordReset` immediately invalidates every browser session for that identity.
- **`memos_pat_` PATs**: self-service reset does **not** revoke PATs. Scripts, MCP, and Memos clients keep working until the account page or operator recovery revokes them.
- **Operator recovery** (`FLAREMO_RECOVERY_SECRET` / `/recover`): still revokes sessions **and** every PAT. Do not use that path when Resend is configured.

Recommended boundary:

- Human access: `Allow` identity policy.
- Scripts, MCP, and Memos-compatible clients: FlareMo `memos_pat_` application token; if Access remains enabled, add a `Service Auth` policy plus Access Service Token.
- Public shares and static assets: narrowly scoped `Bypass` policies.

### 1. Create an Access application

In the Cloudflare Dashboard, go to `Zero Trust` -> `Access` -> `Applications` -> `Add an application`, then choose `Self-hosted`.

Recommended values:

| Field | Value |
| --- | --- |
| Application name | `FlareMo` |
| Application domain | Your production hostname, for example `notes.example.com` |
| Session duration | `24h` or `1 week` for a personal instance |

If you are starting with a `workers.dev` or Worker Preview URL, enable Cloudflare Access from the Worker `Settings` -> `Domains & Routes` page, then manage the Access policies. For long-term use, prefer a custom hostname and protect that hostname.

### 2. Configure the human access policy

Add an `Allow` policy for the root application. Include only yourself or the people who should use this FlareMo instance.

Recommended values:

| Item | Value |
| --- | --- |
| Policy action | `Allow` |
| Include | Your email, email domain, GitHub/Google/SSO group, or selected One-time PIN email |
| Exclude | Usually empty; do not use `Everyone` for the root application |

This policy protects the browser UI. Authenticated users receive a Cloudflare Access session cookie.

### 3. Create a Service Token

Scripts, MCP, and Memos-compatible clients usually cannot complete a browser login flow. Use a FlareMo `memos_pat_` application token for the Worker; if the deployment is behind Access, add an Access Service Token for the outer policy.

In the Cloudflare Dashboard, go to `Zero Trust` -> `Access` -> `Service Auth` -> `Service Tokens`, then create a token such as:

```text
FlareMo API clients
```

Save the `Client ID` and `Client Secret` shown at creation time. The secret is only displayed once. Store it in a password manager or environment variables; never commit it.

Local environment example:

```bash
export FLAREMO_ACCESS_CLIENT_ID="<client-id>"
export FLAREMO_ACCESS_CLIENT_SECRET="<client-secret>"
```

### 4. Configure the machine access policy

Return to the FlareMo Access application and add a policy:

| Item | Value |
| --- | --- |
| Policy action | `Service Auth` |
| Include | The Service Token you created |
| Require | Optional; add IP/Country constraints if clients come from fixed networks |

Machine clients authenticate with Cloudflare Access headers plus the FlareMo application PAT:

```bash
curl "$FLAREMO_URL/api/v1/memos" \
  -H "CF-Access-Client-Id: $FLAREMO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FLAREMO_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $FLAREMO_MEMOS_PAT"
```

MCP example:

```bash
curl "$FLAREMO_URL/api/v1/mcp" \
  -H "content-type: application/json" \
  -H "CF-Access-Client-Id: $FLAREMO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FLAREMO_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $FLAREMO_MEMOS_PAT" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The current Memos-style stateless MCP surface is at `/mcp` and supports `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`:

```bash
curl "$FLAREMO_URL/mcp" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "CF-Access-Client-Id: $FLAREMO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FLAREMO_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $FLAREMO_MEMOS_PAT" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'
```

Do not turn the Service Token into a FlareMo app token. FlareMo application code does not read, issue, or store these credentials.

### 5. Configure public share bypass

Public shares need unauthenticated access to the share page and shared attachments. Cloudflare Access path policies let more specific paths override the root application policy, so add explicit `Bypass` policies for:

- `/share/*`
- `/api/public/shares/*`
- `/file/*` (for public attachment URLs carrying a valid `share_token`; private requests remain protected by FlareMo)
- `/assets/*`

Recommended policies:

| Path | Policy action | Include |
| --- | --- | --- |
| `/share/*` | `Bypass` | `Everyone` |
| `/api/public/shares/*` | `Bypass` | `Everyone` |
| `/file/*` | `Bypass` | `Everyone` |
| `/assets/*` | `Bypass` | `Everyone` |

Only bypass these public paths. Do not bypass `/api/v1/*`, `/openapi.json`, or the root application. `/file/*` carries both Memos Web private attachment URLs and public URLs with a `share_token`; when Access is bypassed, the Worker still requires a Better Auth cookie/session bearer, native access JWT, or PAT for the private branch and validates the share token, expiry, revocation, memo state, and attachment ownership for the public branch. `Bypass` disables Access enforcement and Access logging for matching requests; machine clients that need authentication and auditability should use `Service Auth`.

The bypass only skips Cloudflare Access. FlareMo still validates share token, expiration time, and memo state. Archived, trashed, deleted, or expired shares must remain inaccessible.

### 6. Verify the configuration

Unauthenticated browser access to the root application should see Cloudflare Access:

```bash
curl -I "$FLAREMO_URL"
```

API requests with a Service Token should reach FlareMo:

```bash
curl "$FLAREMO_URL/api/v1/memos" \
  -H "CF-Access-Client-Id: $FLAREMO_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $FLAREMO_ACCESS_CLIENT_SECRET"
```

Public share routes should not require Access login, but invalid share tokens still must not expose content:

```bash
curl -I "$FLAREMO_URL/share/not-a-real-token"
curl -I "$FLAREMO_URL/api/public/shares/not-a-real-token"
```

## Access Checklist

- The root hostname or Worker URL has a Cloudflare Access application.
- Human access uses an `Allow` policy scoped to allowed users only.
- Scripts, MCP, and Memos-compatible clients use a FlareMo `memos_pat_` token, plus a `Service Auth` policy and Access Service Token when Access remains enabled.
- The `Client Secret` is not committed to the repository, issues, PRs, or public logs.
- `/share/*`, `/api/public/shares/*`, `/file/*`, and `/assets/*` have explicit `Bypass` policies; `/file/*` remains fail-closed at the FlareMo application layer.
- The root application, `/api/v1/*`, and `/openapi.json` are not bypassed.
- Access is not treated as FlareMo application identity; private API requests still use a Better Auth cookie/session bearer or `memos_pat_` PAT.

## Local Development

```bash
pnpm migrate:local
pnpm dev
```

Default URL:

```text
http://localhost:8787
```

## Upgrade

Read `CHANGELOG.md` and GitHub Release notes before upgrading.

The “System update” entry in the lower-left corner shows the installed and latest stable versions. GitHub deployments that use Workers Builds can follow the [update guide](./update.md) to prepare an update pull request and publish with `pnpm deploy:ci` after merge. If repository secrets already hold an API token, **Deploy to Cloudflare** publishes after the upgrade PR lands on `main`.

For a manual update, read the changelog and release notes, then deploy. This command applies pending migrations before publishing the Worker:

```bash
pnpm deploy
```

## Verification

```bash
curl -I "$FLAREMO_URL"
curl "$FLAREMO_URL/openapi.json"
```

If Cloudflare Access is enabled, unauthenticated browser requests should see the Access login page. Script requests must include `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
