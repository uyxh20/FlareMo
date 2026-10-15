# Fork customizations

This fork (`uyxh20/FlareMo`) merges upstream (`realchendahuang/FlareMo`) regularly. This file lists what the owner asked for that upstream does not do: what each change is and why, which upstream files carry a hook-in, which files are fork-owned, how to undo each change, and what to watch for on an upstream sync.

One rule runs through every change: **logic goes in fork-owned files under `apps/web/src/fork/`, and an upstream file gets only the smallest wiring that calls into them.** Upstream diffs stay at a few lines per file, and a merge conflict is easy to read.

The planning cockpit is a separate fork add-on with its own document: [planning-cockpit-implementation-plan.md](planning-cockpit-implementation-plan.md). So is the health tracker: [fork-health-tracker.md](fork-health-tracker.md).

## Where things live

Every fork-owned folder or file group, so nothing is a surprise. Generate the raw list with `comm -23 <(git ls-files | sort) <(git ls-tree -r --name-only upstream/main | sort)`.

| Where                                                                                                          | What it is                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/planner/`                                                                                        | The planning cockpit, Goals and weekly review screens: board, task panel, year map, goals editor, review page, their hooks, strings and tests.    |
| `apps/web/src/fork/`                                                                                           | Small fork changes to upstream screens: hidden sidebar entries, the `#` tag picker, the product name, the backdate dialog.                        |
| `apps/web/src/health/`                                                                                         | The health tracker screens: week strip, memo labels, Health page.                                                                                 |
| `packages/domain/src/planner/`                                                                                 | Planner logic: plans, board, task history archive, goals, weekly review context and prompts, nightly sync.                                        |
| `packages/domain/src/health/`                                                                                  | Reads health values out of diary entries and keeps the tracker rows in step.                                                                      |
| `packages/domain/src/fork/`                                                                                    | The registry of which data reaches which feature, the guard tests (frozen migrations, hook-in table, agent ask rules) and the backdating rules.                               |
| `packages/domain/src/memo-backdate.test.ts` | Tests for editing a memo's created date (the rules are in `packages/domain/src/fork/memo-backdate.ts`, called from a hook-in in `memos-write.ts`). |
| `packages/contracts/src/planner*.ts`, `fork-brand.ts`, `fork-health.ts`                                        | Shared types and request schemas for the planner, the product name and the health tracker.                                                        |
| `packages/db/src/schema/planner.ts`, `fork-health.ts`, `packages/db/src/planner-migrations.ts` and their tests | Drizzle mirror of the fork tables (kept out of the schema barrel) and checks that it matches the SQL.                                             |
| `migrations/9xxx_*.sql`                                                                                        | Hand-written, additive fork migrations (planner, goals and review, health). Not in the Drizzle journal; applied hashes are frozen.                |
| `apps/worker/src/fork/`                                                                                        | Product-name helpers for the Worker (page titles, mail copy) and the password reset checks.                                                                                     |
| `apps/worker/src/routes/planner-*.ts`, `health-api.ts` and their tests                                         | The fork API routes: planner, goals, review, review model calls, health tracker, and a test that upstream flows still work.                       |
| `scripts/fork/dev-env*.mjs`, `fake-wrangler.mjs`                                                               | The separate dev deployment: clone live data, deploy, safety guard for every wrangler call.                                                       |
| `scripts/fork/prod-deploy.mjs`                                                                                 | The one way to ship to live (status, dry run, deploy, rollback).                                                                                  |
| `tests/e2e/cockpit.spec.ts`, `goals-review.spec.ts`, `fork-ui.spec.ts`                                         | Opt-in browser tests for the fork screens. Written, not run by default.                                                                           |
| `docs/fork-*.md`, `docs/planning-cockpit-*.md`                                                                 | The fork's own docs (this file, data sources, dev environment, health tracker, planner plan, goals and review). |
| `.claude/settings.json`, `.cursorrules`                                                                        | Agent settings: ask before raw live writes; editor rules.                             |

## What is customized, and why

### 1. Five sidebar entries are hidden

The owner does not use **Team projects** (`/team-projects`), **Projects** (`/projects`), **Articles** (`/articles`), **On this day** (`/review/daily`) or **Wander** (`/review/walk`), so their links are gone from the sidebar. The "On this day · N notes from past years" banner at the top of the timeline is hidden too, by `forkOnThisDayBannerHidden` in `sidebar-nav.tsx` (one `&&` hook-in in `use-workspace-queries.ts`, which also stops the request that fed it). The notification bell can still open the On this day page if a daily-review notification arrives. On phones the sidebar is the drawer, which is the same component, so they are gone there too.

- The routes still work by URL.
- Nothing else moves: the ⌘K search, the notification bell, the "N overdue" link in the mini calendar and the Cockpit link are unchanged.
- `flaremo-explorer.tsx` keeps every `<Link>` block. Its `<nav>` becomes `ForkSidebarNav`, which forwards every prop and every child except an element whose `to` prop is in `forkHiddenSidebarRoutes`. Conditional children (`{cond && <Link/>}`) and other components (the Cockpit link) pass through untouched.

### 2. The "#" tag picker in the memo composer

Before, the picker listed only the top six tags. It hung above the composer's toolbar and grew upward, so in the timeline (the composer sits right under the sticky page header) its top rows were cut off and it covered the text being typed. It had no keyboard support: no highlighted row, arrows did nothing, Enter and Tab did not complete.

Now, in the timeline composer and in the focus canvas alike:

