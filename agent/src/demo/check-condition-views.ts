/**
 * Guards the threshold labelling.
 *
 * thresholdKind used to be derived from the quantifier, which made a
 * SCHEMA_HASH condition (UNIVERSAL, but with a keccak threshold) render as a
 * date. This walks every supported rule shape through the real compiler and
 * asserts the kind the UI will use, so the mislabel cannot come back through
 * either the compiler or the derivation.
 */
import type { ThresholdKind } from "../artifact.js";
import { viewOf } from "../conditionView.js";
import { compileListing } from "../compiler.js";
import { SOURCE_ID } from "../seller.js";
import { ClaimType, Quantifier, claimTypeName, opcodeName } from "../types.js";

const CASES: { phrase: string; claim: number; quantifier: number; kind: ThresholdKind }[] = [
  {
    phrase: "every record generated within the last 1 hour",
    claim: ClaimType.RECORD_GENERATION_TIME,
    quantifier: Quantifier.UNIVERSAL,
    kind: "timestamp",
  },
  {
    phrase: "at least 500 records",
    claim: ClaimType.ROW_COUNT,
    quantifier: Quantifier.SCALAR,
    kind: "count",
  },
  {
    // The regression case: UNIVERSAL, so a quantifier-derived kind would say
    // "timestamp" and the panel would print a digest as a date.
    phrase: 'every record matches schema "pair,seq,priceE8"',
    claim: ClaimType.SCHEMA_HASH,
    quantifier: Quantifier.UNIVERSAL,
    kind: "hash",
  },
];

let failed = 0;
for (const c of CASES) {
  const compiled = compileListing([c.phrase], {
    now: 1_760_000_000n,
    permittedIssuer: "0x0000000000000000000000000000000000000001",
    expectedSourceId: SOURCE_ID,
  })[0];

  if (!compiled.protectable) {
    console.error(`FAIL  "${c.phrase}" no longer compiles to a condition`);
    failed++;
    continue;
  }
  const cond = compiled.condition;
  // Through the real viewOf, so a regression in engine's view building is caught too.
  const kind = viewOf(cond, compiled.ruleId).thresholdKind;
  const ok = cond.requires === c.claim && cond.quantifier === c.quantifier && kind === c.kind;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${claimTypeName(cond.requires).padEnd(23)} ` +
      `${cond.quantifier === Quantifier.UNIVERSAL ? "UNIVERSAL" : "SCALAR   "} ` +
      `${opcodeName(cond.opcode).padEnd(14)} -> ${kind}${ok ? "" : `  (expected ${c.kind})`}`,
  );
}

// A UNIVERSAL condition must not automatically mean a timestamp threshold.
const universalKinds = new Set(CASES.filter((c) => c.quantifier === Quantifier.UNIVERSAL).map((c) => c.kind));
if (universalKinds.size < 2) {
  console.error("FAIL  the UNIVERSAL cases no longer cover more than one threshold kind");
  failed++;
} else {
  console.log(`PASS  UNIVERSAL spans ${[...universalKinds].join(" and ")}, so the kind cannot track the quantifier`);
}

console.log(failed ? `\n${failed} failed` : "\nall threshold kinds correct");
process.exit(failed ? 1 : 0);
