-- Fork (Schizo Diary): a no-op on purpose. Upstream v0.28 drops the Agent
-- Memory tables here (memory_items and its ledger, memory_fts) because upstream
-- removed the memory layer. This fork keeps the memory layer (the weekly review
-- and Ask read and propose memories), so its tables and rows stay. The file
-- keeps upstream's name so D1 records it as applied and a later upstream sync
-- does not bring the drop back. See docs/fork-customizations.md.
SELECT 1;