| Behaviour | Detail |
| --- | --- |
| The whole vocabulary | `#` alone lists every tag, most used first and then A to Z. `#text` lists every match: exact, then prefix, then substring, each by usage. The six-row cap is gone: the call site passes `FORK_TAG_PICKER_LIMIT` (500, only a bound for the DOM), and `filterTagSuggestions` keeps its own default of 6 and its upstream tests. |
| Scrolls | About eight rows show (`max-h-72`). The list scrolls inside itself (`overflow-y-auto overscroll-contain`), so scrolling it never scrolls the page. A mouse press anywhere on it, its scrollbar included, never takes focus from the editor. |
| Never clipped | In the timeline the list opens **below** the composer, over the notes, and flips **above** only when there is no room below. Its max height is the room that is really there, measured when it opens and again when the viewport or the composer's size changes. The area is the visual viewport (so a phone keyboard counts), narrowed by the scrolling page body (so the sticky header never counts as room). The focus canvas keeps its list above its own toolbar, with the same scrolling and a height cap. |
| Keyboard | Typing a name highlights the first match at once; **Tab** or **Enter** completes it (`#carl` + Tab gives `#carlsberg `). A bare `#` highlights nothing until **ArrowDown**, so `#` then Enter is a new line, as before. **ArrowUp** and **ArrowDown** move the highlight, wrap around, and scroll the row into view. Hovering a row (real pointer travel) moves the same highlight; click or tap still completes it. **Escape** closes the list until the token changes. |
| What it never takes | A key with Shift, Ctrl, Meta or Alt held (Shift+Enter and Cmd/Ctrl+Enter still send the note), any key during IME composition, and Tab or Enter while no row is highlighted. |
| Focus canvas | Escape with the list open closes only the list. The next Escape closes the canvas as before. |
| Follows the editor's focus | The list shows only while its own editor has focus. Click elsewhere and it goes (before, it stayed over the notes). A draft restored on load that ends in an unfinished tag no longer throws a list up before anyone has focused the editor. It also keeps the timeline composer's list from opening behind the focus canvas, where both editors hold the same draft. |
| Accessible | `role="listbox"` (named "Tags", an existing string) with `role="option"` rows and `aria-selected`. The highlighted row is `bg-accent text-accent-foreground`, the same tint as the sidebar's active link and the dropdown menus. Rows are out of the tab order. |

The `[[` wiki-link list is untouched.

### 3. Product name: "Schizo Diary"

The owner calls the product **Schizo Diary**. Every place a user reads the product name shows it by default. Nothing is written to the database: the default lives in code, so a fresh install and the owner's existing instance both show the new name. An admin-set name (Admin → Branding) still wins wherever it reached before.

What changed:

- **Browser and installed app:** the tab title, `apple-mobile-web-app-title`, the manifest `name` and `short_name`, the offline page title, and the service worker's fallback push title.
- **Web UI:** every translated string that says "FlareMo" shows the live product name. The catalogs keep the upstream word, and `t()` swaps it at render time (`apps/web/src/fork/product-name.ts`), so none of the eight locale files changed. The default branding, the media-player metadata and the email sender placeholder use the same name.
- **Worker:** the default branding (`/api/app/branding` and the health endpoint), the share and article page titles and their unavailable pages, the RSS feed title, the 2FA issuer (Better Auth `appName`), the daily-review and overdue-task push titles, the transactional email copy in all eight locales, and the test email.

Two behaviours to know:

- The UI strings and the push titles read the live name, so an admin-set name shows there. **Emails do not.** Their copy is static and has no database handle, so they always say "Schizo Diary". They said "FlareMo" before this change, so nothing regressed, but an admin-set name does not reach them.
- The static HTML and manifest carry the fork default until the app loads. `BrandingProvider` then sets `document.title` to the admin's name.

Where the name lives: `FORK_PRODUCT_NAME` in `packages/contracts/src/fork-brand.ts`, which both the worker and the web import. `DEFAULT_FLAREMO_PRODUCT_NAME` in `packages/domain/src/branding.ts` keeps its upstream identifier, but its value is now the fork constant, so that upstream file changes by one line.

**To change the name again**, edit the constant and the static copy:

1. `FORK_PRODUCT_NAME` in `packages/contracts/src/fork-brand.ts`. This changes every code default at once.
2. The static copy that cannot import it: `apps/web/index.html` (`<title>` and `apple-mobile-web-app-title`), `apps/web/public/site.webmanifest` (`name` and `short_name`), `apps/web/public/offline.html` (`<title>`), and the fallback title in `apps/web/public/sw.js`.
3. The expectations that assert the default: `apps/worker/src/api/branding.test.ts`, `apps/worker/src/scheduled.test.ts`, and in e2e `tests/e2e/branding.spec.ts` and the "Save to …" button regexes in the two capture specs.
4. Run `pnpm exec vitest run apps/web/src/fork apps/worker/src/fork apps/worker/src/api/branding.test.ts apps/worker/src/scheduled.test.ts --config vitest.config.ts`.

**Deliberately left as "flaremo"**, because they are identifiers, protocol text or upstream references:

