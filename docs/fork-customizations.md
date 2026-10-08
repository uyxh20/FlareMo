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

## Upstream files with a hook-in

These are the only upstream files changed (`git diff --numstat`, added / removed lines).

| File | Hook-in | Lines |
| --- | --- | --- |
| `apps/web/src/components/flaremo-explorer.tsx` | One import, `<nav` becomes `<ForkSidebarNav`, `</nav>` becomes `</ForkSidebarNav>`. | +3 / -2 |
| `apps/web/src/components/rich-composer-editor.tsx` | New optional `onSuggestionKeyDown` prop (type, destructure, ref) and a call at the very top of `handleKeyDown`, after the IME check and before the early return that hides arrows and Tab from the rest of the handler. When it returns true the editor does nothing else with the key. | +16 |
| `apps/web/src/hooks/use-composer-suggestions.ts` | Passes `FORK_TAG_PICKER_LIMIT` to `filterTagSuggestions`, calls `useTagPicker`, and returns `activeTagIndex`, `setActiveTagIndex`, `handleSuggestionKeyDown`, `claimDialogEscape`; `showTagSuggestions` now comes from the picker. | +24 / -2 |
| `apps/web/src/components/composer/composer-suggestion-lists.tsx` | `ComposerTagSuggestions` only: `activeIndex`, `onActiveIndexChange` and `anchor` props, `useTagPickerList`, listbox and option roles, the highlighted style, the mousedown guard. `ComposerWikiSuggestions` is untouched. | +49 / -4 |
| `apps/web/src/components/memo-composer.tsx` | Passes the picker's keys to the editor, and the highlight to the list. | +6 |
| `apps/web/src/components/composer/composer-focus-canvas.tsx` | The same, plus `anchor="canvas"` and the dialog's `onOpenChange` wrapped in `withTagPickerEscape`. | +13 / -1 |
| `playwright.config.ts` | `fork-ui` added to the `memo-ui` project's `testMatch` alternation. | +1 / -1 |
| `packages/contracts/src/index.ts` | `export * from "./fork-brand";`. | +1 |
| `packages/domain/src/branding.ts` | Imports `FORK_PRODUCT_NAME`; `DEFAULT_FLAREMO_PRODUCT_NAME` equals it. | +2 / -1 |
| `apps/worker/src/auth.ts` | Imports the constant; Better Auth `appName` (the 2FA issuer). | +2 / -1 |
| `apps/worker/src/routes/share-page.ts` | Imports the constant; the unavailable page's fallback name. | +2 / -1 |
| `apps/worker/src/routes/article-page.ts` | Imports the constant; the unavailable page, the page title and the feed title fallbacks. The `generator` meta stays. | +6 / -3 |
| `apps/worker/src/scheduled-tasks.ts` | Imports `resolveProductName`; the two push titles use the live name (only when push is configured). | +4 / -2 |
| `apps/worker/src/email-templates.ts` | `emailCopy` returns `brandCopy(COPY[locale])`, and imports it. | +3 / -1 |
| `apps/worker/src/email.ts` | Imports the constant; the test email's subject and text. | +3 / -2 |
| `apps/web/src/i18n.tsx` | `I18nProvider` reads `useBranding()` and runs `brandTemplate` on each template in `t()` before interpolation. | +7 / -2 |
| `apps/web/src/branding.tsx` | `DEFAULT_BRANDING.product` is the fork constant. | +2 / -1 |
| `apps/web/src/components/reading/reading-audio-provider.tsx` | The media-session artist and album read the live product. | +5 / -3 |
| `apps/web/src/pages/account/integrations-card.tsx` | The email sender placeholder falls back to the fork constant. | +2 / -1 |
| `apps/web/index.html`, `apps/web/public/site.webmanifest`, `apps/web/public/offline.html`, `apps/web/public/sw.js` | Static text: the title, the Apple web-app title, the manifest name and short name, the offline title, the push fallback. | +2 / -2, +2 / -2, +1 / -1, +1 / -1 |
| `apps/worker/src/api/branding.test.ts`, `apps/worker/src/scheduled.test.ts` | Expectations for the default name, plus one case that clearing the custom name restores it. | +19 / -2, +1 / -1 |
| `tests/e2e/branding.spec.ts`, `tests/e2e/capture-flow.spec.ts`, `tests/e2e/capture-webkit.spec.ts` | Expectations for the new name: the login text and the "Save to …" button label. Not run. | +2 / -2, +7 / -7, +1 / -1 |

