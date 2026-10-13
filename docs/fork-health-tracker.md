# Health tracker

A fork add-on (not in upstream FlareMo). It reads the owner's diary notes and turns the ones that mention a workout, breath work or a night out into small structured rows, so the timeline can show a week strip and label chips and a Health page can count them against targets.

The diary stays the source of truth. A note is never changed by the tracker. The rows can always be rebuilt from the notes with **Re-read diary**.

Everything here is in the fork's own files. The upstream files carry only a few one-line hook-ins, listed in [fork-customizations.md](fork-customizations.md), "Health tracker".

## What it reads

A note is read at save time and again by a nightly safety net (see "Keeping it in step"). The reader is a pure, deterministic function (`packages/domain/src/health/parse.ts`); nothing is sent to a model.

| Kind        | What it looks for                                                                                                                                              | Row holds                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `training`  | A gym, CrossFit, push, pull, back, chest, legs, upper-body or cardio session that was done                                                                      | `variant`, optional `minutes` (cardio), optional `feel` word    |
| `breath`    | Wim Hof or meditation, with minutes when given (10 when not)                                                                                                    | `variant` (`wim_hof`, `meditation`), `minutes`                  |
| `night_out` | A night out, with the time the owner got home when the note says one                                                                                           | `home_at`, `units`, `bender`, `needs_check`                     |

A plan is not a session: "tomorrow gym", "going to the gym later" and "no gym today" produce nothing. A note with a skip tag (`vault-summary`, `vault-theme`, `vault-thinking`, `vault-tracker`, `seed`, `agent-memory`), one written by the weekly review, or one longer than 1500 characters is never read. A note of 300 to 1500 characters is read only when it carries an explicit tag or a "done" word next to the keyword.

### Which day a note belongs to

Days are local days in `Europe/Copenhagen` (`FORK_HEALTH_TIME_ZONE`), computed with `Intl`, not the machine's zone. A training or breath note belongs to the day it was written. A night belongs to the day the evening **started**:

- "tonight", "this evening", or a note written from 14:00 on belongs to that day;
- "last night", "yesterday", or a note written before 14:00 belongs to the day before;
- a weekday name ("Friday night") belongs to the most recent such weekday.

A leading timestamp such as `[2026-10-09 23:40]` is stripped before reading.

### Night units

The unit is decided by when the owner got home:

| Home                                         | Units           | Notes                       |
| -------------------------------------------- | --------------- | --------------------------- |
| Before 00:00                                 | 0               | A social evening, not counted |
| 00:00 to 02:59                               | 0.5             |                             |
| 03:00 to 05:59                               | 1               |                             |
| 06:00 or later, or "morning", or a bender    | 1               | `bender = true`             |

A bare hour 7 to 11 after "til" or "until" is taken as the evening (`til 9` is 21:00). A note with a night out but no time and no bender gets `needs_check = true` and `units = null`: it is shown as a dashed ring, and the chip asks "home when?".

## Data