- **Identifiers:** `FLAREMO_*` environment variables, the `flaremo` Worker, D1 and R2 names, cookie names, the `memos_pat_` token prefix, storage keys (`flaremo.locale`, `flaremo-audio-position:`, the `flaremo-branding` channel), API paths, the `flaremo-app-shell` marker, the `/brand/flaremo-*` asset paths, the `window.FlareMo` plugin global, and code names such as `FlareMoDb`, `FlareMoLogo`, `DEFAULT_FLAREMO_PRODUCT_NAME` and `FlareMoApp`.
- **MCP and feed metadata:** the MCP server `name` in `routes/mcp/legacy-jsonrpc.ts` and the feed `generator` meta. Both are technical identifiers, not product chrome.
- **Upstream references:** the GitHub release and update links (`realchendahuang/FlareMo`), `DEFAULT_RELEASE_REPOSITORY`, and the official plugin directory (its URL is `https://flaremo.app/…`, and its label "FlareMo 官方目录" names that upstream directory). Renaming any of these would point the update check or the plugin source at the wrong place.
- **Speech recognition:** `normalizeTranscript` in `asr/bridge.ts` maps spoken spellings of "FlareMo" to "FlareMo" in transcripts. Changing its output would rewrite what users dictated.
- **Avatar seed:** the `"FlareMo"` seed in `components/ui/avatar.tsx` sets the artwork for nameless users. It is never displayed, and changing it would change every such avatar.
- **Example project name:** `memory.composerCustomProjectPrompt` keeps "e.g. FlareMo" (listed in `PRODUCT_NAME_EXCLUDED_KEYS`). It is an example folder name, and someone with a repo called FlareMo should see it unchanged.
- **Protocol and API error text:** messages such as "…not configured on FlareMo", "Please use the FlareMo web app to sign up." and "This browser request must use FlareMo's origin." (a web test matches the last one), plus the MCP tool descriptions. They are read by API and MCP clients, not by the app's chrome. This is a follow-up candidate if the owner wants them renamed.
- **Other apps:** the Telegram bot (`apps/telegram-bot`) returns its own "FlareMo" error text. It is a separate Worker and out of this change.
- **Owner's user name:** the `FLAREMO_SINGLE_USER_NAME` example ("FlareMo Owner") in `worker-configuration.d.ts` is a user name, not the product name.

### 4. Health tracker

The owner logs training, breath work and nights out in the diary. The tracker reads those notes into small structured rows and shows a week strip above the timeline, label chips under memo cards, and a `/health` page. Full description, rules and undo steps: [fork-health-tracker.md](fork-health-tracker.md).

- It never changes a note. Rows can be rebuilt any time with **Re-read diary**.
- A memo save never fails because of it: the sync call swallows every error.
- New tables come from the hand-written `migrations/9010_planner_health.sql` (additive, no foreign keys to upstream tables). They are listed in `RESTORE_TABLES`.
- The API is at `/api/app/health-tracker`, because `/api/app/health` is upstream's.
- One module reads the diary into rows (the health projection, `packages/domain/src/health/sync.ts`). Long reads keep a bookmark in `health_sync_state` (`migrations/9012_planner_health_bookmark.sql`, three nullable columns), so a read that is cut off carries on instead of being lost. No upstream file changed for this.
- The screens show this week's counts (Monday to Sunday), not targets: the default targets were never changed (Q05). The targets are still in the API because the weekly review prompt reads them; that changes when the review hold lifts.

### 5. Edit a memo's created date and time

The owner can backdate a note (retrofit entries) from the memo's ⋯ menu: **Edit date and time** opens a small dialog with a date-time picker. No migration: `memos.created_at` already exists.

- API: `PATCH` memo accepts an optional `created_at` (ISO instant). A future time (beyond 5 minutes of clock skew) is refused; the same instant is a no-op. Only the author can do it.
- The very first time is kept in the memo payload as `original_created_at` and is never overwritten by later moves.
- Follows automatically: timeline order, calendar, hourly counts (adjusted in the same save), weekly review week, search and export. The health tracker re-reads the memo on save, so its rows move to the new day (unless the owner edited or dismissed the row).
- The first time also survives a later full-payload update (a revision restore, an `/api/v1` client): when the new payload leaves `original_created_at` out, it is carried over.
- `created_at` is in the shared `updateMemoSchema`, so the Memos-compatible `PATCH /api/v1/memos/:id` and the published OpenAPI accept it too, with the same rules. Any client holding a `memos_pat_` token can therefore backdate.
- Not covered: the nightly memory "dreaming" sweep only looks at entries newer than its last run, so a note backdated before that run is not swept; the manual memory button still works. The MCP update tool does not take `created_at`.
- Files: `apps/web/src/fork/memo-date-dialog.tsx`, `apps/web/src/fork/memo-date.ts`, `packages/domain/src/fork/memo-backdate.ts`, `packages/domain/src/memo-backdate.test.ts`. Undo: remove the menu item and dialog lines in `memo-card-menu.tsx`, the `created_at` field in `updateMemoSchema`, and the `forkApplyBackdate` lines in `updateMemo`.

## Upstream files with a hook-in

These are all the upstream files this fork changes, compared with the upstream commit `main` last merged (named on the first line of `packages/domain/src/fork/upstream-manifest.txt`). `packages/domain/src/fork/upstream-hookins.test.ts` fails when a changed upstream file has no row here, or a row names a file that is back to upstream, so the list cannot drift. Line counts: `git diff --numstat <that commit> -- <file>`.

**App code.** Each hook-in below has a wiring test that fails when a merge drops it: `sidebar-nav-wiring`, `tag-picker-wiring`, `product-name-wiring` and `memo-date-wiring` in `apps/web/src/fork/`, `health-wiring` in `apps/web/src/health/`, `planner-wiring` in `apps/web/src/planner/`, and `packages/domain/src/fork/guards.test.ts` for the nightly planner sync and the `/api/app/planner` mount.

