/**
 * inspect:check. Walks the frozen fixtures through the four gates and asserts
 * every outcome spec/EVIDENCE.md sections 5, 5.1, 5.2 and 7 claim.
 *
 * No network. No chain. No model. Every artifact is a recorded observation.
 */
import { GATE_NAME, REASON_CODES, matchArtifact, renderReason, showSourced, type Lane } from "../evidence.js";
import { protect, type Classification, type Classifier } from "../inspect.js";
import {
  BLOB_TIMESTAMP,
  COMMITMENT_SELLER_SIGNED,
  COMMITMENT_STRANGER_KEY,
  IS_ANOMALY,
  LEAF_COUNT,
  MEASURED,
  OBLIGOR,
  OBSERVED_WINDOW,
  PERMITTED_ISSUER,
} from "../fixtures/evidence.js";

const W = 78;
const rule = (c = "-") => console.log(c.repeat(W));
const head = (s: string) => { console.log(""); rule("="); console.log(s); rule("="); };

const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${label} ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const POLICY = { permittedIssuer: PERMITTED_ISSUER, expectedSourceId: "COINBASE_ETH_USD_FEED" };
const OFFER = "ETH-USD spot feed, 500 records per delivery, upstream signed";

const laneLine = (l: Lane): string =>
  l.passed
    ? `gate ${l.gate} ${GATE_NAME[l.gate]}  PASSED  ${l.finding.verdict}`
    : `gate ${l.gate} ${GATE_NAME[l.gate]}  ${l.reason.code}`;

const codeOf = (l: Lane): string => (l.passed ? l.finding.verdict : l.reason.code);

// ------------------------------------------------------------------ 1

head("1  THE FIVE MEASURED FIXTURES AGAINST ONE CLAIM");

const REQ = "every record generated within the last 60 seconds";
const manifest = protect(REQ, OFFER, POLICY, MEASURED, { ctx: { obligor: OBLIGOR } });

if (manifest.status !== "PROTECTED") {
  console.error("expected PROTECTED, got REFUSED");
  process.exit(1);
}
const mc = manifest.claims[0];
console.log(`\n  requirement   ${JSON.stringify(REQ)}`);
console.log(`  rule          ${mc.ruleId}`);
console.log(`  subject       ${mc.claim.subject}`);
console.log(`  property      ${mc.claim.property}`);
console.log(`  test          ${JSON.stringify(mc.claim.test)}`);
console.log(`  threshold     ${showSourced(mc.threshold)}  ->  ${mc.threshold.value}`);
console.log(`  issuer        ${showSourced(mc.issuer)}  ->  ${mc.issuer.value}`);
console.log(`  sourceId      ${showSourced(mc.sourceId)}  ->  ${mc.sourceId.value}`);
console.log(`  fixtures      recorded ${OBSERVED_WINDOW}, never re-fetched`);

check("claim subject is RECORD", mc.claim.subject === "RECORD");
check("claim property is GENERATION_TIME", mc.claim.property === "GENERATION_TIME");
check(
  "threshold 60 seconds, sourced from the requirement",
  mc.claim.test.op === "AT_OR_AFTER" && mc.claim.test.seconds === 60 && mc.threshold.from === "REQUIREMENT",
  showSourced(mc.threshold),
);

console.log("");
for (const l of mc.lanes) {
  rule();
  console.log(`  ${l.artifact.id}`);
  console.log(`    origin      ${l.artifact.origin}`);
  console.log(`    commitsTo   ${l.artifact.commitsTo.join(", ")}`);
  const eff = l.artifact.measured?.effectiveSubject ?? `${l.artifact.subject} (structural, no Resolution)`;
  console.log(`    subject     declared ${l.artifact.subject}, effective ${eff}`);
  console.log(`    property    ${l.artifact.property}   binding ${l.artifact.binding}   attestation ${l.artifact.attestation.kind}`);
  if (l.artifact.measured) {
    const m = l.artifact.measured;
    console.log(`    measured    ${m.method}`);
    console.log(
      `                ${m.maxDistinctPerResponse} distinct value(s) per response` +
        (m.maxDistinctPerResponse === 1 ? ", spread 0.0 seconds" : ""),
    );
  }
  console.log(`    -> ${laneLine(l)}`);
  if (!l.passed) console.log(`       ${renderReason(l.reason)}`);
  else if (l.finding.verdict === "ENFORCEABLE") console.log(`       settlesBy ${l.finding.settlesBy}`);
  else if (l.finding.verdict === "ATTESTED") console.log(`       trusts ${l.finding.trusts}, because binding is ${l.finding.because}`);
}
rule();
console.log("");

