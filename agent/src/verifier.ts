import { hexToBigInt, keccak256, type Hex } from "viem";
import { leafOf, pathFor } from "./merkle.js";
import { ClaimType, Opcode, Quantifier, type BreachProof, type Condition, type DeliveredRecord } from "./types.js";

/** Mirrors PredicateEvaluator.satisfied. No model call, no interpretation. */
export function satisfied(opcode: number, observed: Hex, threshold: Hex): boolean {
  switch (opcode) {
    case Opcode.UINT_GTE:
    case Opcode.TIMESTAMP_GTE:
      return hexToBigInt(observed) >= hexToBigInt(threshold);
    case Opcode.UINT_EQ:
      return hexToBigInt(observed) === hexToBigInt(threshold);
    case Opcode.BYTES32_EQ:
      return observed.toLowerCase() === threshold.toLowerCase();
    default:
      throw new Error(`unknown opcode ${opcode}`);
  }
}

function observedFor(condition: Condition, record: DeliveredRecord): Hex {
  if (condition.requires === ClaimType.RECORD_GENERATION_TIME) {
    return `0x${record.generatedAt.toString(16).padStart(64, "0")}`;
  }
  if (condition.requires === ClaimType.SCHEMA_HASH) return keccak256(record.bytes);
  throw new Error("claim is not a per-record property");
}

export type Violation = { record: DeliveredRecord; observed: Hex };

/**
 * Scalar claims are not counterexample shaped. One row cannot disprove
 * "at least 500 rows", so the count the issuer signed is read directly.
 */
export function evaluateScalar(condition: Condition, leafCount: bigint): { observed: Hex; holds: boolean } {
  if (condition.requires !== ClaimType.ROW_COUNT) throw new Error("claim is not scalar settleable");
  const observed: Hex = `0x${leafCount.toString(16).padStart(64, "0")}`;
  return { observed, holds: satisfied(condition.opcode, observed, condition.threshold) };
}

/**
 * The buyer's agent scans the delivery locally. A universal claim needs only one
 * counterexample, so the scan stops at the first record that breaks it.
 */
export function findFirstViolation(
  records: DeliveredRecord[],
  condition: Condition,
): Violation | null {
  if (condition.quantifier !== Quantifier.UNIVERSAL) return null;
  for (const record of records) {
    if (record.sourceId.toLowerCase() !== condition.expectedSourceId.toLowerCase()) continue;
    const observed = observedFor(condition, record);
    if (!satisfied(condition.opcode, observed, condition.threshold)) return { record, observed };
  }
  return null;
}

export function countViolations(records: DeliveredRecord[], condition: Condition): number {
  let n = 0;
  for (const record of records) {
    if (!satisfied(condition.opcode, observedFor(condition, record), condition.threshold)) n++;
  }
  return n;
}

export function buildBreachProof(
  specHash: Hex,
  condition: Condition,
  levels: Hex[][],
  record: DeliveredRecord,
): BreachProof {
  return {
    specHash,
    conditionId: condition.conditionId,
    index: BigInt(record.index),
    recordBytes: record.bytes,
    generatedAt: record.generatedAt,
    sourceId: record.sourceId,
    merklePath: pathFor(levels, record.index),
  };
}

/** Local sanity check before spending gas. Same walk the contract performs. */
export function proofChecksOut(proof: BreachProof, root: Hex): boolean {
  let node = leafOf(Number(proof.index), keccak256(proof.recordBytes), proof.generatedAt, proof.sourceId);
  for (const sibling of proof.merklePath) {
    const [a, b] = node.toLowerCase() < sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(`0x${a.slice(2)}${b.slice(2)}`);
  }
  return node.toLowerCase() === root.toLowerCase();
}