## Fork-owned files

All new, none in conflict with anything upstream ships.

| File | What it holds |
| --- | --- |
| `apps/web/src/fork/sidebar-nav.tsx` | `forkHiddenSidebarRoutes` and `ForkSidebarNav`. |
| `apps/web/src/fork/tag-picker.ts` | The pure rules: the row limit, the key-to-action reducer (move, accept, close, ignore), the dialog Escape claim, the pointer-travel test, and the placement and height calculation. |
| `apps/web/src/fork/use-tag-picker.ts` | The picker's state: highlight and dismissal per token, the editor-focus gate, key handling, the Escape claim. |
| `apps/web/src/fork/use-tag-picker-list.ts` | What the list does in the DOM: measuring where it opens, keeping the highlighted row in view, lifting the composer above the notes while it is open. |
| `apps/web/src/fork/*.test.ts(x)` | Unit tests for all of the above, plus `sidebar-nav-wiring.test.ts` and `tag-picker-wiring.test.ts`, which fail when an upstream sync drops a hook-in. `test-render.tsx` is their small jsdom helper (not imported by the app). |
| `tests/e2e/fork-ui.spec.ts` | Playwright cases for both changes (see below). |
| `packages/contracts/src/fork-brand.ts` | `FORK_PRODUCT_NAME` (the name) and `UPSTREAM_PRODUCT_NAME` (the word the hook replaces). |
| `apps/worker/src/fork/product-name.ts` | `resolveProductName` (the live name, falling back to the default), `brandText` and `brandCopy` (for the email copy). |
| `apps/worker/src/fork/product-name.test.ts` | Unit tests for the three helpers. |
| `apps/web/src/fork/product-name.ts` | `brandTemplate`, plus the two key lists: `PRODUCT_NAME_EXCLUDED_KEYS` and `STOCK_BRAND_KEYS`. |
| `apps/web/src/fork/product-name.test.ts` | Unit tests for `brandTemplate`, and a check across all eight catalogs that the key lists still match. |
| `apps/web/src/fork/product-name-wiring.test.ts` | Fails when an upstream sync drops the `i18n.tsx`, `branding.tsx` or media-session hook-ins. |
| `docs/fork-customizations.md` | This file. |

## Undoing a change

**Bring one sidebar entry back.** Delete its line in `forkHiddenSidebarRoutes`. Nothing else needs to change: its `<Link>` block is still in `flaremo-explorer.tsx`. To drop the whole change, revert the three-line hook-in and delete `sidebar-nav.tsx` and its two tests.

**Drop the tag picker.** Revert the hook-in hunks in the five composer files above (the commit titled "scrollable # tag picker with keyboard completion" is exactly those), then delete `tag-picker.ts`, `use-tag-picker.ts`, `use-tag-picker-list.ts` and their tests. Parts can go on their own:

- Back to a six-row list: pass no third argument to `filterTagSuggestions` in `use-composer-suggestions.ts`.
- No keyboard completion: drop `onSuggestionKeyDown={handleSuggestionKeyDown}` from `MemoComposer` and the focus canvas. The list still scrolls and opens where it fits.
- Keep the list above the composer, as upstream does: replace `positionClass` in `use-tag-picker-list.ts` with a constant `"bottom-12"`.

