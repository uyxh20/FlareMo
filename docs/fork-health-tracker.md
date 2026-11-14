# Health tracker

A fork add-on (not in upstream FlareMo). It reads the owner's diary notes and turns the ones that mention a workout, breath work or a night out into small structured rows, so the timeline can show a week strip and label chips and a Health page can count them.

The diary stays the source of truth. A note is never changed by the tracker. The rows can always be rebuilt from the notes with **Re-read diary**.

Everything here is in the fork's own files. The upstream files carry only a few one-line hook-ins, listed in [fork-customizations.md](fork-customizations.md), "Health tracker".

## What it reads

A note is read at save time and again by a nightly safety net (see "Keeping it in step"). The reader is a pure, deterministic function (`packages/domain/src/health/parse.ts`); nothing is sent to a model.

| Kind | What it looks for | Row holds |
| --- | --- | --- |
| `training` | A gym, CrossFit, push, pull, back, chest, legs, upper-body, cardio (run, ride, swim, zone 2) or mobility (yoga, stretching, pilates, with `#fitness`, a time or a done word) session that was done | `variant`, optional `minutes` (cardio, mobility), optional `feel` word |
| `breath` | Wim Hof, meditation or breathwork (`#breath`, box breathing, pranayama), with minutes when given (10 when not). Two of them in one note make one row of both (`wim_hof+meditation`, minutes summed) | `variant` (`wim_hof`, `meditation`, `breathwork`, or two joined by `+`), `minutes` |
| `wellness` | Sauna (also banya), steam room or hammam, cold plunge, ice bath, massage or spa that was done. Needs `#fitness` (or `#sauna`) in the note, a duration, a done word, or a short note (four words or fewer) | `variant` (`sauna`, `steam`, `cold_plunge`, `ice_bath`, `massage`, `spa`), optional `minutes` |
| `night_out` | A night out, with the time the owner got home when the note says one | `home_at`, `units`, `bender`, `needs_check` |

`#fitness` is the training tag (it replaced `#gym` on 13 Nov 2026; `#gym` still reads the same). A `#fitness` note about only sauna, steam room, hammam, banya, cold plunge, ice bath, massage or spa, with no training word, is wellness, not a training session: it gets a `wellness` row and no `training` row. "#fitness legs, then cold plunge" gets both. One wellness row per note (the first kind named). Wellness has no target and never counts toward training (added 13 Nov 2026, option A of the labels mock).

A plan is not a session: "tomorrow gym", "going to the gym later" and "no gym today" produce nothing. A note with a skip tag (`vault-summary`, `vault-theme`, `vault-thinking`, `vault-tracker`, `seed`, `agent-memory`), one written by the weekly review, or one longer than 1500 characters is never read. A note of 300 to 1500 characters is read only when it carries an explicit tag or a "done" word next to the keyword.

### Trackers you edit in the app

The **Trackers** section of the Health page lists every tracker as a pill. Opening one shows the words it looks for, and **New tracker** adds one for a new habit (fasting, cold plunges…) with no code change.

- **Your own tracker**: a name, one of six colours, what it counts (days, days + minutes, or days + hours), the words and #tags that count, the words that never count, its sub-types (each a name and its own words), and the goal it feeds. There is no target on a tracker: the target lives on the goal it links to.
- **A built-in** (Fitness, which opens Gym and Wellness; Breath; Out): its fixed reader stays as described above and is shown greyed out. You can add extra words, used only when the fixed reader found nothing in that note, and block words: a note containing a blocked word never counts for that tracker.

Your words are read with the same care as the built-in keywords: a plan ("tomorrow I'll start fasting") or a denial ("no fasting today") does not count, a long note needs a #tag or a done word, "yesterday" moves the day back, and a #tag also matches the note's own tag. Hours come from "16h", "18 hours" or an eating window such as "16:8"; minutes from "20 min".

**Test a sentence** (folded away until opened) says whether a sentence would count and why not. **Preview changes** (shown only once something changed) reads the whole diary with the new words and says how many entries would start or stop counting, without writing anything. **Apply** saves the tracker and re-reads the diary: labels you removed or fixed by hand stay as you left them. Removing a tracker archives it; its rows are soft-deleted by the re-read, never hard-deleted. Every save is kept in `health_tracker_event`.

