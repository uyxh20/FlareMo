import {
  type HealthEntryKind,
  type HealthTrackerDto,
  healthIsBuiltinKind,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { healthFetchTrackers } from "./api";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";

// The owner's trackers on the client (fork-owned add-on,
// docs/fork-health-tracker.md, "Trackers"): one cached list that the chips, the
// strip and the Health page all read, so a tracker's name and colour are the
// same everywhere.

export function useHealthTrackers() {
  return useQuery({
    queryKey: healthQueryKeys.trackers,
    queryFn: healthFetchTrackers,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The owner's own (not built-in) trackers of a list, in order. */
export function healthOwnTrackers(
  trackers: readonly HealthTrackerDto[] | undefined,
): HealthTrackerDto[] {
  return (trackers ?? []).filter((tracker) => !tracker.builtin);
}

/** The colour class of a kind: `health-kind-training`, or a tracker's colour. */
export function healthKindClass(
  kind: HealthEntryKind,
  trackers: readonly HealthTrackerDto[] | undefined,
): string {
  if (healthIsBuiltinKind(kind)) return `health-kind-${kind}`;
  const color = trackers?.find((tracker) => tracker.kind === kind)?.color;
  return `health-kind-t-${color ?? "slate"}`;
}

/** A kind's name: the built-in label, or the tracker's own. */
export function healthKindLabel(
  kind: HealthEntryKind,
  trackers: readonly HealthTrackerDto[] | undefined,
): string {
  if (healthIsBuiltinKind(kind)) return healthStrings.kind[kind];
  return (
    trackers?.find((tracker) => tracker.kind === kind)?.label ??
    healthStrings.trackers.unknown
  );
}
