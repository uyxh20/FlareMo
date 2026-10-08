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
| `docs/fork-customizations.md` | This file. |

## Undoing a change

**Bring one sidebar entry back.** Delete its line in `forkHiddenSidebarRoutes`. Nothing else needs to change: its `<Link>` block is still in `flaremo-explorer.tsx`. To drop the whole change, revert the three-line hook-in and delete `sidebar-nav.tsx` and its two tests.

**Drop the tag picker.** Revert the hook-in hunks in the five composer files above (the commit titled "scrollable # tag picker with keyboard completion" is exactly those), then delete `tag-picker.ts`, `use-tag-picker.ts`, `use-tag-picker-list.ts` and their tests. Parts can go on their own:

- Back to a six-row list: pass no third argument to `filterTagSuggestions` in `use-composer-suggestions.ts`.
- No keyboard completion: drop `onSuggestionKeyDown={handleSuggestionKeyDown}` from `MemoComposer` and the focus canvas. The list still scrolls and opens where it fits.
- Keep the list above the composer, as upstream does: replace `positionClass` in `use-tag-picker-list.ts` with a constant `"bottom-12"`.

## Upstream sync notes

- **The wiring tests are the alarm.** After a merge run `pnpm exec vitest run apps/web/src/fork --config vitest.config.ts`. `sidebar-nav-wiring.test.ts` fails if `flaremo-explorer.tsx` no longer routes its nav through `ForkSidebarNav`, or if a hidden route's `to="…"` link was renamed or removed (the filter would then match nothing, and the entry would quietly come back). `tag-picker-wiring.test.ts` does the same for the composer hook-ins.
- **New upstream sidebar links** show up on their own: only the three routes in the list are filtered. If upstream renames one of them, update `forkHiddenSidebarRoutes` to match.
- **`ComposerTagSuggestions` restyled upstream:** keep their markup and re-apply the fork's attributes (`role`, `aria-selected`, `ref`, `style`, the position class, the mousedown guard). The behaviour lives in `use-tag-picker-list.ts` and does not need to change.
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
