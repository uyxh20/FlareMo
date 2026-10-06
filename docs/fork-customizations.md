# Fork customizations

This fork (`uyxh20/FlareMo`) merges upstream (`realchendahuang/FlareMo`) regularly. This file lists what the owner asked for that upstream does not do: what each change is and why, which upstream files carry a hook-in, which files are fork-owned, how to undo each change, and what to watch for on an upstream sync.

One rule runs through every change: **logic goes in fork-owned files under `apps/web/src/fork/`, and an upstream file gets only the smallest wiring that calls into them.** Upstream diffs stay at a few lines per file, and a merge conflict is easy to read.

The planning cockpit is a separate fork add-on with its own document: [planning-cockpit-implementation-plan.md](planning-cockpit-implementation-plan.md).

## What is customized, and why

### 1. Three sidebar entries are hidden

The owner does not use **Team projects** (`/team-projects`), **Projects** (`/projects`) or **Articles** (`/articles`), so their links are gone from the sidebar. On phones the sidebar is the drawer, which is the same component, so they are gone there too.

- The routes still work by URL.
- Nothing else moves: the ⌘K search, the notification bell, the "N overdue" link in the mini calendar and the Cockpit link are unchanged.
- `flaremo-explorer.tsx` keeps every `<Link>` block. Its `<nav>` becomes `ForkSidebarNav`, which forwards every prop and every child except an element whose `to` prop is in `forkHiddenSidebarRoutes`. Conditional children (`{cond && <Link/>}`) and other components (the Cockpit link) pass through untouched.

## Upstream files with a hook-in

These are the only upstream files changed (`git diff --numstat`, added / removed lines).

| File | Hook-in | Lines |
| --- | --- | --- |
| `apps/web/src/components/flaremo-explorer.tsx` | One import, `<nav` becomes `<ForkSidebarNav`, `</nav>` becomes `</ForkSidebarNav>`. | +3 / -2 |
| `playwright.config.ts` | `fork-ui` added to the `memo-ui` project's `testMatch` alternation. | +1 / -1 |

## Fork-owned files

All new, none in conflict with anything upstream ships.

| File | What it holds |
| --- | --- |
| `apps/web/src/fork/sidebar-nav.tsx` | `forkHiddenSidebarRoutes` and `ForkSidebarNav`. |
| `apps/web/src/fork/sidebar-nav.test.tsx`, `sidebar-nav-wiring.test.ts` | The filter's unit tests, and a source-level test that fails when an upstream sync drops the hook-in or renames one of the three links. |
| `tests/e2e/fork-ui.spec.ts` | Playwright cases (see below). |
| `docs/fork-customizations.md` | This file. |

## Undoing a change

**Bring one sidebar entry back.** Delete its line in `forkHiddenSidebarRoutes`. Nothing else needs to change: its `<Link>` block is still in `flaremo-explorer.tsx`. To drop the whole change, revert the three-line hook-in and delete `sidebar-nav.tsx` and its two tests.

## Upstream sync notes

- **The wiring test is the alarm.** After a merge run `pnpm exec vitest run apps/web/src/fork --config vitest.config.ts`. `sidebar-nav-wiring.test.ts` fails if `flaremo-explorer.tsx` no longer routes its nav through `ForkSidebarNav`, or if a hidden route's `to="…"` link was renamed or removed (the filter would then match nothing, and the entry would quietly come back).
- **New upstream sidebar links** show up on their own: only the three routes in the list are filtered. If upstream renames one of them, update `forkHiddenSidebarRoutes` to match.
- **The planner's guard.** Section 10 of `planning-cockpit-implementation-plan.md` has a guard command that lists every changed file outside its allowlist: planner paths plus `docs/fork-` and `scripts/fork/`. This file matches `docs/fork-`. The fork-owned `apps/web/src/fork/` files, `tests/e2e/fork-ui.spec.ts` and the hook-in above are not planner paths, so they will also show up in that guard's output. That is expected; this document is the explanation. Adding `apps/web/src/fork/` and `tests/e2e/fork-ui\.spec\.ts` to the allowlist would silence them, which is an edit for whoever owns that plan.

## Checks

```sh
pnpm exec vitest run apps/web/src/fork --config vitest.config.ts
```

The Playwright spec is registered in the opt-in `memo-ui` project and, like every e2e spec here, is written but not run by the agent that added it (AGENTS.md: e2e is opt-in). When the maintainer asks for it:

```sh
pnpm exec playwright test --project=memo-ui tests/e2e/fork-ui.spec.ts
```
