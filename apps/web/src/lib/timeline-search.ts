/**
 * The "back to the plain timeline" search state: no filters, no composer.
 *
 * Every entry point that returns to the timeline — the sidebar, the explorer's
 * "all notes" link, and closing the account page — has to clear the same keys.
 * Keeping them in one constant means a key added to the timeline search schema
 * cannot be cleared in two places and forgotten in the third.
 */
export const TIMELINE_SEARCH = {
  view: undefined,
  space: undefined,
  q: undefined,
  tag: undefined,
  untagged: undefined,
  compose: undefined,
};
