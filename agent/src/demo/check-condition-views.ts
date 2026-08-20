/**
 * Guards the compiled conditions, not just their labels.
 *
 * Three classes of regression are covered.
 *
 * 1. MEANING. A compiled condition must be SATISFIED by data that genuinely
 *    conforms to the phrase, and VIOLATED by data that does not. Both
 *    directions, through the real verifier.
 *
 *    This is the check that was missing. `every record matches schema "..."`
 *    compiled a threshold that was keccak256 of the schema DESCRIPTOR, while
 *    the settlement path observes keccak256 of the RECORD. The two are never
 *    equal for a conforming record, so every honest row was a valid
 *    counterexample and the escrow refunded against a good delivery. The old
 *    check asserted only that the threshold was LABELLED "hash", which it
 *    correctly was, so it stayed green while the condition was meaningless.
 *    A threshold and an observed value that are not comparable quantities now
 *    fail here.
 *
 * 2. SETTLEABILITY. Every emitted condition must be one the escrow will
 *    actually open, mirroring _establishedByBoundLeaves and _scalarSettleable
 *    in contracts/src/RecourseEscrow.sol. A rule that emits a condition the
 *    contract refuses is a compiler that promises protection nothing can honour.
 *
 * 3. LABEL. thresholdKind must be a function of the opcode alone. Deriving it
 *    from the quantifier printed a digest threshold as a date.
 *
 * Every rule the compiler exposes must have a case here, and every retired
 * phrase must still compile to nothing. Adding a rule without a conformance
 * pair fails this check rather than passing silently.
 *
 * Needs no forge build and no node: it imports the compiler, the verifier and
 * the real view builder, none of which touch the chain.
 */
import { thresholdKindFor, type ThresholdKind } from "../artifact.js";
import { viewOf } from "../conditionView.js";
import { compileListing, supportedRuleIds } from "../compiler.js";
import { SOURCE_ID, buildDelivery } from "../seller.js";
import { evaluateScalar, findFirstViolation } from "../verifier.js";
import { ClaimType, Opcode, Quantifier, claimTypeName, opcodeName, type Condition } from "../types.js";

const NOW = 1_760_000_000n;
const CTX = {
  now: NOW,
  permittedIssuer: "0x0000000000000000000000000000000000000001" as const,
  expectedSourceId: SOURCE_ID,
};

/** Mirrors RecourseEscrow._establishedByBoundLeaves. */
const establishedByBoundLeaves = (claim: number) => claim === ClaimType.RECORD_GENERATION_TIME;

/** Mirrors RecourseEscrow._scalarSettleable. */
const scalarSettleable = (claim: number, opcode: number) =>
  claim === ClaimType.ROW_COUNT && (opcode === Opcode.UINT_GTE || opcode === Opcode.UINT_EQ);

type Case = {
  ruleId: string;
  phrase: string;
  claim: number;
  quantifier: number;
  kind: ThresholdKind;
  /**
   * Runs the real verifier over data built by the real seller. Returns whether
   * a conforming delivery satisfies the condition and whether a delivery that
   * breaks the phrase is caught. Both must be true.
   */
  probe: (c: Condition) => { conformingHolds: boolean; nonConformingBreaks: boolean };
};

const CASES: Case[] = [
  {
    ruleId: "record-freshness-hours",
    phrase: "every record generated within the last 1 hour",
    claim: ClaimType.RECORD_GENERATION_TIME,
    quantifier: Quantifier.UNIVERSAL,
    kind: "timestamp",
    probe: (c) => ({
      // Records made a minute ago are inside a one hour window.
      conformingHolds: findFirstViolation(buildDelivery(4, NOW, 60n), c) === null,
      // Yesterday's records are not.
      nonConformingBreaks: findFirstViolation(buildDelivery(4, NOW, 26n * 3600n), c) !== null,
    }),
  },
  {
    ruleId: "record-freshness-minutes",
    phrase: "every record generated within the last 30 minutes",
    claim: ClaimType.RECORD_GENERATION_TIME,
    quantifier: Quantifier.UNIVERSAL,
    kind: "timestamp",
    probe: (c) => ({
      conformingHolds: findFirstViolation(buildDelivery(4, NOW, 60n), c) === null,
      nonConformingBreaks: findFirstViolation(buildDelivery(4, NOW, 3600n), c) !== null,
    }),
  },
  {
    ruleId: "row-count-at-least",
    phrase: "at least 500 records",
    claim: ClaimType.ROW_COUNT,
    quantifier: Quantifier.SCALAR,
    kind: "count",
    probe: (c) => ({
      conformingHolds: evaluateScalar(c, 500n).holds,
      nonConformingBreaks: !evaluateScalar(c, 499n).holds,
    }),
  },
  {
    ruleId: "row-count-exactly",
    phrase: "exactly 500 records",
    claim: ClaimType.ROW_COUNT,
    quantifier: Quantifier.SCALAR,
    kind: "count",
    probe: (c) => ({
      conformingHolds: evaluateScalar(c, 500n).holds,
      nonConformingBreaks: !evaluateScalar(c, 499n).holds,
    }),
  },
];

/**
 * Phrases that must compile to nothing.
 *
 * The schema phrase is here rather than in CASES because the rule that used to
 * match it was cut: the leaf binds the digest of a record and a schema is the
 * digest of a shape, so no threshold over the leaf could express it. The opcode
 * set does not grow to fit a term, so the term became UNPROTECTABLE.
 */