| File | Hook-in |
| --- | --- |
| `apps/web/src/components/flaremo-explorer.tsx` | Sidebar: one import, `<nav` becomes `<ForkSidebarNav`, `</nav>` becomes `</ForkSidebarNav>`. Planner: one import and `<PlannerNavLink onNavigate={onNavigate} />` after the Team projects link. |
| `apps/web/src/hooks/use-workspace-queries.ts` | One import and `!forkOnThisDayBannerHidden &&` in the "On this day" banner condition. |
| `apps/web/src/components/rich-composer-editor.tsx` | New optional `onSuggestionKeyDown` prop (type, destructure, ref) and a call at the very top of `handleKeyDown`, after the IME check and before the early return that hides arrows and Tab from the rest of the handler. When it returns true the editor does nothing else with the key. |
| `apps/web/src/hooks/use-composer-suggestions.ts` | Passes `FORK_TAG_PICKER_LIMIT` to `filterTagSuggestions`, calls `useTagPicker`, and returns `activeTagIndex`, `setActiveTagIndex`, `handleSuggestionKeyDown`, `claimDialogEscape`; `showTagSuggestions` now comes from the picker. |
| `apps/web/src/components/composer/composer-suggestion-lists.tsx` | `ComposerTagSuggestions` only: `activeIndex`, `onActiveIndexChange` and `anchor` props, `useTagPickerList`, listbox and option roles, the highlighted style, the mousedown guard. `ComposerWikiSuggestions` is untouched. |
| `apps/web/src/components/memo-composer.tsx` | Passes the picker's keys to the editor, and the highlight to the list. |
| `apps/web/src/components/composer/composer-focus-canvas.tsx` | The same, plus `anchor="canvas"` and the dialog's `onOpenChange` wrapped in `withTagPickerEscape`. |
| `apps/web/src/i18n.tsx` | `I18nProvider` reads `useBranding()` and runs `brandTemplate` on each template in `t()` before interpolation. |
| `apps/web/src/branding.tsx` | `DEFAULT_BRANDING.product` is the fork constant. |
| `apps/web/src/components/reading/reading-audio-provider.tsx` | The media-session artist and album read the live product. |
| `apps/web/src/pages/account/integrations-card.tsx` | The email sender placeholder falls back to the fork constant. |
| `apps/web/index.html`, `apps/web/public/site.webmanifest`, `apps/web/public/offline.html` | Static text: the title, the Apple web-app title, the manifest name and short name, the offline title. |
| `apps/web/public/sw.js` | The push fallback title; `cockpit`, `goals`, `weekly-review` and `health` in `privateRoutes`. |
| `apps/web/src/router-tree.tsx` | Two imports, `...plannerRoutes` (from `apps/web/src/planner/routes.tsx`) and `healthRoute` in the route list. |
| `apps/web/src/App.tsx` | One import and `<HealthWeekStrip visible={view === "all" && !hasFilters} />` (with a comment line) after the composer. |
| `apps/web/src/components/memo-card.tsx` | One import and `<HealthMemoLabels memo={memo} />` under the card body. |
| `apps/web/src/components/memo-card/memo-card-menu.tsx` | Backdating: one import, a `forkDateOpen` state, `<ForkMemoDateMenuItem />` after "Edit", and `<ForkMemoDateDialog />` next to the menu (it renders nothing until first opened). |
| `apps/web/src/components/memo-card/memo-card-body.tsx` | An expanded memo had a hidden 1,600px height cap, so a long memo, such as a weekly summary, was cut off even after "Expand". Expanded is now `max-h-none`. CSS cannot animate to `none`, so expanding and collapsing snap instead of sliding. Undo: put `max-h-[1600px]` back. |
| `apps/worker/src/spa-routes.ts` | `"/cockpit"`, `"/goals"`, `"/weekly-review"` and `"/health"` in the SPA routes. |
| `apps/worker/src/index.ts` | `mountLazyRoute` for `/api/app/planner` and `/api/app/health-tracker`. |
| `apps/worker/src/scheduled-tasks.ts` | Product name: imports `resolveProductName`; the two push titles use the live name. Planner: imports `plannerSyncAllUsers` and calls it right before `hardDeleteExpiredProjects` and right after `hardDeleteExpiredTasks`; when the first call reports `paused`, both purge calls are skipped that night, so nothing is purged before it is archived (the loop and error handling live in `packages/domain/src/planner/history-sync-nightly.ts`). Health: imports `healthNightlySweep` and awaits it once in the nightly block. |
| `apps/worker/src/env.ts` | Types and a comment for the weekly review's model settings (`FLAREMO_REVIEW_*`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). |
| `apps/worker/src/auth.ts` | Imports the constant; Better Auth `appName` (the 2FA issuer). |
| `apps/worker/src/email-templates.ts` | `emailCopy` returns `brandCopy(COPY[locale])`, and imports it. |
| `apps/worker/src/email.ts` | Imports the constant; the test email's subject and text. |
| `apps/worker/src/routes/share-page.ts` | Imports the constant; the unavailable page's fallback name. |
| `apps/worker/src/routes/article-page.ts` | Imports the constant; the unavailable page, the page title and the feed title fallbacks. The `generator` meta stays. |
| `packages/contracts/src/index.ts` | `export * from "./fork-brand";` and `export * from "./planner";` (`planner.ts` is fork-owned and re-exports `./fork-health`). |
| `packages/contracts/src/memos.ts` | `created_at` (optional ISO instant) in `updateMemoSchema`. |
| `packages/domain/src/branding.ts` | Imports `FORK_PRODUCT_NAME`; `DEFAULT_FLAREMO_PRODUCT_NAME` equals it. |
| `packages/domain/src/memos-write.ts` | Health: imports `forkHealthSyncMemo` and awaits it at the end of `createMemo` and of `updateMemo`. Backdating: imports `forkApplyBackdate` from `./fork/memo-backdate`, calls it once after `nextPayload` is built, and uses its result in the edit-rights check, `nextMemo` and the patch (six lines). |

