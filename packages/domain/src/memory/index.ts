// Memory domain barrel. Preserves the original public surface of the former
// monolithic memory.ts exactly while exposing v2 memory ledger features.

export {
  createMemoryFromMemoInputToWrite,
  createMemoryInputToWrite,
  rememberInputToWrite,
} from "./adapters";
export {
  compileCoreMemory,
  getLatestCompileArchive,
  memoryCompileArchiveToDto,
} from "./compiler";
export {
  collectDreamingSources,
  DAILY_PROPOSAL_QUOTA_DEFAULT,
  DREAMING_AUTO_APPLY_MIN_CONFIDENCE,
  type DreamingCandidate,
  type DreamingConflict,
  type DreamingExtractor,
  type DreamingSource,
  extractAndProposeDreamingFact,
  isImperativeContent,
  isRejectedRecently,
  listRecentRejections,
  proposeDreamingConflicts,
  remainingProposalQuota,
  runDreamingCycle,
} from "./consolidation";
export {
  memoryEventToDto,
  memoryEvidenceToDto,
  memoryRejectionToDto,
  memoryRelationToDto,
  memoryRevisionToDto,
  memoryToDto,
} from "./dto";
export {
  archiveMemory,
  confirmMemory,
  type ForgetMemoryInput,
  forgetMemory,
  hardDeleteMemory,
  lockMemory,
  pinMemory,
  resolveProposal,
  restoreMemory,
  splitMemoryKey,
  unlockMemory,
  unpinMemory,
} from "./lifecycle";
export {
  checkpointMemory,
  type LinkMemoryInput,
  linkMemory,
} from "./link";
export {
  checkEvidenceStaleness,
  expireStaleInferredProposals,
  foldOldRevisions,
  INFERRED_PROPOSAL_TTL_DAYS,
  OBSERVED_DORMANCY_DAYS,
  pruneCompileArchives,
  REVISION_FOLD_THRESHOLD,
  reclaimStaleMemoryVectors,
  runMemoryLedgerMaintenance,
  sinkDormantObservedMemories,
} from "./maintenance";
export {
  createMemoryFromMemo,
  listMemoriesForMemo,
  promoteMemoryToMemo,
} from "./memo-link";
export {
  getMemory,
  getMemoryLineage,
  listMemories,
  listMemoryEvidence,
  listMemoryRelations,
  listMemoryReview,
  listMemoryRevisions,
} from "./query";
export {
  bootstrapMemory,
  MEMORY_BOOTSTRAP_CHAR_BUDGET,
  MEMORY_DEFAULT_BOOTSTRAP_MAX_ITEMS,
  MEMORY_DEFAULT_RECALL_LIMIT,
  MEMORY_MAX_RECALL_LIMIT,
  type RecallMemoriesDeps,
  type RecallMemoriesInput,
  recallMemories,
} from "./recall";
export {
  appendMemoryEvent,
  insertMemoryEvidence,
  MEMORY_MAX_CONTENT_LENGTH,
  type MemoryActor,
  type MemoryEvidenceInput,
  type MemoryWriteInput,
  normalizeFactKey,
  suggestFactKey,
} from "./shared";
export { createMemory, updateMemory } from "./write";
