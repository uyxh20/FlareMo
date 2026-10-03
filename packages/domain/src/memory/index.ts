// Memory domain barrel. Preserves the original public surface of the former
// monolithic memory.ts exactly; internal helpers (shared.ts internals, dto
// mappers) are intentionally not re-exported.

export {
  createMemoryFromMemoInputToWrite,
  createMemoryInputToWrite,
  rememberInputToWrite,
} from "./adapters";
export { memoryToDto } from "./dto";
export {
  archiveMemory,
  confirmMemory,
  type ForgetMemoryInput,
  forgetMemory,
  hardDeleteMemory,
  lockMemory,
  unlockMemory,
} from "./lifecycle";
export {
  checkpointMemory,
  type LinkMemoryInput,
  linkMemory,
} from "./link";
export {
  createMemoryFromMemo,
  listMemoriesForMemo,
  promoteMemoryToMemo,
} from "./memo-link";
export {
  getMemory,
  getMemoryLineage,
  listMemories,
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
export { MEMORY_MAX_CONTENT_LENGTH, type MemoryActor } from "./shared";
export { createMemory, updateMemory } from "./write";