**Tests, scripts and config.**

| File | Change |
| --- | --- |
| `apps/worker/src/api/branding.test.ts`, `apps/worker/src/scheduled.test.ts` | Expectations for the default name, plus one case that clearing the custom name restores it. |
| `tests/e2e/branding.spec.ts`, `tests/e2e/capture-flow.spec.ts`, `tests/e2e/capture-webkit.spec.ts` | Expectations for the new name: the login text and the "Save to …" button label. Not run. |
| `playwright.config.ts` | `cockpit`, `fork-ui` and `goals-review` added to the `memo-ui` project's `testMatch` alternation. |
| `scripts/persistence-manifest.mjs` | The planner and health tables in `RESTORE_TABLES`. |
| `scripts/e2e-server.mjs` | `FLAREMO_REVIEW_AI:off` in the test bindings, so the weekly review e2e runs on the page's own drafts instead of waiting on Workers AI. |
| `.github/workflows/ci.yml` | CI runs nightly (skipped when the last 24 hours touched only docs), on pull requests (not docs-only ones) and by hand, not on every push, to stay within the free Actions minutes. It also runs `node --test scripts/fork/*.test.mjs` and `pnpm persistence:check`. |
| `.github/workflows/flaremo-update.yml` | The upstream release check runs weekly instead of daily, and its PR text says merging does not deploy. |
| `AGENTS.md` | A "Fork: shipping to live" section at the top; the production-deploy lines and the workflow line point at `scripts/fork/prod-deploy.mjs`. |
| `.github/workflows/deploy-cloudflare.yml` | Deleted on 2026-10-04: the fork deploys with `scripts/fork/prod-deploy.mjs` (see `docs/fork-dev-environment.md`). |
| `packages/domain/package.json` | `@types/node` as a devDependency: the fork's guard tests in `packages/domain/src/fork/` use `node:` modules. Before the v0.22.1 merge they found the types only through pnpm's hidden hoisting, which the new `cf` package changed. |
| `pnpm-lock.yaml` | Regenerated in the v0.22.1 merge: upstream added the `cf` devDependency without updating the lockfile. Goes back to upstream once upstream ships a matching lockfile. |
| `.dev.vars.example`, `wrangler.jsonc.example`, `scripts/write-wrangler-config.mjs`, `scripts/write-wrangler-config.test.mjs` | Email provider settings for the deleted deploy workflow. Nothing runs them now. |

**Docs.** These still describe the deleted deploy-on-push workflow or the old email setup, and are due to go back to upstream's text.

| File | Change |
| --- | --- |
| `README.md`, `README.zh-CN.md` | One line each on the deploy workflow. |
| `docs/deploy.md`, `docs/en/deploy.md`, `docs/github-action-deploy.md`, `docs/en/github-action-deploy.md` | Deploy-on-push and email setup sections. |
| `docs/update.md`, `docs/en/update.md`, `docs/agent-deploy.md`, `docs/en/agent-deploy.md`, `docs/maintenance.md`, `docs/release.md` | One or two lines each on the deploy workflow. |
| `docs/architecture-notes.md` | One line on email. |

## Fork-owned files

All new, none in conflict with anything upstream ships.

