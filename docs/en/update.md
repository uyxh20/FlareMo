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

Then open the Cloudflare Worker's `Settings` -> `Builds` and confirm (or [Connect](./github-action-deploy.md) the first time):

- The production branch is the deployment repository's default branch, usually `main`.
- The production deploy command is `pnpm deploy:ci` (writes `wrangler.jsonc` and reuses D1 by name). Do not use a bare `npx wrangler deploy` that would read the placeholder `wrangler.json`.
- The non-production branch deploy command keeps Cloudflare's `wrangler versions upload` default; do not change it to `pnpm deploy:ci` (preview must not apply production D1 migrations).

The workflow can only create an update branch and pull request in the deployment repository. It has no Cloudflare credentials and does not deploy production itself. If production publishes through [GitHub Action deploy](./github-action-deploy.md), merging the upgrade PR onto `main` publishes automatically.

## Install an update

The `Prepare FlareMo update` workflow checks the latest stable Release once per day and opens an update pull request when needed.

To check immediately, open “System update” in the lower-left corner of FlareMo, select “Go to update,” and then:

1. Open `Actions` -> `Prepare FlareMo update`.
2. Select `Run workflow`; leave the version empty to use the latest stable release.
3. Wait for the update pull request.
4. Review the release notes and changes, then merge the pull request.
5. If Workers Builds is connected as in [GitHub Action deploy](./github-action-deploy.md), merge runs `pnpm deploy:ci`. If you instead store an API token in repository secrets, **Deploy to Cloudflare** publishes after the merge lands on `main`. Neither path puts `RESEND_API_KEY` in GitHub secrets.

The update pull request can produce a preview version without running a production D1 migration. After merge, the production build applies migrations before publishing the new Worker while the old version remains available. If the build or migration fails, the new Worker is not deployed; inspect the Cloudflare check on GitHub or Build history in the Cloudflare dashboard.

## Custom code and conflicts

The workflow calculates the difference between the installed and target Releases, then uses Git three-way apply against the deployment repository. It does not depend on preserved upstream commit history, keeps customizations, and allows any merge method supported by the repository when there is no conflict.

If a customization conflicts with a release, the daily job **does not go red**. It opens (or reuses) an upgrade PR, keeps both sides in conflict markers, and writes `FLAREMO_UPDATE_CONFLICTS.md`. Fork changes are not dropped. Do not merge until the markers are gone. Later scheduled runs succeed once that branch already exists.

You can still continue locally from the log or:

```bash
git remote add flaremo-upstream https://github.com/realchendahuang/FlareMo.git
git fetch flaremo-upstream --tags
git diff --binary --full-index v0.3.0 v0.3.1 > flaremo-update.patch
git apply --3way --index flaremo-update.patch
```

After resolving conflicts, push `main` and Cloudflare Workers Builds will complete the deployment.

## Existing instances

Instances running v0.2.1 or earlier need one final manual update to v0.3.0. From v0.3.0 on, the FlareMo repository ships the update workflow (`.github/workflows/flaremo-update.yml`) and the in-app version entry; pushing it to your own deployment repository gives you the same update flow.

GitHub may disable scheduled workflows after 60 days without public-repository activity. The in-app version check continues to work; re-enable the workflow on the repository's Actions page and run it manually.

GitLab deployments do not yet support this GitHub workflow. Continue to use the manual process in the [deployment guide](./deploy.md).
