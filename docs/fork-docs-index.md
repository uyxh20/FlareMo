# Documentation index

Fork-owned. A map of every document in this repo and of the places outside it, with how current each one is. Checked on 2026-11-08 against `main` (live version #47) and upstream `main` (v0.31.1). Keep it short: when you add or retire a doc, change one line here.

Where the story of the project is kept:

- **What is live, and when it changed:** the release log at the end of [architecture.html](architecture.html). It is the fork's changelog. The root `CHANGELOG.md` is upstream's and stops at v0.22.1.
- **What each fork feature is, why, and how to undo it:** [fork-customizations.md](fork-customizations.md).
- **Standing rules for agents and humans:** [../AGENTS.md](../AGENTS.md) (the "Fork: shipping to live" block at the top is the fork's; the rest is upstream's, in Chinese).

## Fork docs (current, keep up to date)

| Doc                                                                                  | What it covers                                                        | State                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [architecture.html](architecture.html)                                               | Pictures of what runs where; release log. Also published as an Artifact. | Current (version #47). Updated with every merge or ship.                       |
| [fork-customizations.md](fork-customizations.md)                                     | Every fork change, hook-in files, undo steps, upstream sync notes     | Current. Notes that upstream is 13 releases ahead.                           |
| [fork-data-sources.md](fork-data-sources.md)                                         | Which data reaches which feature; module map                          | Current. Known gaps are still open: imported entries are not in semantic search, and no fork table is in the personal export. |
| [fork-dev-environment.md](fork-dev-environment.md)                                   | The dev Worker, the prod deploy script, safety guards                 | Current. Agent-on-dev note added 2026-11-08.                                   |
| [fork-general-agent.md](fork-general-agent.md)                                       | The diary agent: jobs, cards, Undo, spend, setup, and the review's cascade ladder (live since version #47) | Current.                                                                       |
| [fork-flywheel.md](fork-flywheel.md)                                                 | Change log, weekly scorecard, owner-approved tuning                   | Current.                                                                       |
| [fork-task-attachments.md](fork-task-attachments.md)                                 | Files on tasks and how they are read                                  | Current.                                                                       |
| [fork-link-summaries.md](fork-link-summaries.md)                                     | Link summaries                                                        | Current.                                                                       |
| [fork-health-tracker.md](fork-health-tracker.md)                                     | Health tracker rules and tables                                       | Current.                                                                       |
| [planning-cockpit-implementation-plan.md](planning-cockpit-implementation-plan.md)   | The cockpit board, task panel, history archive, rules                 | Current. Written as a build plan; sections 13 and later hold the later changes. |
| [planning-cockpit-goals-review.md](planning-cockpit-goals-review.md)                 | Goals page and weekly review                                          | Current (status line fixed 2026-11-08: live since 2026-10-12).                 |
| [planning-cockpit-period-review.md](planning-cockpit-period-review.md)               | Month, quarter and year reviews                                       | Current (status line fixed 2026-11-08: live since 2026-10-17). The cascade ladder is described in fork-general-agent.md. |
| [../skills/](../skills) (`weekly-review`, `period-review`, `ask-my-diary`, `goal-check`) | The diary agent's skills (`skills/flaremo-memory` is upstream's; upstream has since renamed it `flaremo-notes`) | Current.                     |
| `.claude/settings.json`                                                              | Ask-first rules for anything that writes to live                      | Current.                                                                       |

## Upstream docs the fork uses as they are

Written by upstream, not edited by the fork. They stay in place so merges stay clean, and some are published on the docs site (the site's tests fail if a published doc goes missing).

- **Deploy and run:** `deploy.md`, `agent-deploy.md`, `github-action-deploy.md` (fork note: GitHub deploys are off, use the prod deploy script), `update.md`, `release.md`, `maintenance.md` (backup and restore), plus the `docs/en/` copies.
- **Design and stack:** `architecture-notes.md`, `tech-stack.md`, `design-system.md`, `concept-model.md`, `content-authority.md`, `semantic-search.md`, `vector-namespace-design.md`, `product-requirements.md`.
- **Plugins:** `plugins.md`, `plugin-platform-standard.md`, `docs/en/plugins.md`, and `plugins/README.md`.
- **Features in daily use whose docs code still cites:** `voice-capture.md`, `voice-capture-design.md`, `voice-capture-rollout.md`, `voice-settings.md`, `asr-minimax.md`, `asr-admin-settings.md`, `audio-compression-research.md`, `image-compression-design.md`, `liquid-glass-design.md`.
- **Memos compatibility:** `memos-compatibility.md`, `memos-ecosystem.md`.
- **Agent memory:** `agent-memory.md`, `agent-memory-landscape.md`, `memory-ledger-design.md`, `harness-adapter-spec.md`, `agent-ingestion.md`, and the repo-root `harness/` folder. Upstream has since removed or renamed several of these; the fork's copies describe the code the fork still runs.

## Upstream docs for features this fork hides

The sidebar hides Team projects, Projects, Articles, Wander and On this day. These docs describe those features. They are accurate for upstream, not part of daily use here.

`team-mode.md`, `team-space-ux.md`, `team-projects-workbench.md`, `projects-tasks-audit.md`, `time-task-mental-model-audit.md`, `article-publishing-design.md`, `composer-fullscreen-article-design.md`, `seo-share-pages-best-practices.md`.

## Upstream point-in-time notes (history, not instructions)

Audits and design write-ups from September 2026. The first seven are linked from nowhere; the rest are linked only from other docs. They describe how upstream decided something, not how the fork works today.

`quality-backlog.md` (linked from one doc), `tag-system-audit.md`, `ux-differentiation.md`, `base-ui-migration.md`, `brand-color-theming.md`, `cf-usage-ui-config.md`, `composer-wysiwyg-closing.md`, `composer-editor-wysiwyg.md`, `design-principle-rollout.md`, `flomo-alignment-ux-refinement.md`.

If the fork ever wants them out of sight, a `docs/archive/` folder is the place. Moving them costs a merge conflict on every upstream sync and breaks links, so the default is to leave them.

## Upstream project files

`README.md` and its seven translations, `ROADMAP.md`, `CHANGELOG.md` (stops at v0.22.1), `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CODEOWNERS`, `llms.txt`, `docs/site/prd.md`, `apps/site/`. They describe upstream FlareMo and never mention the planner, Schizo Diary or the diary agent. Do not rewrite them in the fork; the fork's own story is the section above.

## Outside the repo

- **Project folder** (`/mnt/project-files/`): plans, reviews, mockups, eval runs and runbooks made by threads. Not in git. `weekly-review-eval/runner/` holds the review eval scripts removed from the repo on 14 Oct (see fork-customizations.md, "Removed fork code"). Several folders hold model output about diary weeks, so they stay out of the repo and published pages.
- **Artifacts** published in the project: the architecture page is the only one that must stay current. Repo docs link to two others as the approved designs (Goals Cockpit, One Review Flow), and the premium-html-report skill names Goals Cascade Review as its style reference; keep those three. The rest are design options, reviews and plans from the time they were made.
- **Project instructions** (the brief in project settings): the open follow-ups list needs a refresh whenever a fix ships.