New trackers show as a tile in this week, a row in the year grid and the week strip, and as chips on notes (`Fasting · 16 h`). A tracker linked to a goal also shows on that goal's card on the Goals page, counted over the goal's period up to today (`Fasting · 9 days so far · avg 16 h`); the goal's own words hold the target. The weekly review reads every tracker too (see below).

### Families and sub-types (14 Nov 2026)

Every tracker works the same way: a **family** is a row everywhere, and its **sub-types** are a detail. Nothing extra is stored for the built-ins: the sub-type is worked out from a row's kind and values (`healthSubtypesOf` in `fork-health.ts`).

| Family | Sub-types | From |
| --- | --- | --- |
| Fitness | Gym (with the split as detail: Back, Push…), CrossFit, Cardio, Mobility, Wellness (with Sauna, Cold plunge… as detail) | `training` and `wellness` rows |
| Breath | Wim Hof, Meditation, Breathwork | `breath` variant |
| Out | Social (home before midnight), Late (½), Big night (1), Bender, Home time? | `night_out` home time, units and bender |
| Your own tracker | The sub-types you give it, each with its own words | `variant` = the sub-type's id |

A tracker's sub-type words also count for the tracker. The row's sub-type is the first one whose word is in the counted sentence; with none, the row has no sub-type. Sub-types are stored in `health_tracker.subtypes_json` (`migrations/9020_planner_health_subtypes.sql`), at most 8 per tracker, each `{id, label, words}`; renaming one keeps its rows (the id stays).

On screen the four families (Fitness, Breath, Out, then your trackers) are the only rows: the week strip, the tiles, the year grid and the Trackers pills. Sub-types show on a dot's tooltip ("Fri · Gym · Back") and in a pop-up when you tap a row's name, a tile or a year square. Labels read family first: `Fitness · Gym · Back`, `Breath · Wim Hof · 10 min`, `Out · Fri · Big night · home 03:30`, `Fast · 16:8 · 16 h`.

### Which day a note belongs to

Days are local days in `Europe/Copenhagen` (`FORK_HEALTH_TIME_ZONE`), computed with `Intl`, not the machine's zone. A training or breath note belongs to the day it was written. A night belongs to the day the evening started. The exact rules (day words, weekday names, the cut-off hour, and the stripping of a leading timestamp) are defined by the `CASES` table in `packages/domain/src/health/parse.test.ts`, with the `healthLocalMoment` and `healthStripTimestampPrefix` tests beside it. Read that table, not this page, when in doubt.

### Night units

The unit is decided by when the owner got home:

| Home | Units | Notes |
| --- | --- | --- |
| Before 00:00 | 0 | A social evening, not counted |
| 00:00 to 02:59 | 0.5 |  |
| 03:00 to 05:59 | 1 |  |
| 06:00 or later, or "morning", or a bender | 1 | `bender = true` |

A bare hour 7 to 11 after "til" or "until" is taken as the evening (`til 9` is 21:00). A note with a night out but no time and no bender gets `needs_check = true` and `units = null`: it is shown as a dashed ring, and the chip asks "home when?".

## Data

