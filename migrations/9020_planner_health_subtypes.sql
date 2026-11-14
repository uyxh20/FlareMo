-- migrations/9020_planner_health_subtypes.sql: fork-owned, hand-written. Never edit once applied (add 9021_planner_...).
--
-- Sub-types for the owner's own trackers (docs/fork-health-tracker.md, "Families and
-- sub-types"): a tracker such as Fast can have sub-types (16:8, 24 h, OMAD), each with
-- its own words. The health_entry row of a sub-type carries its id in `variant`, a
-- column that already exists, so health_entry does not change.
-- Same rules as 9010: not in migrations/meta/_journal.json, no foreign key, no
-- triggers, additive only.
--
-- Safe for the previous release: one column with a default on a fork table. The old
-- code never reads it and its inserts leave the default, '[]', which means "no
-- sub-types", the way every tracker was before.

-- JSON array of {id, label, words}: id a short random id, label what the app shows,
-- words lower-case words or phrases (a leading # makes a tag).
ALTER TABLE `health_tracker` ADD `subtypes_json` text DEFAULT '[]' NOT NULL;