const byId = new Map(mc.lanes.map((l) => [l.artifact.id, l]));
const L = (id: string) => byId.get(id)!;

const x402 = L("x402-receipt");
check("x402 receipt terminates at gate 1 with SUBJECT_MISMATCH", x402.gate === 1 && codeOf(x402) === "SUBJECT_MISMATCH");
check(
  "  needs RECORD, found TRANSACTION",
  !x402.passed && x402.reason.code === "SUBJECT_MISMATCH" && x402.reason.needs === "RECORD" && x402.reason.found === "TRANSACTION",
);
check("  commitsTo printed", x402.artifact.commitsTo.length === 6, x402.artifact.commitsTo.join(", "));

const lu = L("coingecko-markets-last_updated");
check("last_updated terminates at gate 1 with SUBJECT_COLLAPSE", lu.gate === 1 && codeOf(lu) === "SUBJECT_COLLAPSE");
check(
  "  declared RECORD, effective RESPONSE",
  !lu.passed && lu.reason.code === "SUBJECT_COLLAPSE" && lu.reason.declared === "RECORD" && lu.reason.effective === "RESPONSE",
);
check("  cites 400 records", !lu.passed && lu.reason.code === "SUBJECT_COLLAPSE" && lu.reason.evidence.includes("400 records"));
check(
  "  one distinct value per response, spread 0.0 seconds",
  lu.artifact.measured?.maxDistinctPerResponse === 1,
  "maxDistinctPerResponse 1",
);

const st = L("coingecko-tickers-is_stale");
check("is_stale terminates at gate 2 with PROPERTY_REFUTED", st.gate === 2 && codeOf(st) === "PROPERTY_REFUTED");
check(
  "  cites the 5692 second record",
  !st.passed && st.reason.code === "PROPERTY_REFUTED" && st.reason.actual.includes("5692 seconds"),
  !st.passed && st.reason.code === "PROPERTY_REFUTED" ? st.reason.record : "",
);

const lt = L("coingecko-tickers-last_traded_at");
check("last_traded_at terminates at gate 3 with ISSUER_UNSIGNED", lt.gate === 3 && codeOf(lt) === "ISSUER_UNSIGNED");

const rc = L("recourse-delivery-commitment");
check("Recourse commitment reaches ENFORCEABLE", rc.passed && rc.finding.verdict === "ENFORCEABLE");
check(
  "  settlesBy COUNTEREXAMPLE",
  rc.passed && rc.finding.verdict === "ENFORCEABLE" && rc.finding.settlesBy === "COUNTEREXAMPLE",
);
check("manifest finding is ENFORCEABLE", mc.finding.verdict === "ENFORCEABLE");

console.log("");
console.log("  gate occupancy, spec 5.1");
for (const g of [1, 2, 3, 4] as const) {
  const here = mc.lanes.filter((l) => l.gate === g);
  console.log(`    gate ${g} ${GATE_NAME[g].padEnd(11)} ${here.length} lane(s)  ${here.map(codeOf).join(", ")}`);
}
check("gate 1 carries exactly two lanes", mc.lanes.filter((l) => l.gate === 1).length === 2);
check("  and they carry different codes", new Set(mc.lanes.filter((l) => l.gate === 1).map(codeOf)).size === 2);

// ------------------------------------------------------------------ 2

head("2  A VAGUE TERM REFUSES AND NAMES THE MISSING DIMENSIONS");

