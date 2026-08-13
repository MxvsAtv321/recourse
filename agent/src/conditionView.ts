/**
 * Builds the view of a condition that the artifact and the UI consume.
 *
 * Lives outside engine.ts on purpose: engine.ts reads Foundry artifacts and
 * builds chain clients at import time, so anything importing it needs a forge
 * build and a node. This module needs neither, which lets the regression check
 * exercise the real code path rather than a reimplementation of it.
 */
import { thresholdKindFor, type ConditionView } from "./artifact.js";
import { Quantifier, claimTypeName, opcodeName, type Condition } from "./types.js";

export function viewOf(c: Condition, ruleId: string): ConditionView {
  const universal = c.quantifier === Quantifier.UNIVERSAL;
  return {
    conditionId: c.conditionId,
    sourceQuote: c.sourceQuote,
    ruleId,
    claimType: claimTypeName(c.requires),
    quantifier: universal ? "UNIVERSAL" : "SCALAR",
    opcode: opcodeName(c.opcode),
    threshold: BigInt(c.threshold).toString(),
    // Derived from the opcode, never the quantifier: a SCHEMA_HASH condition is
    // UNIVERSAL but its threshold is a digest, not a time.
    thresholdKind: thresholdKindFor(opcodeName(c.opcode)),
    permittedIssuer: c.permittedIssuer,
    expectedSourceId: c.expectedSourceId,
    settlement: universal ? "one counterexample" : "direct evaluation at release",
    protectedByRule: true,
  };
}