**Product name.** Set `FORK_PRODUCT_NAME` back to `"FlareMo"` (and the static copy listed under "To change the name again") to return to the upstream name in one step. To drop the hook-ins entirely, revert the upstream hunks in the table above, then delete `apps/worker/src/fork/product-name*`, `apps/web/src/fork/product-name*` and `packages/contracts/src/fork-brand.ts`. The i18n hook is the only one that touches every translated string, so revert `i18n.tsx` first.

## Upstream sync notes

- **The wiring tests are the alarm.** After a merge run `pnpm exec vitest run apps/web/src/fork --config vitest.config.ts`. `sidebar-nav-wiring.test.ts` fails if `flaremo-explorer.tsx` no longer routes its nav through `ForkSidebarNav`, or if a hidden route's `to="…"` link was renamed or removed (the filter would then match nothing, and the entry would quietly come back). `tag-picker-wiring.test.ts` does the same for the composer hook-ins.
- **New upstream sidebar links** show up on their own: only the three routes in the list are filtered. If upstream renames one of them, update `forkHiddenSidebarRoutes` to match.
- **`ComposerTagSuggestions` restyled upstream:** keep their markup and re-apply the fork's attributes (`role`, `aria-selected`, `ref`, `style`, the position class, the mousedown guard). The behaviour lives in `use-tag-picker-list.ts` and does not need to change.
- **The product-name alarm:** `product-name-wiring.test.ts` fails if `i18n.tsx` stops branding its templates, if `branding.tsx` stops using the fork constant, or if the media session stops reading the live product. A new upstream string that says "FlareMo" is not caught automatically: check it against the exclusion list in `apps/web/src/fork/product-name.ts` (a new repo or folder example belongs there). A new hard-coded "FlareMo" in worker copy would show up in a grep for `"FlareMo"` in `apps/worker/src`.
- **The focus canvas's Escape depends on Base UI's dialog.** Its `onOpenChange(open, details)` gets `details.reason === "escape-key"` and `details.cancel()`. Today the editor hears the Escape first and the dialog second, so the list identifies "the Escape the list just used" by the keypress itself. (`defaultPrevented` cannot say that: ProseMirror prevents the default of every Escape.) After a `@base-ui/react` upgrade, run the "Escape in the focus canvas" e2e case.
- **TipTap throws if `editor.view` is read before the view is mounted.** `editorElement()` in `use-tag-picker.ts` is the one place that reads it, and it catches that.
- **The planner's guard.** Section 10 of `planning-cockpit-implementation-plan.md` has a guard command that lists every changed file outside its allowlist: planner paths plus `docs/fork-` and `scripts/fork/`. This file matches `docs/fork-`. The fork-owned `apps/web/src/fork/` files, `tests/e2e/fork-ui.spec.ts` and the hook-ins above are not planner paths, so they will also show up in that guard's output. That is expected; this document is the explanation. Adding `apps/web/src/fork/` and `tests/e2e/fork-ui\.spec\.ts` to the allowlist would silence them, which is an edit for whoever owns that plan.

## Behaviour worth knowing

- **Hover and Enter.** The hovered row is the highlighted row, so after the pointer has travelled over the list, Tab or Enter completes the row under it. A pointer that merely rests there highlights nothing, and neither does a list that scrolls under it.
- **Enter with nothing highlighted** is left to the editor, as before. (At the very start of a note the editor's own markdown handling turns a lone `#` plus Enter into an empty heading; that is the editor, not the picker.)
- **Upstream quirk, left alone:** with the focus canvas open on an empty draft, a lone `#` typed as the first character is wiped. The timeline composer behind it holds the same draft, parses `#` as an empty heading, and writes back an empty string. Typing any text first avoids it. The e2e case for the canvas does.

## Checks

```sh
pnpm exec vitest run apps/web/src/fork --config vitest.config.ts
```

The Playwright spec is registered in the opt-in `memo-ui` project and, like every e2e spec here, is written but not run by the agent that added it (AGENTS.md: e2e is opt-in). When the maintainer asks for it:

```sh
pnpm exec playwright test --project=memo-ui tests/e2e/fork-ui.spec.ts
```