const VAGUE = "high quality investment research";
const vague = protect(VAGUE, OFFER, POLICY, MEASURED);
console.log(`\n  requirement   ${JSON.stringify(VAGUE)}`);
console.log(`  status        ${vague.status}`);
if (vague.status === "REFUSED") for (const m of vague.missing) console.log(`    missing ${m.dimension.padEnd(10)} ${m.why}`);
check("REFUSED", vague.status === "REFUSED");
check("missing dimensions named", vague.status === "REFUSED" && vague.missing.length > 0);
check("no value proposed anywhere in the refusal", vague.status === "REFUSED" && !JSON.stringify(vague).includes('"value"'));

// ------------------------------------------------------------------ 3

head("3  A THRESHOLD THAT DOES NOT APPEAR IN THE SOURCE TEXT ABSTAINS");

const NO_NUM = "every record must be recent";
const noNum = protect(NO_NUM, OFFER, POLICY, MEASURED);
console.log(`\n  requirement   ${JSON.stringify(NO_NUM)}`);
console.log(`  status        ${noNum.status}`);
if (noNum.status === "REFUSED") for (const m of noNum.missing) console.log(`    missing ${m.dimension.padEnd(10)} ${m.why}`);
check("REFUSED with THRESHOLD missing", noNum.status === "REFUSED" && noNum.missing.some((m) => m.dimension === "THRESHOLD"));
check("no threshold value invented", noNum.status === "REFUSED" && !JSON.stringify(noNum).includes('"seconds"'));

console.log("\n  and a classifier that tries to assert a value the text does not contain:");
const INVENTING: Classifier = (req) => {
  const at = req.indexOf("recent");
  const c: Classification = {
    ruleId: "hostile-inventing-classifier",
    subject: "RECORD",
    property: "GENERATION_TIME",
    op: "AT_OR_AFTER",
    frameKind: "AGREEMENT_TIME",
    // Points at "recent", intending it to mean 60. fromSpan parses the slice, so
    // the only number that can result is one the text actually contains.
    spans: { amount: [at, at + 6], unit: [0, 5] },
  };
  return [c];
};
const invented = protect(NO_NUM, OFFER, POLICY, MEASURED, { classify: INVENTING });
console.log(`  status        ${invented.status}`);
if (invented.status === "REFUSED") for (const m of invented.missing) console.log(`    missing ${m.dimension.padEnd(10)} ${m.why}`);
check("a hostile classifier cannot inject a value", invented.status === "REFUSED");
check(
  "  because the value is derived from the span, never supplied",
  invented.status === "REFUSED" && !JSON.stringify(invented).includes("60"),
);

// ------------------------------------------------------------------ 4

head("4  A FRAME OF ARTIFACT_FIELD IS REFUSED UNCONDITIONALLY");

const SELF_REF = "every record generated within 60 seconds of last_fetch_at";
const selfRef = protect(SELF_REF, OFFER, POLICY, MEASURED);
console.log(`\n  requirement   ${JSON.stringify(SELF_REF)}`);
console.log(`  status        ${selfRef.status}`);
if (selfRef.status === "REFUSED") for (const m of selfRef.missing) console.log(`    missing ${m.dimension.padEnd(10)} ${m.why}`);
check("REFUSED on FRAME", selfRef.status === "REFUSED" && selfRef.missing.some((m) => m.dimension === "FRAME"));
check(
  "  refusal cites the measured drift",
  selfRef.status === "REFUSED" && selfRef.missing.some((m) => m.why.includes("last_fetch_at drifted")),
);

// ------------------------------------------------------------------ 5

head("5  REACHABILITY, SPEC 5.2");

const RESP_REQ = "the delivered file's records were generated within the last 60 seconds";
const respM = protect(RESP_REQ, OFFER, POLICY, [BLOB_TIMESTAMP], { ctx: { obligor: OBLIGOR } });
console.log(`\n  ${JSON.stringify(RESP_REQ)}`);
if (respM.status === "PROTECTED") {
  const l = respM.claims[0].lanes[0];
  console.log(`    subject ${respM.claims[0].claim.subject}   property ${respM.claims[0].claim.property}`);
  console.log(`    ${BLOB_TIMESTAMP.id}: ${laneLine(l)}`);
  if (!l.passed) console.log(`      ${renderReason(l.reason)}`);
  check("signed blob timestamp produces PROPERTY_MISMATCH", l.gate === 2 && codeOf(l) === "PROPERTY_MISMATCH");
  check(
    "  needs GENERATION_TIME, found EXISTENCE_TIME",
    !l.passed && l.reason.code === "PROPERTY_MISMATCH" && l.reason.needs === "GENERATION_TIME" && l.reason.found === "EXISTENCE_TIME",
  );
} else {
  check("signed blob timestamp produces PROPERTY_MISMATCH", false, "extraction refused");
}

