/**
 * witness:check.
 *
 * Emits the BreachWitnessSpec for the claim that was actually signed into the
 * terms, then checks the proof that settled against it, field by field, and
 * recomputes the witnessId from what the chain recorded.
 *
 * No chain, no network, no model. The executed proof is read from the captured
 * run artifact, which is the record of what the escrow did.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { showSourced, type Sourced } from "../evidence.js";
import { protect } from "../inspect.js";
import { MEASURED, OBLIGOR, PERMITTED_ISSUER, RECOURSE_COMMITMENT } from "../fixtures/evidence.js";
import {
  NEGATION,
  canonicalise,
  checkProof,
  provenanceOf,
  synthesise,
  witnessIdOf,
  type ExecutedProof,
  type Opcode,
  type SynthesisInput,
} from "../witness.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const W = 78;
const rule = (c = "-") => console.log(c.repeat(W));
const head = (s: string) => {
  console.log("");
  rule("=");
  console.log(s);
  rule("=");
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const run = JSON.parse(readFileSync(join(ROOT, "ui", "data", "run.json"), "utf8"));
const cond = run.protectedPurchase.conditions[0];
const scan = run.protectedPurchase.scan;
const commitment = run.protectedPurchase.commitment;
const settlement = run.protectedPurchase.settlement;

const POLICY = { permittedIssuer: PERMITTED_ISSUER, expectedSourceId: "COINBASE_ETH_USD_FEED" };
const OFFER = "ETH-USD spot feed, 500 records per delivery, upstream signed";

// ------------------------------------------------------------------ 1

head("1  THE CLAIM THAT WAS SIGNED, COMPILED BEFORE PAYMENT");

// The requirement is the phrase carried in the signed terms, not a phrase chosen
// here. Compiling it is what produces the Sourced threshold.
const REQUIREMENT: string = cond.sourceQuote;
console.log(`\n  requirement, from the signed terms   "${REQUIREMENT}"`);

const manifest = protect(REQUIREMENT, OFFER, POLICY, MEASURED, { ctx: { obligor: OBLIGOR } });
if (manifest.status !== "PROTECTED") {
  console.error("the signed requirement must compile");
  process.exit(1);
}
const mc = manifest.claims[0];
const finding = mc.finding;
console.log(`  finding                             ${finding.verdict}`);
check("the claim compiles to ENFORCEABLE", finding.verdict === "ENFORCEABLE");
if (finding.verdict !== "ENFORCEABLE") process.exit(1);
console.log(`  settles by                          ${finding.settlesBy}`);
console.log(`  the artifact that reached gate 4    ${finding.artifact}`);

const test = mc.claim.test;
if (test.op !== "AT_OR_AFTER") {
  console.error("expected a relative freshness test");
  process.exit(1);
}

const input: SynthesisInput = {
  conditionId: cond.conditionId,
  claimType: cond.claimType,
  quantifier: cond.quantifier,
  opcode: cond.opcode as Opcode,
  thresholdAbsolute: cond.threshold,
  thresholdSourced: mc.threshold as Sourced<number>,
  thresholdSeconds: test.seconds,
  permittedIssuer: cond.permittedIssuer,
  expectedSourceId: cond.expectedSourceId,
  artifact: RECOURSE_COMMITMENT,
};

// ------------------------------------------------------------------ 2

head("2  THE BREACH WITNESS SPEC");

const spec = synthesise(input);
const prov = provenanceOf(input);

const row = (k: string, v: string) => console.log(`  ${k.padEnd(22)} ${v.padEnd(30)} <- ${prov[k] ?? ""}`);
console.log("");
row("conditionId", String(spec.conditionId));
row("claimType", spec.claimType);
row("quantifier", spec.quantifier);
row("falsifier.op", spec.falsifier.op);
row("falsifier.negates", spec.falsifier.negates);
row("falsifier.reads", spec.falsifier.reads);
row("threshold.absolute", spec.threshold.absolute);
row("threshold.seconds", String(spec.threshold.seconds));
row("threshold.sourced", `${spec.threshold.sourced.value}  ${showSourced(spec.threshold.sourced)}`);
row("requiredBinding", spec.requiredBinding);
row("requiredArtifactId", spec.requiredArtifactId);
row("permittedIssuer", spec.permittedIssuer);
row("expectedSourceId", `${spec.expectedSourceId.slice(0, 22)}...`);
console.log("");
console.log(`  canonical serialisation  ${canonicalise(spec).length} hex chars of ABI encoded fields`);
console.log(`  witnessId                ${spec.witnessId}`);
console.log(`  recomputed from the body ${witnessIdOf(spec)}`);
console.log("");
console.log(`  in words: a record at any index whose ${spec.falsifier.reads} is strictly less than`);
console.log(`  ${spec.threshold.absolute}, carried in a leaf bound by ${spec.requiredBinding}, under a`);
console.log(`  commitment signed by ${spec.permittedIssuer}`);

check("every field is present", Object.keys(prov).length >= 13);
check("the witnessId is a keccak256 digest", /^0x[0-9a-f]{64}$/.test(spec.witnessId));
check("  and is a pure function of the fields above", witnessIdOf(spec) === spec.witnessId);
check("the sourced threshold carries an exact span of the requirement", spec.threshold.sourced.from === "REQUIREMENT");
check(
  "  and that span re-derives from the signed phrase",
  spec.threshold.sourced.from !== "POLICY" &&
    REQUIREMENT.slice(spec.threshold.sourced.span[0], spec.threshold.sourced.span[1]) === spec.threshold.sourced.quote,
  spec.threshold.sourced.from !== "POLICY" ? JSON.stringify(spec.threshold.sourced.quote) : "",
);

// ------------------------------------------------------------------ 3

head("3  THE FALSIFIER IS A NEGATION, NOT A RESTATEMENT");

console.log("");
console.log("  the complete negation table, one entry per opcode:");
for (const [op, neg] of Object.entries(NEGATION)) console.log(`    ${op.padEnd(16)} -> ${neg}`);
console.log("");
console.log(`  the claim asserts    every record: ${spec.falsifier.reads} ${spec.falsifier.negates} ${spec.threshold.absolute}`);
console.log(`  a witness asserts    one record:   ${spec.falsifier.reads} ${spec.falsifier.op} ${spec.threshold.absolute}`);
// The two vocabularies are disjoint union types, so tsc rejects this comparison
// outright as having no overlap. That is a stronger statement than the runtime
// check below: a falsifier cannot be a restatement of an opcode even by mistake.
check(
  "the falsifier is not the claim's own opcode",
  (spec.falsifier.op as string) !== (spec.falsifier.negates as string),
  "tsc rejects the comparison too: FalsifierOp and Opcode are disjoint",
);
check("  it is the entry the negation table gives for that opcode", spec.falsifier.op === NEGATION[spec.falsifier.negates]);
check(
  "  the claim is universal and the witness is a single record",
  spec.quantifier === "UNIVERSAL",
  "one counterexample is enough, so the witness is existential",
);
check(
  "the four on-chain opcodes are unchanged",
  Object.keys(NEGATION).join(",") === "UINT_GTE,UINT_EQ,TIMESTAMP_GTE,BYTES32_EQ",
  "the falsifier vocabulary describes a witness and never executes",
);

// ------------------------------------------------------------------ 4

head("4  THE PROOF THAT SETTLED, CHECKED AGAINST THAT SPEC");

const executed: ExecutedProof = {
  index: run.protectedPurchase.proof.index,
  offendingIndex: settlement.offendingIndex,
  observed: scan.observedAt,
  thresholdAt: scan.thresholdAt,
  conditionId: cond.conditionId,
  claimType: cond.claimType,
  quantifier: cond.quantifier,
  sourceId: commitment.sourceId,
  issuer: commitment.issuer,
  leafFormula: commitment.leafFormula,
};

console.log(`\n  refund transaction   ${settlement.txHash}`);
console.log(`  offending index      ${executed.offendingIndex}`);
console.log(`  verdict              ${settlement.verdict}`);
console.log("");
const checks = checkProof(spec, executed);
for (const c of checks) {
  console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.field}`);
  console.log(`          spec      ${c.spec}`);
  console.log(`          executed  ${c.executed}`);
}
console.log("");
check("the proof at index 187 satisfies every field of the spec", checks.every((c) => c.passed));
check("  and the index checked is 187", executed.index === "187" && executed.offendingIndex === "187");

// ------------------------------------------------------------------ 5

head("5  THE WITNESSID, RECOMPUTED FROM WHAT THE CHAIN RECORDED");

// Rebuilt from the condition as it was signed and the commitment as it was
// recovered on chain, not from the object synthesised above. Seven of the nine
// fields come from that record; requiredBinding and requiredArtifactId name the
// artifact class the commitment is, which the chain does not carry as a string.
const rebuilt = synthesise({
  conditionId: cond.conditionId,
  claimType: cond.claimType,
  quantifier: cond.quantifier,
  opcode: cond.opcode as Opcode,
  thresholdAbsolute: cond.threshold,
  thresholdSourced: mc.threshold as Sourced<number>,
  thresholdSeconds: test.seconds,
  permittedIssuer: commitment.issuer,
  expectedSourceId: commitment.sourceId,
  artifact: RECOURSE_COMMITMENT,
});

console.log(`\n  from the compiled claim, before payment   ${spec.witnessId}`);
console.log(`  from the signed condition and commitment ${rebuilt.witnessId}`);
console.log("");
console.log("  fields taken from the on-chain record:");
console.log(`    conditionId        ${cond.conditionId}`);
console.log(`    claimType          ${cond.claimType}`);
console.log(`    quantifier         ${cond.quantifier}`);
console.log(`    opcode             ${cond.opcode}`);
console.log(`    threshold          ${cond.threshold}`);
console.log(`    permittedIssuer    ${commitment.issuer}   recovered from the commitment signature`);
console.log(`    expectedSourceId   ${commitment.sourceId.slice(0, 22)}...   from the stored commitment`);
check("the recomputed witnessId matches", spec.witnessId === rebuilt.witnessId);
check(
  "  so the thing enforced is the thing specified",
  spec.witnessId === rebuilt.witnessId && checks.every((c) => c.passed),
);

const tampered = synthesise({ ...input, thresholdAbsolute: String(BigInt(cond.threshold) - 1n) });
console.log(`\n  a spec whose threshold is one second different: ${tampered.witnessId}`);
check("  a different spec gives a different witnessId", tampered.witnessId !== spec.witnessId);

// ------------------------------------------------------------------ 6

head("6  A CLAIM THAT DOES NOT COMPILE EMITS NO SPEC");

for (const phrase of ["high quality investment research", "every record must be recent"]) {
  const m = protect(phrase, OFFER, POLICY, MEASURED, { ctx: { obligor: OBLIGOR } });
  const verdict = m.status === "PROTECTED" ? m.claims[0].finding.verdict : "REFUSED";
  const emitted = m.status === "PROTECTED" && m.claims[0].finding.verdict === "ENFORCEABLE";
  console.log(`\n  "${phrase}"`);
  console.log(`    status   ${m.status}`);
  if (m.status === "REFUSED") for (const mm of m.missing) console.log(`    missing ${mm.dimension.padEnd(10)} ${mm.why}`);
  console.log(`    spec emitted: ${emitted ? "yes" : "none"}`);
  check(`  no spec for "${phrase.slice(0, 34)}"`, !emitted, verdict);
}

console.log("\n  There is no path from a refusal to a spec: synthesise is only reached when");
console.log("  a finding is ENFORCEABLE, and it throws for any claim type a bound leaf");
console.log("  cannot observe.");
try {
  synthesise({ ...input, claimType: "BLOB_EXISTENCE_TIME" });
  check("  synthesise refuses a claim type no leaf can observe", false, "it returned a spec");
} catch (e) {
  check("  synthesise refuses a claim type no leaf can observe", true, (e as Error).message.slice(0, 62));
}

// ------------------------------------------------------------------

head("SUMMARY");
if (failures.length === 0) {
  console.log("  all checks passed");
  rule("=");
  process.exit(0);
}
console.log(`  ${failures.length} FAILED`);
for (const f of failures) console.log(`    ${f}`);
rule("=");
process.exit(1);
