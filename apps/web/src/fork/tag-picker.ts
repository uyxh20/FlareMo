// Fork-owned (docs/fork-customizations.md). The "#" list offers every matching
// tag, not upstream's first six; the list scrolls. Since upstream v0.26 the
// list itself (keyboard highlight, scrolling, placement under the caret,
// Escape) is upstream's, so this is the fork's only tag-picker hook-in.

/** How many tags the "#" list may offer: effectively all of them. */
export const FORK_TAG_PICKER_LIMIT = 500;