Created by `migrations/9010_planner_health.sql` (hand-written, additive, not in the Drizzle journal, no foreign keys to upstream tables, like the planner's `9NNN` files). The Drizzle mirror is `packages/db/src/schema/fork-health.ts`, which is deliberately **not** in the schema barrel.

| Table                | Holds                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `health_entry`       | One row per memo and kind (a unique partial index enforces it). `deleted_at` and `dismissed` are soft; `edited` marks an owner's hand edit. |
| `health_entry_event` | Append-only history, written in the same D1 batch as each row change.                                                   |
| `health_target`      | The owner's targets. Defaults when empty: training 3 a week, breath 7 a week, night out 12 units a year.                |
| `health_sync_state`  | The marker that the first full read of the diary happened.                                                              |

All four are in `RESTORE_TABLES` in `scripts/persistence-manifest.mjs`, so backups and restores include them (`pnpm persistence:check`).

History is never hard-deleted. A memo that goes to the trash soft-deletes its rows; a memo that comes back restores them. A label the owner removes with the x is `dismissed` and stays removed whatever the note says later. A row the owner fixed by hand (`edited`) keeps the owner's values on re-reads.

## Keeping it in step

1. **On save.** `createMemo` and `updateMemo` call `forkHealthSyncMemo(db, id)` after the write. It catches every error: a missing table logs one warning per isolate, anything else is logged, and **a memo save never fails because of the tracker**.
2. **Nightly.** `healthNightlySweep`, called from the scheduled task, re-reads the last 3 days and soft-deletes rows whose memo is gone.
3. **First use.** The first request to the API reads the whole diary once (`healthEnsureScanned`, claimed with an insert-or-ignore marker so two requests cannot both do it).
4. **By hand.** `POST /rescan`, or the **Re-read diary** button, reads every note again. It leaves dismissed and edited rows alone.

## API

Mounted at `/api/app/health-tracker` (not `/api/app/health`, which is upstream's instance-info endpoint). Cookie session or PAT, same Origin rules as the rest of `/api/app/*`. Contracts are in `packages/contracts/src/fork-health.ts`; routes in `apps/worker/src/routes/health-api.ts`.

| Method and path            | Does                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /week?start=`         | Seven days (the last seven when `start` is absent): entries and a summary against targets. |
| `GET /year?year=`          | The year: per-day cells, night-out budget and pace, totals, nights that need a check.      |
| `GET /memos?ids=a,b,c`     | The labels of up to 100 memos in one request (the timeline's batch).                       |
| `PATCH /entries/:id`       | Fix a row: `home_at`, `variant`, `minutes` or `day`. Marks it `edited`.                    |
| `POST /entries/:id/dismiss`| Remove a label.                                                                            |
| `POST /rescan`             | Read the whole diary again. Returns counts of notes read and rows created, changed, removed.|
| `GET /targets`, `PUT /targets` | Read and set the targets.                                                              |

## What shows in the app

All in `apps/web/src/health/`, English only (the strings are in `strings.ts`, not in the eight upstream catalogs, so a sync never conflicts on them).

- **Week strip** above the timeline (only on the unfiltered "all" view): three rows (Training, Breath, Out) by seven days. A filled dot is something done, a half dot is half a unit, a dashed ring is a night still needing a home time, a hairline ring is a night home before midnight. The right-hand column is the count against the week's target (Out shows year units against the year budget). The strip is a link to the Health page.
- **Chips** under a memo card, for example `Gym · Back`, `Wim Hof · 10 min`, `Night out · Fri · home 03:30 · 1`. The x removes the label. A night without a time shows **home when?** and four buttons: Before 00:00, 00-03, 03-06, Morning, which set the home time to 23:30, 01:30, 04:30 and 08:00. All cards on a page get their labels through one request.
- **/health** (sidebar link "Health"): the last 7 days against the targets, the night-out budget with the year's pace, the list of nights that need a home time, the year as three rows of weekly cells, and the Re-read diary button.

Colours are the CSS variables `--health-training`, `--health-breath` and `--health-out` (with light and dark values) in `health.css`.

## Tests

```sh
pnpm exec vitest run packages/domain/src/health packages/db/src/health-migrations.test.ts apps/worker/src/routes/health-api.test.ts
pnpm --filter @flaremo/web exec vitest run src/health
pnpm persistence:check
```

`apps/web/src/health/health-wiring.test.ts` is the upstream-sync alarm: it fails when a merge drops one of the hook-ins. The parser's 100+ case table (`parse.test.ts`) uses invented sentences only.

## Undoing it

1. Revert the hook-in lines listed in [fork-customizations.md](fork-customizations.md), "Health tracker". The app then looks as before; the API and rows are untouched and unused.
2. To also remove the code, delete `apps/web/src/health/`, `packages/domain/src/health/`, `packages/db/src/schema/fork-health.ts`, `packages/db/src/health-migrations.test.ts`, `packages/contracts/src/fork-health.ts`, `apps/worker/src/routes/health-api*.ts`, and the four table names from `RESTORE_TABLES`.
3. The tables stay in D1 (migrations are additive and the tracker's history is never dropped for you). If the data is truly unwanted, drop `health_entry_event`, `health_entry`, `health_target` and `health_sync_state` by hand after a backup.