const RETIRED_PHRASES = [
  'every record matches schema "pair,seq,priceE8"',
  "every record matches schema \"anything at all\"",
  "high quality investment reports",
];

let failed = 0;
const fail = (msg: string) => {
  console.error(`FAIL  ${msg}`);
  failed++;
};
const pass = (msg: string) => console.log(`PASS  ${msg}`);

// ------------------------------------------------------------------ 0. coverage
{
  const declared = new Set(supportedRuleIds());
  const covered = new Set(CASES.map((c) => c.ruleId));
  for (const id of declared) {
    if (!covered.has(id)) fail(`rule "${id}" has no conformance case in this check`);
  }
  for (const id of covered) {
    if (!declared.has(id)) fail(`case "${id}" names a rule the compiler no longer exposes`);
  }
  if (declared.size === covered.size && [...declared].every((id) => covered.has(id))) {
    pass(`every one of the ${declared.size} compiler rules has a conformance case`);
  }
}

// ------------------------------------------------- 1, 2, 3. per rule
for (const c of CASES) {
  const compiled = compileListing([c.phrase], CTX)[0];
  if (!compiled.protectable) {
    fail(`"${c.phrase}" no longer compiles to a condition`);
    continue;
  }
  const cond = compiled.condition;
  const view = viewOf(cond, compiled.ruleId);

  if (compiled.ruleId !== c.ruleId) fail(`"${c.phrase}" matched rule ${compiled.ruleId}, expected ${c.ruleId}`);
  if (cond.requires !== c.claim) fail(`${c.ruleId}: claim is ${claimTypeName(cond.requires)}`);
  if (cond.quantifier !== c.quantifier) fail(`${c.ruleId}: wrong quantifier`);
  if (view.thresholdKind !== c.kind) fail(`${c.ruleId}: thresholdKind ${view.thresholdKind}, expected ${c.kind}`);

  // The phrase that created the condition stays attached to it.
  if (cond.sourceQuote !== c.phrase) fail(`${c.ruleId}: sourceQuote drifted from the phrase`);

  // 2. Settleability, mirroring the contract's open-time screen.
  const settleable =
    cond.quantifier === Quantifier.UNIVERSAL
      ? establishedByBoundLeaves(cond.requires)
      : scalarSettleable(cond.requires, cond.opcode);
  if (!settleable) {
    fail(`${c.ruleId}: emits a condition openPurchase would refuse as unsettleable`);
  }

  // 1. Meaning. The check that would have caught the schema mismatch.
  const { conformingHolds, nonConformingBreaks } = c.probe(cond);
  if (!conformingHolds) {
    fail(
      `${c.ruleId}: CONFORMING data violates the condition. ` +
        `The threshold and the observed value are not comparable quantities.`,
    );
  }
  if (!nonConformingBreaks) {
    fail(`${c.ruleId}: data that breaks the phrase does not violate the condition`);
  }

  if (conformingHolds && nonConformingBreaks && settleable) {
    console.log(
      `PASS  ${c.ruleId.padEnd(24)} ${claimTypeName(cond.requires).padEnd(23)}` +
        `${cond.quantifier === Quantifier.UNIVERSAL ? "UNIVERSAL" : "SCALAR   "} ` +
        `${opcodeName(cond.opcode).padEnd(14)} -> ${view.thresholdKind}  ` +
        `[conforming holds, breach caught, settleable]`,
    );
  }
}

// ------------------------------------------------------------- retired phrases
for (const phrase of RETIRED_PHRASES) {
  const compiled = compileListing([phrase], CTX)[0];
  if (compiled.protectable) {
    fail(`"${phrase}" compiles to a condition again; it must be UNPROTECTABLE`);
  } else {
    pass(`UNPROTECTABLE  "${phrase}"`);
  }
}

// --------------------------------------------- 3. the label cannot track the quantifier
{
  const synthetic = (opcode: number, quantifier: number): Condition => ({
    conditionId: 1,
    requires: ClaimType.RECORD_GENERATION_TIME,
    quantifier,
    opcode,
    threshold: `0x${"11".repeat(32)}`,
    permittedIssuer: CTX.permittedIssuer,
    expectedSourceId: SOURCE_ID,
    sourceQuote: "synthetic",
  });

  let stable = true;
  const kinds = new Set<ThresholdKind>();
  for (const opcode of Object.values(Opcode)) {
    const asUniversal = viewOf(synthetic(opcode, Quantifier.UNIVERSAL), "synthetic").thresholdKind;
    const asScalar = viewOf(synthetic(opcode, Quantifier.SCALAR), "synthetic").thresholdKind;
    const expected = thresholdKindFor(opcodeName(opcode));
    kinds.add(expected);
    if (asUniversal !== expected || asScalar !== expected) {
      fail(`${opcodeName(opcode)}: thresholdKind varies with the quantifier (${asUniversal} vs ${asScalar})`);
      stable = false;
    }
  }
  if (stable) {
    pass(
      `thresholdKind is a function of the opcode alone across all ${Object.keys(Opcode).length} opcodes, ` +
        `spanning ${[...kinds].sort().join(", ")}`,
    );
  }
}

console.log(failed ? `\n${failed} failed` : "\nall condition checks passed");
process.exit(failed ? 1 : 0);
