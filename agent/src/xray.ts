/**
 * View model for the INSPECT and PROTECT surfaces.
 *
 * Everything the screen renders is computed here from the engine and the frozen
 * fixtures. The component holds no artifact name, no gate, no verdict and no
 * reason of its own. Change a fixture and this output changes, which is what
 * makes the screen a readout rather than an illustration.
 *
 * JSON-serialisable throughout, so a server component can hand it to a client
 * component across the RSC boundary.
 */
import {
  GATE_NAME,
  matchArtifact,
  renderReason,
  type Artifact,
  type Claim,
  type Gate,
  type Lane,
  type Reason,
} from "./evidence.js";
import { protect, type Manifest, type Missing } from "./inspect.js";
import {
  MEASURED,
  OBLIGOR,
  OBSERVED_WINDOW,
  PERMITTED_ISSUER,
} from "./fixtures/evidence.js";

export const FRESHNESS_REQUIREMENT = "every record generated within the last 60 seconds";
export const VAGUE_REQUIREMENT = "high quality investment research";
const OFFER = "ETH-USD spot feed, 500 records per delivery, upstream signed";
const POLICY = { permittedIssuer: PERMITTED_ISSUER, expectedSourceId: "COINBASE_ETH_USD_FEED" };

/** Invariant 6. The complete instruction set, which never grows to fit a term. */
export const OPCODES = ["UINT_GTE", "UINT_EQ", "TIMESTAMP_GTE", "BYTES32_EQ"] as const;

// ------------------------------------------------------------------ labels, all derived

/**
 * An artifact whose id ends in one of the fields it commits to is named by that
 * field, because that is what a reader of the payload would call it. Anything
 * else is named by its id.
 */
function labelOf(a: Artifact): { name: string; mono: boolean } {
  const tail = a.id.split("-").pop() ?? a.id;
  if (a.commitsTo.includes(tail)) return { name: tail, mono: true };
  return { name: a.id.replace(/-/g, " "), mono: false };
}

/**
 * Where it came from, short enough to sit under a lane name without wrapping
 * inside a word. Vendor and leaf only; the middle of the path identifies nothing
 * a reader needs at six feet.
 */