Created by `migrations/9010_planner_health.sql`, `9011_planner_health_trackers.sql` and `9020_planner_health_subtypes.sql` (hand-written, additive, not in the Drizzle journal, no foreign keys to upstream tables, like the planner's `9NNN` files). The Drizzle mirror is `packages/db/src/schema/fork-health.ts`, which is deliberately **not** in the schema barrel.

| Table | Holds |
| --- | --- |
| `health_entry` | One row per memo and kind (a unique partial index enforces it). A row the diary missed can also be added by hand: `source: manual`, no `memo_id`, `edited`; only the diary agent's accepted proposal does that today (`healthCreateEntry`), and the diary read never touches it. The diary agent's accepted `remove` proposal goes through the same dismiss as the x (`healthDismissEntry`), and its Undo restores the row with a `restore` event. `deleted_at` and `dismissed` are soft; `edited` marks an owner's hand edit. |
| `health_entry_event` | Append-only history, written in the same D1 batch as each row change. |
| `health_target` | The owner's targets. Defaults when empty: training 3 a week, breath 7 a week, night out 12 units a year. Empty on live (counted 14 Oct 2026); the route that set it was removed, and the table is kept. |
| `health_sync_state` | The marker that the first full read of the diary happened, plus the bookmarks (migration 9012): where an unfinished full read stopped, who is running it, and where an unfinished nightly read stopped. |
| `health_tracker` | The owner's trackers (`migrations/9011_planner_health_trackers.sql`): kind `t:<id>` or a built-in kind, name, colour, what it counts, words and blocked words (JSON), sub-types (JSON, `9020`), linked goal (`planner_goal.id` by value), `archived_at`. |
| `health_tracker_event` | Append-only history of every save of a tracker, written in the same batch. |

All six are in `RESTORE_TABLES` in `scripts/persistence-manifest.mjs`, so backups and restores include them (`pnpm persistence:check`).

History is never hard-deleted. A memo that goes to the trash soft-deletes its rows; a memo that comes back restores them. A label the owner removes with the x is `dismissed` and stays removed whatever the note says later. A row the owner fixed by hand (`edited`) keeps the owner's values on re-reads.

## Keeping it in step

All of this is one module, the health projection (`packages/domain/src/health/sync.ts`). It has two ways in: one note (after a save) and many notes (`projectPages`, behind everything else). The many-notes walk pages through the diary on a (time, id) key, so notes written in the same second are never skipped, and saves a bookmark in `health_sync_state` after every page, so a read that is cut off (CPU or time limit, a deploy) carries on where it stopped.

1. **On save.** `createMemo` and `updateMemo` call `forkHealthSyncMemo(db, id)` after the write. It catches every error: a missing table logs one warning per isolate, anything else is logged, and **a memo save never fails because of the tracker**.
2. **Nightly.** `healthNightlySweep`, called from the scheduled task, per user: finishes a full read that was cut off (or starts one for a diary never read), re-reads every note changed in the last 3 days, and soft-deletes rows whose note is gone. Each walk reads at most 5 pages (2,000 notes) a night; the rest carries on from its bookmark the next night instead of being dropped.
3. **First use.** The first request to the API reads the whole diary (`healthEnsureScanned`). A claim with a timestamp stops two requests reading at once; a claim older than 5 minutes is a run that died, and the next request finishes its read from the bookmark.
4. **By hand.** `POST /rescan`, or the **Re-read diary** button, reads every note again from the start. It leaves dismissed and edited rows alone.

A race between two writers for the same note is retried once; D1's "UNIQUE constraint" reason sits in the error's `cause`, which the retry check reads (`healthErrorText`).

## API

Mounted at `/api/app/health-tracker` (not `/api/app/health`, which is upstream's instance-info endpoint). Cookie session or PAT, same Origin rules as the rest of `/api/app/*`. Contracts are in `packages/contracts/src/fork-health.ts`; routes in `apps/worker/src/routes/health-api.ts`.

| Method and path | Does |
| --- | --- |
| `GET /week?start=` | Seven days (the last seven when `start` is absent; the app asks for this week's Monday): entries and a summary. The summary still carries the default targets, which only the weekly review reads (on hold). |
| `GET /year?year=` | The year: per-day cells (with `subtypes`, rows per `family:sub-type`), night-out budget and pace, totals, nights that need a check. |
| `GET /memos?ids=a,b,c` | The labels of up to 100 memos in one request (the timeline's batch). |
| `PATCH /entries/:id` | Fix a row: `home_at`, `variant`, `minutes` or `day`. Marks it `edited`. |
| `POST /entries/:id/dismiss` | Remove a label. |
| `POST /rescan` | Read the whole diary again. Returns counts of notes read and rows created, changed, removed. |
| `GET /targets` | Read the targets (always the defaults: nothing sets them any more). |
| `GET /goals` | Each tracker linked to a goal, counted over the goal's period up to today. |
| `GET /trackers` | Every tracker: the three built-ins first, then the owner's own. |
| `POST /trackers` | A new tracker; re-reads the diary and returns the trackers and what changed. |
| `PUT /trackers/:id` | Save a tracker (a built-in id takes only `words` and `blocked`); re-reads the diary. |
| `DELETE /trackers/:id` | Archive a tracker; re-reads the diary. |
| `POST /trackers/preview` | What a draft would change across the whole diary. Writes nothing. |
| `POST /trackers/test` | Whether one sentence counts for a draft, and why not. |

## What shows in the app

All in `apps/web/src/health/`, English only (the strings are in `strings.ts`, not in the eight upstream catalogs, so a sync never conflicts on them).

- **Week strip** above the timeline (only on the unfiltered "all" view): one row per family by seven days: Fitness (any day with gym or wellness), Breath, Out, then your own trackers. A filled dot is something done, a half dot is half a unit, a dashed ring is a night still needing a home time, a hairline ring is a night home before midnight. A dot's tooltip names the sub-type. The right-hand column is the days (nights for Out) with a row this week. Tapping a row's name opens its sub-types in a pop-up; tapping anywhere else opens the Health page. There are no targets (Q05, 15 Oct 2026). The strip and the page share one request (`useHealthThisWeek`).
- **Chips** under a memo card, family first, for example `Fitness · Gym · Back`, `Fitness · CrossFit`, `Fitness · Sauna · 20 min`, `Breath · Wim Hof · 10 min`, `Out · Fri · Big night · home 03:30`, `Fast · 16:8 · 16 h`. The x removes the label. A night without a time shows **home when?** and four buttons: Before 00:00, 00-03, 03-06, Morning, which set the home time to 23:30, 01:30, 04:30 and 08:00. All cards on a page get their labels through one request.
- **/health** (sidebar link "Health"): this week's tiles, one per family (Fitness days with "Gym 3 · Wellness 1" under it, Breath days, Out units, your trackers), each opening its sub-types in a pop-up, the year's nights out (a count of nights; units are no longer shown on this card) and, beside them, the days since the last night out with a strip of one small grey square per day (squares at least 10px wide, wrapping into new rows, capped at 6 rows; past that it shows only the most recent days and says so, `since-strip.tsx`; nights, benders and the pace line left this card on 11 Nov 2026), the list of nights that need a home time, the year as rows of weekly cells (Fitness, Breath, Out, then your own trackers; tap a name for the year's sub-types, a square for that week's), and the Re-read diary button.

**The weekly review** reads the reviewed week's rows and totals (Monday to Sunday, local days) into every Look back prompt: what was done on which day, the targets, bender nights, nights still needing a check and the year's night-out units. Each of the owner's own trackers gets a line too: its days (and hours or minutes) that week, and, when it is linked to a goal, how far it has got in that goal's period. It reads them through `healthReadWeek`, so it counts exactly what the /health page counts. The change history (`health_entry_event`) is not read. See [planning-cockpit-goals-review.md](planning-cockpit-goals-review.md).

Colours are the CSS variables `--health-training` (Fitness, wellness included), `--health-breath`, `--health-wellness` (no longer used on screen) and `--health-out` (with light and dark values) in `health.css`.

## Tests

```sh
pnpm exec vitest run packages/domain/src/health packages/db/src/health-migrations.test.ts apps/worker/src/routes/health-api.test.ts
pnpm --filter @flaremo/web exec vitest run src/health
pnpm persistence:check
```

`apps/web/src/health/health-wiring.test.ts` is the upstream-sync alarm: it fails when a merge drops one of the hook-ins. The parser's 100+ case table (`parse.test.ts`) uses invented sentences only.

## Undoing it

1. Revert the hook-in lines listed in [fork-customizations.md](fork-customizations.md), "Health tracker". The app then looks as before; the API and rows are untouched and unused.
2. To also remove the code, delete `apps/web/src/health/`, `packages/domain/src/health/`, `packages/db/src/schema/fork-health.ts`, `packages/db/src/health-migrations.test.ts`, `packages/contracts/src/fork-health.ts`, `apps/worker/src/routes/health-api*.ts`, and the six table names from `RESTORE_TABLES`.
3. The tables stay in D1 (migrations are additive and the tracker's history is never dropped for you). If the data is truly unwanted, drop `health_entry_event`, `health_entry`, `health_target` and `health_sync_state` by hand after a backup.
