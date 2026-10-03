# Update FlareMo

FlareMo updates flow through the deployment repository and Cloudflare Workers Builds. The application never stores a GitHub Personal Access Token or Cloudflare API Token.

## Enable updates once

Set `FLAREMO_DEPLOY_REPOSITORY` to your own deployment repository (your fork or copy of FlareMo — the repository you deploy from), using this format:

```text
your-github-owner/repository
```

For example:

```text
octocat/flaremo
```

In that repository, open `Settings` -> `Actions` -> `General`:

- Allow the repository to run GitHub Actions.
- Under `Workflow permissions`, allow workflows to read and write the repository.
- Allow GitHub Actions to create pull requests.

Then open the Cloudflare Worker's `Settings` -> `Build` and confirm:

- The production branch is the deployment repository's default branch, usually `main`.
- The production deploy command is `pnpm run deploy`.
- The non-production branch deploy command keeps Cloudflare's `wrangler versions upload` default; do not change it to `pnpm run deploy`.

The workflow can only create an update branch and pull request in the deployment repository. It has no Cloudflare credentials and does not deploy production itself. If production publishes through [GitHub Action deploy](./github-action-deploy.md), merging the upgrade PR onto `main` publishes automatically.

## Install an update

The `Weekly upstream file take` workflow (`.github/workflows/flaremo-update.yml`) compares the latest stable Release every Monday morning. It does **not** replay upstream history 1:1 onto `main`, and it does **not** merge its own pull request.

It only opens a PR for files that:

- differ from upstream
- are outside the protected set (`apps/worker/src/auth.ts`, password-reset tests and routes, `deploy-cloudflare.yml`, and the README files that state push-to-main publishing and that the Resend key is a Worker secret)
- can be taken as the whole upstream file without dropping unique fork content (the fork matches the merge-base, or a 3-way is clean and equals the upstream file)

Conflicts and protected diffs are listed in the PR body and left untouched. If nothing is eligible, the job exits green and opens no PR.

To run it immediately:

1. Open `Actions` -> `Weekly upstream file take`.
2. Select `Run workflow`; leave the version empty to use the latest stable release.
3. If any files qualify, wait for the pull request.
4. Review the Taken / Protected / Conflicts lists in the PR body, then decide whether to merge.
5. If you publish with [GitHub Action deploy](./github-action-deploy.md), merging the PR onto `main` publishes automatically.

The update pull request can produce a preview version without running a production D1 migration. After merge, the production build applies migrations before publishing the new Worker.

## Existing instances

Instances running v0.2.1 or earlier need one final manual update to v0.3.0. From v0.3.0 on, the FlareMo repository ships the update workflow (`.github/workflows/flaremo-update.yml`) and the in-app version entry; pushing it to your own deployment repository gives you the same update flow.

GitHub may disable scheduled workflows after 60 days without public-repository activity. The in-app version check continues to work; re-enable the workflow on the repository's Actions page and run it manually.

GitLab deployments do not yet support this GitHub workflow. Continue to use the manual process in the [deployment guide](./deploy.md).
