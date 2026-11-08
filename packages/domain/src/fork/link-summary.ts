// Fork add-on (docs/fork-link-summaries.md): the source a diary entry carries
// when the general agent wrote it from a link the owner gave. Upstream files
// that must tell such an entry apart from the owner's own writing (memory
// dreaming) import it from here, so their hook-in stays one line.
export {
  plannerLinkSummarySource as FORK_LINK_SUMMARY_SOURCE,
  plannerLinkSummaryTag as FORK_LINK_SUMMARY_TAG,
} from "@flaremo/contracts";