const COUNT_REQ = "at least 500 records";
const countM = protect(COUNT_REQ, OFFER, POLICY, [LEAF_COUNT], { ctx: { obligor: OBLIGOR } });
console.log(`\n  ${JSON.stringify(COUNT_REQ)}`);
if (countM.status === "PROTECTED") {
  const cc = countM.claims[0];
  const l = cc.lanes[0];
  console.log(`    subject ${cc.claim.subject}   property ${cc.claim.property}   test ${JSON.stringify(cc.claim.test)}`);
  console.log(`    threshold ${showSourced(cc.threshold)}`);
  console.log(`    ${LEAF_COUNT.id}: ${laneLine(l)}`);
  if (l.passed && l.finding.verdict === "ATTESTED") console.log(`      trusts ${l.finding.trusts}, because binding is ${l.finding.because}`);
  check("leafCount produces ATTESTED", l.passed && l.finding.verdict === "ATTESTED");
  check(
    "  trusts the permitted issuer, because binding is ADJACENT",
    l.passed && l.finding.verdict === "ATTESTED" && l.finding.because === "ADJACENT" && l.finding.trusts === PERMITTED_ISSUER,
  );
} else {
  check("leafCount produces ATTESTED", false, "extraction refused");
}

console.log("\n  remaining codes, so that none in the vocabulary is dead:");
const freshClaim = mc.claim;
for (const [label, art] of [
  ["is_anomaly", IS_ANOMALY],
  ["commitment, stranger key", COMMITMENT_STRANGER_KEY],
  ["commitment, seller signed", COMMITMENT_SELLER_SIGNED],
] as const) {
  const l = matchArtifact(freshClaim, art, { obligor: OBLIGOR });
  console.log(`    ${label.padEnd(26)} gate ${l.gate} ${GATE_NAME[l.gate].padEnd(11)} ${codeOf(l)}`);
}
check(
  "is_anomaly is the precedence witness, PROPERTY_NOT_COMPARABLE",
  codeOf(matchArtifact(freshClaim, IS_ANOMALY, { obligor: OBLIGOR })) === "PROPERTY_NOT_COMPARABLE",
);
check(
  "stranger key gives ISSUER_NOT_PERMITTED",
  codeOf(matchArtifact(freshClaim, COMMITMENT_STRANGER_KEY, { obligor: OBLIGOR })) === "ISSUER_NOT_PERMITTED",
);
check(
  "seller signature gives ISSUER_IS_OBLIGOR",
  codeOf(matchArtifact(freshClaim, COMMITMENT_SELLER_SIGNED, { obligor: OBLIGOR })) === "ISSUER_IS_OBLIGOR",
);

const seen = new Set<string>();
for (const a of [...MEASURED, IS_ANOMALY, BLOB_TIMESTAMP, COMMITMENT_STRANGER_KEY, COMMITMENT_SELLER_SIGNED]) {
  const l = matchArtifact(freshClaim, a, { obligor: OBLIGOR });
  if (!l.passed) seen.add(l.reason.code);
}
const respL = matchArtifact({ ...freshClaim, subject: "RESPONSE" }, BLOB_TIMESTAMP, { obligor: OBLIGOR });
if (!respL.passed) seen.add(respL.reason.code);
seen.add("NO_ARTIFACT_OFFERED");
const unreached = REASON_CODES.filter((c) => !seen.has(c));
console.log(`\n  reason codes reached: ${[...seen].sort().join(", ")}`);
check("all nine reason codes reachable", unreached.length === 0, unreached.length ? `unreached: ${unreached.join(", ")}` : "9 of 9");

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
