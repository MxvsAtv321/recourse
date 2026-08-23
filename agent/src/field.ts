/**
 * The delivery as a field of records, for the presentation.
 *
 * The shape of a partially refreshed feed is the argument slide 10 makes with
 * the sound off: the head of the file is clean, and the breach is real but
 * scattered through the tail rather than sitting in a block at the end. A
 * contiguous stale tail is the one shape a spot check stumbles into by
 * accident, so the interleave is what makes "the first page looks fine"
 * a genuine problem rather than a contrived one.
 *
 * This derives nothing. `partiallyStale` is the same function the seller mock
 * hands to `buildDelivery`, and the onset and the counts come from the captured
 * run. `agrees` reports whether the two still describe the same delivery, and
 * the walkthrough fails if they ever stop doing so.
 */
import { partiallyStale } from "./seller.js";

export type Field = {
  /** One entry per record. True means the record violates the freshness predicate. */
  cells: readonly boolean[];
  total: number;
  violations: number;
  firstViolationIndex: number;
  /** Longest contiguous run of violating records. Four, for this delivery. */
  longestRun: number;
  /** Compliant records after the onset. These are what break up the tail. */
  freshInTail: number;
  /** Whether the derived field still matches the counts the engine recorded. */
  agrees: boolean;
};

export function buildField(scan: {
  totalRecords: number;
  violations: number;
  firstViolationIndex: number;
}): Field {
  const total = scan.totalRecords;
  const onset = scan.firstViolationIndex;

  // The engine's own age offset, with sentinel ages: 1 is stale, 0 is fresh.
  const offsetAt = partiallyStale(0n, 1n, onset);
  const at = typeof offsetAt === "function" ? offsetAt : () => offsetAt;
  const cells: boolean[] = [];
  for (let i = 0; i < total; i++) cells.push(at(i) === 1n);

  let violations = 0;
  let longestRun = 0;
  let run = 0;
  let freshInTail = 0;
  for (let i = 0; i < total; i++) {
    if (cells[i]) {
      violations++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
      if (i >= onset) freshInTail++;
    }
  }
  const firstViolationIndex = cells.indexOf(true);

  return {
    cells,
    total,
    violations,
    firstViolationIndex,
    longestRun,
    freshInTail,
    agrees: violations === scan.violations && firstViolationIndex === onset,
  };
}