| File                                                                                 | What it holds                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/fork/sidebar-nav.tsx`                                                  | `forkHiddenSidebarRoutes` and `ForkSidebarNav`.                                                                                                                                                                                                |
| `apps/web/src/fork/tag-picker.ts`                                                    | The pure rules: the row limit, the key-to-action reducer (move, accept, close, ignore), the dialog Escape claim, the pointer-travel test, and the placement and height calculation.                                                            |
| `apps/web/src/fork/use-tag-picker.ts`                                                | The picker's state: highlight and dismissal per token, the editor-focus gate, key handling, the Escape claim.                                                                                                                                  |
| `apps/web/src/fork/use-tag-picker-list.ts`                                           | What the list does in the DOM: measuring where it opens, keeping the highlighted row in view, lifting the composer above the notes while it is open.                                                                                           |
| `apps/web/src/fork/*.test.ts(x)`                                                     | Unit tests for all of the above, plus `sidebar-nav-wiring.test.ts` and `tag-picker-wiring.test.ts`, which fail when an upstream sync drops a hook-in. `test-render.tsx` is their small jsdom helper (not imported by the app).                 |
| `tests/e2e/fork-ui.spec.ts`                                                          | Playwright cases for both changes (see below).                                                                                                                                                                                                 |
| `packages/contracts/src/fork-brand.ts`                                               | `FORK_PRODUCT_NAME` (the name) and `UPSTREAM_PRODUCT_NAME` (the word the hook replaces).                                                                                                                                                       |
| `apps/worker/src/fork/product-name.ts`                                               | `resolveProductName` (the live name, falling back to the default), `brandText` and `brandCopy` (for the email copy).                                                                                                                           |
| `apps/worker/src/fork/product-name.test.ts`                                          | Unit tests for the three helpers.                                                                                                                                                                                                              |
| `apps/worker/src/fork/email-reset.test.ts` | Password reset checks: a reset through upstream's forgot-password route revokes browser sessions but not `memos_pat_` tokens, reset mail goes out through Resend, and Better Auth's own `/api/auth/request-password-reset` stays off. |
| `apps/web/src/fork/memo-date-dialog.tsx`, `memo-date.ts`, `memo-date-wiring.test.ts` | The backdating menu item and dialog, the date helpers, and the test that fails when a merge drops a backdating hook-in. |
| `apps/web/src/planner/routes.tsx`, `planner-wiring.test.ts` | The cockpit, goals and weekly review routes, and the test that fails when a merge drops a planner hook-in. |
| `apps/web/src/fork/product-name.ts`                                                  | `brandTemplate`, plus the two key lists: `PRODUCT_NAME_EXCLUDED_KEYS` and `STOCK_BRAND_KEYS`.                                                                                                                                                  |
| `apps/web/src/fork/product-name.test.ts`                                             | Unit tests for `brandTemplate`, and a check across all eight catalogs that the key lists still match.                                                                                                                                          |
| `apps/web/src/fork/product-name-wiring.test.ts`                                      | Fails when an upstream sync drops the `i18n.tsx`, `branding.tsx` or media-session hook-ins.                                                                                                                                                    |
| `scripts/fork/prod-deploy.mjs`, `prod-deploy.test.mjs`                               | One-command ship to live (`deploy`, `rollback`, `status`). See `docs/fork-dev-environment.md`, "Shipping to live". Touches no upstream file.                                                                                         |
| `packages/domain/src/fork/` | The data-source registry and its tests: which data reaches the weekly review, search, memory, MCP, the export and the backup (see `docs/fork-data-sources.md`); `upstream-manifest.txt` and `upstream-hookins.test.ts`, which keep the hook-in table above complete; and `memo-backdate.ts`, the backdating rules `updateMemo` calls (the only file here the app imports). |
| `.claude/settings.json`                                                              | "Ask" rules for every route that can write to live (raw wrangler, `pnpm deploy`, `cf`, the Cloudflare API and MCP write tools, the deploy script's real deploy and rollback). Guarded by `packages/domain/src/fork/guards.test.ts`.       |
| `apps/web/src/health/`                                                               | The tracker's web side: week strip, memo labels, Health page, route, nav link, model, API client, strings, CSS and tests. `health-wiring.test.ts` fails when an upstream sync drops a hook-in.                                                 |
| `packages/domain/src/health/`                                                        | The diary reader (`parse.ts`), sync, read and write services, the after-save hook target, and their tests.                                                                                                                                     |
| `packages/contracts/src/fork-health.ts`                                              | Constants, date helpers and the HTTP schemas.                                                                                                                                                                                                  |
| `packages/db/src/schema/fork-health.ts`, `packages/db/src/health-migrations.test.ts` | The Drizzle mirror of the tables (not in the barrel) and a test that it matches the migration.                                                                                                                                                 |
| `migrations/9010_planner_health.sql`                                                 | The four tables. Hand-written, additive, not in the Drizzle journal.                                                                                                                                                                           |
| `migrations/9012_planner_health_bookmark.sql`                                        | The projection's bookmark: three nullable columns on `health_sync_state`. Hand-written, additive.                                                                                                                                              |
| `apps/worker/src/routes/health-api.ts`, `health-api.test.ts`                         | `/api/app/health-tracker` and its tests.                                                                                                                                                                                                       |
| `docs/fork-health-tracker.md`                                                        | What the tracker reads, the rules, the API and how to undo it.                                                                                                                                                                                 |
| `docs/fork-customizations.md`                                                        | This file.                                                                                                                                                                                                                                     |

## Removed fork code (14 Oct 2026, cleanup wave 1)

Fork code nothing called, removed after a review. Git history keeps all of it; no table or column was dropped.

| What | Where it lives now |
| --- | --- |
| Weekly review model eval (`scripts/fork/review-eval/`) and the A/B test (`scripts/fork/review-ab/`), their docs and the root `@anthropic-ai/sdk` and `@types/node` dev packages | Copied to the project's shared folder, `weekly-review-eval/runner/`, with a README on how to run them from a checkout again. |
| The old project tree: `GET /tree`, `PATCH /tree/:projectId`, `GET /tree/:projectId/rollup`, `packages/domain/src/planner/tree.ts`, the task panel's `project.ancestors`, the web's `plannerFetchTree`, path labels and unused `setProject` | Gone. `planner_project_node` stays, and the history sync still cleans it up for purged projects. Task project links stay; the card menu's Edit… form still sets a project. |
| `PATCH /weeks/:weekStart` (write a week record directly) | Gone. Look back is the only writer of week records. |
| `PUT /api/app/health-tracker/targets` | Gone. `health_target` was empty on live; `GET /targets` returns the defaults. |
| `dev-env.mjs config`, `dev-env.mjs provision --skip-secrets`, `prod-deploy.mjs config` | Gone. `provision`, `clone` and `deploy` write the dev config; `prod-deploy.mjs deploy` writes the prod one. |

## Cockpit rules with one home (15 Oct 2026, sprint 2)

The cockpit's rules used to be written twice, once for the server and once for the web board. Each now has one home that both sides read. All fork-owned files; no upstream file, table or column changed.

| Rule | Its one home | Who reads it |
| --- | --- | --- |
| Which column a card is in, how each column is ordered, what a move to another column does to the status and the plan, the status a new card starts with, the To Do marker | `packages/contracts/src/planner-board.ts`, pinned by one table test, `planner-board.test.ts` | The server's board read (`board.ts`), column move and create (`plans.ts`) through `columns.ts`; the web board's predictions (`board-model.ts`) |
| The period maths (day, week, month, quarter) | `packages/contracts/src/planner-periods.ts`, moved out of `planner.ts` unchanged so `planner-board.ts` can read it without importing `planner.ts` back | Everything that imported it from `@flaremo/contracts`, unchanged |
| How a task edit or a new task is saved: the order of the steps (undrop, upstream fields, column move and place or plan, effort, start date, goal, drop) and every check made before the first write, so a refused request changes nothing | `packages/domain/src/planner/task-change.ts` (`plannerChangeTask`, `plannerAddTask`), tested in `task-change.test.ts` | `PATCH /api/app/planner/tasks/:id` and `POST /api/app/planner/tasks`, which only validate, throttle and pass the request on. `POST` now takes `goal_id`, so the Year map's "Add task" is one request; `goal_error` says when only the link failed. The weekly review's Save week still runs its own steps (on hold). |
| What the screen shows while edits are saving: the last saved copy of each task with every change still in flight on top. A save keeps only the fields that edit owns; a failed save takes back only itself, never a change saved meanwhile or one still in flight. One refresh runs once nothing is in flight | `apps/web/src/planner/task-store.ts`, tested in `task-store.test.ts` and the "two edits in flight at once" tests in `use-planner-actions.test.tsx` | The board and panel edits (`use-planner-actions.ts`), the notes (`task-panel-notes.tsx`) and the comments (`task-panel-comments.tsx`). `plannerDetailWithAnswer`, which replaced the whole panel copy with a save's answer and so could put old notes back, is gone. |

## Undoing a change

**Bring one sidebar entry back.** Delete its line in `forkHiddenSidebarRoutes`. Nothing else needs to change: its `<Link>` block is still in `flaremo-explorer.tsx`. Set `forkOnThisDayBannerHidden` to `false` to bring the banner back. To drop the whole change, revert the three-line hook-in (and the `use-workspace-queries.ts` line) and delete `sidebar-nav.tsx` and its two tests.

**Drop the tag picker.** Revert the hook-in hunks in the five composer files above (the commit titled "scrollable # tag picker with keyboard completion" is exactly those), then delete `tag-picker.ts`, `use-tag-picker.ts`, `use-tag-picker-list.ts` and their tests. Parts can go on their own:

- Back to a six-row list: pass no third argument to `filterTagSuggestions` in `use-composer-suggestions.ts`.
- No keyboard completion: drop `onSuggestionKeyDown={handleSuggestionKeyDown}` from `MemoComposer` and the focus canvas. The list still scrolls and opens where it fits.
- Keep the list above the composer, as upstream does: replace `positionClass` in `use-tag-picker-list.ts` with a constant `"bottom-12"`.

**Product name.** Set `FORK_PRODUCT_NAME` back to `"FlareMo"` (and the static copy listed under "To change the name again") to return to the upstream name in one step. To drop the hook-ins entirely, revert the upstream hunks in the table above, then delete `apps/worker/src/fork/product-name*`, `apps/web/src/fork/product-name*` and `packages/contracts/src/fork-brand.ts`. The i18n hook is the only one that touches every translated string, so revert `i18n.tsx` first.

**Health tracker.** Revert the hook-in rows above marked health, or see [fork-health-tracker.md](fork-health-tracker.md), "Undoing it".

## Upstream sync notes

- **Refresh the change list.** After merging an upstream release, regenerate the manifest from it and fix the hook-in table until the test passes: `FORK_UPSTREAM_MANIFEST_WRITE=upstream/main pnpm exec vitest run packages/domain/src/fork/upstream-hookins.test.ts` (needs the upstream remote fetched).
- **The planner's alarm.** `planner-wiring.test.ts` fails if a merge drops the planner routes, the sidebar link, the SPA paths, the service-worker entries, the contracts re-export or the Playwright pattern.
- **Last sync: upstream v0.22.1 (`0248d53`), 2026-10-14.** It brought a login-page watchdog and a 401 re-check in `authenticated-route.tsx` (neither file has a fork hook-in), version bumps, and a `cf` devDependency (Cloudflare's new CLI) with a `pnpm cf` script. Upstream did not update `pnpm-lock.yaml` for `cf`, so the fork's lockfile was regenerated in the merge. The fork's deploy scripts still use wrangler.
- **The wiring tests are the alarm.** After a merge run `pnpm exec vitest run apps/web/src/fork --config vitest.config.ts`. `sidebar-nav-wiring.test.ts` fails if `flaremo-explorer.tsx` no longer routes its nav through `ForkSidebarNav`, or if a hidden route's `to="…"` link was renamed or removed (the filter would then match nothing, and the entry would quietly come back). `tag-picker-wiring.test.ts` does the same for the composer hook-ins.
- **New upstream sidebar links** show up on their own: only the five routes in the list are filtered. If upstream renames one of them, update `forkHiddenSidebarRoutes` to match.
- **`ComposerTagSuggestions` restyled upstream:** keep their markup and re-apply the fork's attributes (`role`, `aria-selected`, `ref`, `style`, the position class, the mousedown guard). The behaviour lives in `use-tag-picker-list.ts` and does not need to change.
- **The product-name alarm:** `product-name-wiring.test.ts` fails if `i18n.tsx` stops branding its templates, if `branding.tsx` stops using the fork constant, or if the media session stops reading the live product. A new upstream string that says "FlareMo" is not caught automatically: check it against the exclusion list in `apps/web/src/fork/product-name.ts` (a new repo or folder example belongs there). A new hard-coded "FlareMo" in worker copy would show up in a grep for `"FlareMo"` in `apps/worker/src`.
- **The focus canvas's Escape depends on Base UI's dialog.** Its `onOpenChange(open, details)` gets `details.reason === "escape-key"` and `details.cancel()`. Today the editor hears the Escape first and the dialog second, so the list identifies "the Escape the list just used" by the keypress itself. (`defaultPrevented` cannot say that: ProseMirror prevents the default of every Escape.) After a `@base-ui/react` upgrade, run the "Escape in the focus canvas" e2e case.
- **TipTap throws if `editor.view` is read before the view is mounted.** `editorElement()` in `use-tag-picker.ts` is the one place that reads it, and it catches that.
- **The health tracker's alarm.** `pnpm --filter @flaremo/web exec vitest run src/health/health-wiring.test.ts` fails if a merge drops any of the health hook-ins (memo card, timeline, router, sidebar, SPA routes, service worker, Worker mount, nightly sweep, memo save, contracts re-export). The 100+ case parser table in `packages/domain/src/health/parse.test.ts` protects the reading rules.
- **The planner's guard does not cover the health paths.** Its allowlist is planner paths plus `docs/fork-` and `scripts/fork/`. `apps/web/src/health/`, `packages/domain/src/health/`, `packages/db/src/schema/fork-health.ts`, `packages/contracts/src/fork-health.ts`, `migrations/9010_planner_health.sql` and `apps/worker/src/routes/health-api*` will show up in its output. That is expected. To list them on purpose: `git diff --name-only <base>... | grep -E 'health|9010_planner_health'`.
- **The planner's guard.** Section 10 of `planning-cockpit-implementation-plan.md` has a guard command that lists every changed file outside its allowlist: planner paths plus `docs/fork-` and `scripts/fork/`. This file matches `docs/fork-`. The fork-owned `apps/web/src/fork/` files, `tests/e2e/fork-ui.spec.ts` and the hook-ins above are not planner paths, so they will also show up in that guard's output. That is expected; this document is the explanation. Adding `apps/web/src/fork/` and `tests/e2e/fork-ui\.spec\.ts` to the allowlist would silence them, which is an edit for whoever owns that plan.

## Behaviour worth knowing

- **Hover and Enter.** The hovered row is the highlighted row, so after the pointer has travelled over the list, Tab or Enter completes the row under it. A pointer that merely rests there highlights nothing, and neither does a list that scrolls under it.
- **Enter with nothing highlighted** is left to the editor, as before. (At the very start of a note the editor's own markdown handling turns a lone `#` plus Enter into an empty heading; that is the editor, not the picker.)
- **Upstream quirk, left alone:** with the focus canvas open on an empty draft, a lone `#` typed as the first character is wiped. The timeline composer behind it holds the same draft, parses `#` as an empty heading, and writes back an empty string. Typing any text first avoids it. The e2e case for the canvas does.

## Checks

```sh
pnpm exec vitest run apps/web/src/fork apps/web/src/planner/planner-wiring.test.ts apps/web/src/health/health-wiring.test.ts apps/worker/src/fork packages/domain/src/fork packages/domain/src/memo-backdate.test.ts
```

The Playwright spec is registered in the opt-in `memo-ui` project and, like every e2e spec here, is written but not run by the agent that added it (AGENTS.md: e2e is opt-in). When the maintainer asks for it:

```sh
pnpm exec playwright test --project=memo-ui tests/e2e/fork-ui.spec.ts
```

## Planner history archive: durability notes

- **Nightly sync around the purge.** `plannerSyncAllUsers` (fork-owned, `packages/domain/src/planner/history-sync-nightly.ts`) syncs every user in `tasks` or `planner_sync_state` with the debounce skipped (`force: true`), before and after upstream's trash purge. A task created and deleted without the cockpit ever opening now leaves created, its activity, deleted and purged in `planner_task_event`. It never throws and never blocks the purge. If the purge itself throws, the second sync is skipped and the next night (or the next cockpit open) records the purge. Cost: a few indexed reads and one small batch per user per night; no new cron, binding or migration. The sync only runs when `FLAREMO_TRASH_RETENTION_DAYS` is above 0, because the purge sits in that block.
- **Project name.** Events carry `project_name` in `data` (no schema change). It is the name of the project the task was in at the event, looked up when the event is archived. The `project_id` key is not added, because the history labels read it as "project changed". Limit: a project renamed after the event was archived keeps the older name, and an event first archived after its project was purged has no name (the purged event reuses the latest name an earlier event of the task recorded).
- **Title at the time.** An upstream-copied event takes the title of the latest `task_activity` row up to that event that names one (`created` and every rename put `title` in `changes`). With none, the snapshot title (the title at the last sync) applies, then the live title. Limit: a rename made without an activity row (a bundle import, an upstream rebuild) is invisible, so events before it may show the later title. Sync-detected events (`deleted`, `restored`, baseline `created`) use the live title.