function sourceOf(a: Artifact): string {
  const m = a.origin.match(/GET https?:\/\/[^/]+(\/\S*)/);
  if (m) {
    const segs = m[1].split("?")[0].replace(/^\/apis\/v\d+\//, "").split("/").filter(Boolean);
    if (segs.length <= 2) return segs.join("/");
    return `${segs[0]}/${segs[segs.length - 1]}`;
  }
  const first = a.origin.split(",")[0].trim();
  return first.length > 40 ? `${first.slice(0, 38)}...` : first;
}

/**
 * The board has four columns and a projector has finite width. ATTESTATION is
 * the only gate name long enough to collide with its neighbour, and ISSUER is
 * what it actually tests.
 */
const SHORT_GATE: Record<string, string> = { ATTESTATION: "ISSUER" };

/**
 * Six-foot headline. Every branch interpolates a field of the reason itself, so
 * a fixture change moves the words on the screen.
 */
function headlineOf(r: Reason): string {
  switch (r.code) {
    case "SUBJECT_MISMATCH":
      return `about the ${r.found.toLowerCase()}, not each ${r.needs.toLowerCase()}`;
    case "SUBJECT_COLLAPSE":
      return `per ${r.declared.toLowerCase()} in the schema, per ${r.effective.toLowerCase()} in fact`;
    case "PROPERTY_REFUTED":
      return `${r.asserted}, and it was wrong`;
    case "PROPERTY_NOT_COMPARABLE":
      return `a ${r.found.toLowerCase()}, not a quantity`;
    case "PROPERTY_MISMATCH":
      return `${r.found.toLowerCase().replace(/_/g, " ")}, not ${r.needs.toLowerCase().replace(/_/g, " ")}`;
    case "ISSUER_UNSIGNED":
      return "nobody signed it";
    case "ISSUER_NOT_PERMITTED":
      return `signed by ${r.found}, not ${r.permitted}`;
    case "ISSUER_IS_OBLIGOR":
      return `signed by ${r.obligor}, the obligor`;
    case "NO_ARTIFACT_OFFERED":
      return "nothing was offered";
  }
}

/** How the defect was found. Gate 1 carries both kinds; see spec 5.1. */
function discoveryOf(r: Reason): "READ" | "MEASURED" {
  return r.code === "SUBJECT_COLLAPSE" || r.code === "PROPERTY_REFUTED" ? "MEASURED" : "READ";
}

// ------------------------------------------------------------------ view types

export type LaneView = {
  id: string;
  name: string;
  nameIsMono: boolean;
  source: string;
  commitsTo: string[];
  subjectDeclared: string;
  subjectEffective: string;
  property: string;
  binding: string;
  attestation: string;
  measured: string | null;
  distinctPerResponse: number | null;
  /** True when the artifact failed on subject: what it does commit to is the argument. */
  showsCommits: boolean;
  /** 1..4. Where the lane stops, or 4 when it crosses. */
  stopsAt: Gate;
  crosses: boolean;
  verdict: "ENFORCEABLE" | "ATTESTED" | null;
  settlesBy: string | null;
  code: string | null;
  headline: string | null;
  detail: string | null;
  discovery: "READ" | "MEASURED" | null;
};

export type ClaimView = {
  quote: string;
  requirement: string;
  subject: string;
  property: string;
  seconds: number | null;
  frame: string;
};

export type SourcedView = { label: string; value: string; quote: string | null; span: [number, number] | null; policyField: string | null };

export type ManifestView = {
  status: "PROTECTED";
  requirement: string;
  claimType: string;
  quantifier: "UNIVERSAL" | "SCALAR";
  opcode: string;
  settlesBy: string;
  artifactId: string;
  literals: SourcedView[];
  requiredEvidence: { property: string; binding: string; attestation: string; commitsTo: string[] };
};

export type RefusalView = {
  status: "REFUSED";
  requirement: string;
  missing: Missing[];
  opcodes: readonly string[];
};

export type XRayView = {
  claim: ClaimView;
  gates: { index: Gate; name: string; short: string }[];
  lanes: LaneView[];
  observedWindow: string;
  manifest: ManifestView | null;
  refusal: RefusalView | null;
};

// ------------------------------------------------------------------ builders

const OPCODE_FOR = (property: string, op: string): string => {
  if (property === "GENERATION_TIME" && op === "AT_OR_AFTER") return "TIMESTAMP_GTE";
  if (property === "CARDINALITY" && op === "GTE") return "UINT_GTE";
  if (property === "CARDINALITY" && op === "EQ") return "UINT_EQ";
  if (property === "CONTENT_DIGEST") return "BYTES32_EQ";
  return "UNPROTECTABLE";
};

/** spec/EVIDENCE.md section 6. INSPECT names more than ENFORCE settles. */
const CLAIM_TYPE_FOR: Record<string, string> = {
  GENERATION_TIME: "RECORD_GENERATION_TIME",
  CARDINALITY: "ROW_COUNT",
  EXISTENCE_TIME: "BLOB_EXISTENCE_TIME",
  CONTENT_DIGEST: "SCHEMA_HASH",
  OBSERVATION_TIME: "none, INSPECT only",
  JUDGMENT: "none, INSPECT only",
};

function laneOf(l: Lane): LaneView {
  const a = l.artifact;
  const { name, mono } = labelOf(a);
  const base = {
    id: a.id,
    name,
    nameIsMono: mono,
    source: sourceOf(a),
    commitsTo: a.commitsTo,
    subjectDeclared: a.subject,
    subjectEffective: a.measured?.effectiveSubject ?? a.subject,
    property: a.property,
    binding: a.binding,
    attestation: a.attestation.kind === "SIGNED" ? `signed, ${a.attestation.issuer}` : "unsigned",
    measured: a.measured?.method ?? null,
    distinctPerResponse: a.measured?.maxDistinctPerResponse ?? null,
    showsCommits: !l.passed && l.reason.code === "SUBJECT_MISMATCH",
  };
  if (l.passed) {
    const f = l.finding;
    const verdict = f.verdict === "ENFORCEABLE" || f.verdict === "ATTESTED" ? f.verdict : null;
    const settlesBy =
      f.verdict === "ENFORCEABLE" ? f.settlesBy : f.verdict === "ATTESTED" ? `trusts ${f.trusts}` : null;
    return { ...base, stopsAt: 4, crosses: true, verdict, settlesBy, code: null, headline: null, detail: null, discovery: null };
  }
  return {
    ...base,
    stopsAt: l.gate,
    crosses: false,
    verdict: null,
    settlesBy: null,
    code: l.reason.code,
    headline: headlineOf(l.reason),
    detail: renderReason(l.reason),
    discovery: discoveryOf(l.reason),
  };
}

export function buildXRay(artifacts: readonly Artifact[] = MEASURED): XRayView {
  const m = protect(FRESHNESS_REQUIREMENT, OFFER, POLICY, artifacts, { ctx: { obligor: OBLIGOR } });
  if (m.status !== "PROTECTED") throw new Error("the freshness requirement must compile");
  const mc = m.claims[0];
  const claim: Claim = mc.claim;

  const lanes = artifacts.map((a) => laneOf(matchArtifact(claim, a, { obligor: OBLIGOR })));

  const test = claim.test;
  const claimView: ClaimView = {
    quote: claim.quote,
    requirement: FRESHNESS_REQUIREMENT,
    subject: claim.subject,
    property: claim.property,
    seconds: test.op === "AT_OR_AFTER" ? test.seconds : null,
    frame: test.op === "AT_OR_AFTER" ? test.frame.kind : "n/a",
  };

  const winner = lanes.find((l) => l.crosses && l.verdict === "ENFORCEABLE") ?? null;
  const winnerArtifact = winner ? artifacts.find((a) => a.id === winner.id)! : null;

  const sourced = (label: string, s: typeof mc.threshold | typeof mc.issuer): SourcedView =>
    s.from === "POLICY"
      ? { label, value: String(s.value), quote: null, span: null, policyField: s.field }
      : { label, value: String(s.value), quote: s.quote, span: [s.span[0], s.span[1]], policyField: null };

  const manifest: ManifestView | null =
    winner && winnerArtifact
      ? {
          status: "PROTECTED",
          requirement: FRESHNESS_REQUIREMENT,
          claimType: CLAIM_TYPE_FOR[claim.property] ?? "none",
          quantifier: winner.settlesBy === "COUNTEREXAMPLE" ? "UNIVERSAL" : "SCALAR",
          opcode: OPCODE_FOR(claim.property, test.op),
          settlesBy: winner.settlesBy ?? "",
          artifactId: winnerArtifact.id,
          literals: [sourced("threshold", mc.threshold), sourced("permitted issuer", mc.issuer), sourced("semantic source", mc.sourceId)],
          requiredEvidence: {
            property: winnerArtifact.property,
            binding: winnerArtifact.binding,
            attestation: winnerArtifact.attestation.kind === "SIGNED" ? `signed by ${winnerArtifact.attestation.issuer}` : "unsigned",
            commitsTo: winnerArtifact.commitsTo,
          },
        }
      : null;

  const refused = protect(VAGUE_REQUIREMENT, OFFER, POLICY, artifacts);
  const refusal: RefusalView | null =
    refused.status === "REFUSED"
      ? { status: "REFUSED", requirement: VAGUE_REQUIREMENT, missing: refused.missing, opcodes: OPCODES }
      : null;

  return {
    claim: claimView,
    gates: ([1, 2, 3, 4] as Gate[]).map((index) => ({
      index,
      name: GATE_NAME[index],
      short: SHORT_GATE[GATE_NAME[index]] ?? GATE_NAME[index],
    })),
    lanes,
    observedWindow: OBSERVED_WINDOW,
    manifest,
    refusal,
  };
}

export type { Manifest, Missing };

// ------------------------------------------------------------------ timing
//
// Lives here rather than in the component so the walkthrough prints the same
// numbers the screen runs on.

export const TIMING = { tickMs: 250, gateTicks: 2, staggerTicks: 1 } as const;

/** Tick at which lane `lane` (0-based) resolves gate `gate` (1-based). */
export const gateOnAt = (lane: number, gate: number) => lane * TIMING.staggerTicks + gate * TIMING.gateTicks;
export const reasonOnAt = (lane: number, stopsAt: number) => gateOnAt(lane, stopsAt) + 1;
export const targetOnAt = (lane: number) => gateOnAt(lane, 4) + 1;
export const totalTicks = (laneCount: number) => targetOnAt(laneCount - 1) + 1;
export const manifestOnAt = (laneCount: number) => totalTicks(laneCount) + 2;
