/**
 * The compile surface.
 *
 * Two pieces of source text and one action. Three compilations run in sequence
 * and the sequence is the argument: a vendor phrase compiles to nothing, the
 * buyer's requirement compiles to a claim that no available evidence can
 * discharge, and the same requirement against a bound commitment compiles clean
 * and emits a breach witness spec.
 *
 * Every diagnostic points at an exact span of the source it is about. Nothing
 * here adds a gate, a reason code or any settlement behaviour.
 */
import { matchArtifact, type Artifact, type Claim, type Lane } from "./evidence.js";
import { defaultClassifier, protect } from "./inspect.js";
import { AISA_OFFER, PROTECTED_OFFER } from "./fixtures/offers.js";
import { OBLIGOR, PERMITTED_ISSUER, RECOURSE_COMMITMENT } from "./fixtures/evidence.js";
import {
  checkProof,
  synthesise,
  witnessIdOf,
  type BreachWitnessSpec,
  type ExecutedProof,
  type FieldCheck,
  type Opcode,
} from "./witness.js";

const POLICY = { permittedIssuer: PERMITTED_ISSUER, expectedSourceId: "COINBASE_ETH_USD_FEED" };
const OFFER_TEXT = "ETH-USD spot feed, 500 records per delivery, upstream signed";

export type SourceRef =
  | { kind: "SPAN"; label: string; span: [number, number]; quote: string }
  | { kind: "POLICY"; label: string; field: string };

export type Diagnostic = {
  /** The typed error code, as the engine emitted it. */
  code: string;
  at: SourceRef;
  /** One line. What was found, against what was required. */
  found: string;
  required: string;
};

export type WitnessView = {
  conditionId: number;
  claimType: string;
  quantifier: string;
  falsifierOp: string;
  negates: string;
  reads: string;
  thresholdAbsolute: string;
  thresholdSeconds: number;
  thresholdSourced: { value: string; quote: string; span: [number, number] };
  requiredBinding: string;
  requiredArtifactId: string;
  permittedIssuer: string;
  expectedSourceId: string;
  witnessId: string;
};

export type Compilation = {
  id: string;
  ordinal: number;
  /** What is being compiled, in one phrase. */
  title: string;
  sourceLabel: string;
  sourceText: string;
  status: "FAILED" | "COMPILED";
  /** The proposition the source compiled to, when it compiled to one. */
  claim: { subject: string; property: string; opcode: string; thresholdAbsolute: string; seconds: number } | null;
  diagnostics: Diagnostic[];
  witness: WitnessView | null;
};

export type PayoffField = FieldCheck & { fromChain: boolean; note: string };

export type Payoff = {
  index: string;
  offendingIndex: string;
  txHash: string;
  verdict: string;
  fields: PayoffField[];
  witnessIdBefore: string;
  witnessIdAfter: string;
  matches: boolean;
  /** Named on the page rather than implied. */
  fixtureReadFields: string[];
};

export type CompileView = {
  requirement: string;
  sellerPromise: string;
  compilations: Compilation[];
  payoff: Payoff | null;
};

/** What the escrow recorded, as the run artifact carries it. */
export type SignedCondition = {
  conditionId: number;
  sourceQuote: string;
  claimType: string;
  quantifier: string;
  opcode: string;
  threshold: string;
  permittedIssuer: string;
  expectedSourceId: string;
};

// ------------------------------------------------------------------ diagnostics

/** Which phrase of the requirement a gate is about. Gate 3 is not in the text. */
function locate(requirement: string, gate: number): SourceRef {
  const c = defaultClassifier(requirement)[0];
  const span = gate === 1 ? c?.spans.subject : gate === 2 ? c?.spans.property : undefined;
  if (span) {
    return { kind: "SPAN", label: "requirement", span: [span[0], span[1]], quote: requirement.slice(span[0], span[1]) };
  }
  return { kind: "POLICY", label: "policy", field: "permittedIssuer" };
}

function diagnosticFor(requirement: string, lane: Lane): Diagnostic | null {
  if (lane.passed) return null;
  const r = lane.reason;
  const at = locate(requirement, lane.gate);
  switch (r.code) {
    case "SUBJECT_MISMATCH":
      return { code: r.code, at, found: `${lane.artifact.id} is about the ${r.found.toLowerCase()}`, required: `a fact about each ${r.needs.toLowerCase()}` };
    case "SUBJECT_COLLAPSE":
      return {
        code: r.code,
        at,
        found: `${lane.artifact.id} is per ${r.effective.toLowerCase()} in fact (${r.evidence})`,
        required: `per ${r.declared.toLowerCase()}`,
      };
    case "PROPERTY_REFUTED":
      return { code: r.code, at, found: `${lane.artifact.id} asserted ${r.asserted}, and ${r.actual}`, required: "a measurement, not a verdict" };
    case "PROPERTY_NOT_COMPARABLE":
      return { code: r.code, at, found: `${lane.artifact.id} carries a ${r.found.toLowerCase()}`, required: "a quantity a threshold can compare" };
    case "PROPERTY_MISMATCH":
      return { code: r.code, at, found: `${lane.artifact.id} carries ${r.found.toLowerCase().replace(/_/g, " ")}`, required: r.needs.toLowerCase().replace(/_/g, " ") };
    case "ISSUER_UNSIGNED":
      return { code: r.code, at, found: `${lane.artifact.id} is unsigned`, required: `a signature from ${PERMITTED_ISSUER}` };
    case "ISSUER_NOT_PERMITTED":
      return { code: r.code, at, found: `signed by ${r.found}`, required: `signed by ${r.permitted}` };
    case "ISSUER_IS_OBLIGOR":
      return { code: r.code, at, found: `signed by ${r.obligor}, the obligor`, required: "signed by a party that is not the obligor" };
    case "NO_ARTIFACT_OFFERED":
      return { code: r.code, at, found: "no artifact was offered", required: "one artifact bound to the record" };
  }
}

// ------------------------------------------------------------------ the three compilations

function compileSellerPhrase(text: string): Compilation {
  const m = protect(text, OFFER_TEXT, POLICY, [RECOURSE_COMMITMENT]);
  const diagnostics: Diagnostic[] =
    m.status === "REFUSED"
      ? m.missing.map((miss) => ({
          code: `NO_EXECUTABLE_PROPOSITION / missing ${miss.dimension}`,
          at: miss.span
            ? { kind: "SPAN" as const, label: "seller promise", span: [miss.span[0], miss.span[1]] as [number, number], quote: text.slice(miss.span[0], miss.span[1]) }
            : { kind: "POLICY" as const, label: "policy", field: miss.dimension.toLowerCase() },
          found: miss.why,
          required: "a value the requirement states, which a predicate can compare",
        }))
      : [];
  return {
    id: "seller-phrase",
    ordinal: 1,
    title: "the seller's promise, on its own",
    sourceLabel: "seller promise",
    sourceText: text,
    status: m.status === "PROTECTED" ? "COMPILED" : "FAILED",
    claim: null,
    diagnostics,
    witness: null,
  };
}

function compileAgainst(
  ordinal: number,
  id: string,
  title: string,
  requirement: string,
  artifacts: readonly Artifact[],
  signed: SignedCondition | null,
): Compilation {
  const m = protect(requirement, OFFER_TEXT, POLICY, artifacts, { ctx: { obligor: OBLIGOR } });
  if (m.status !== "PROTECTED") {
    return { id, ordinal, title, sourceLabel: "buyer requirement", sourceText: requirement, status: "FAILED", claim: null, diagnostics: [], witness: null };
  }
  const mc = m.claims[0];
  const claim: Claim = mc.claim;
  const test = claim.test;
  const seconds = test.op === "AT_OR_AFTER" ? test.seconds : 0;

  const lanes = artifacts.map((a) => matchArtifact(claim, a, { obligor: OBLIGOR }));
  const diagnostics = lanes.map((l) => diagnosticFor(requirement, l)).filter((d): d is Diagnostic => d !== null);
  const reached = lanes.find((l) => l.passed);

  let witness: WitnessView | null = null;
  if (reached && signed) {
    const t = mc.threshold;
    const spec: BreachWitnessSpec = synthesise({
      conditionId: signed.conditionId,
      claimType: signed.claimType,
      quantifier: signed.quantifier as "UNIVERSAL" | "SCALAR",
      opcode: signed.opcode as Opcode,
      thresholdAbsolute: signed.threshold,
      thresholdSourced: t,
      thresholdSeconds: seconds,
      permittedIssuer: signed.permittedIssuer,
      expectedSourceId: signed.expectedSourceId,
      artifact: reached.artifact,
    });
    witness = {
      conditionId: spec.conditionId,
      claimType: spec.claimType,
      quantifier: spec.quantifier,
      falsifierOp: spec.falsifier.op,
      negates: spec.falsifier.negates,
      reads: spec.falsifier.reads,
      thresholdAbsolute: spec.threshold.absolute,
      thresholdSeconds: spec.threshold.seconds,
      thresholdSourced:
        t.from === "POLICY"
          ? { value: String(t.value), quote: `policy.${t.field}`, span: [0, 0] }
          : { value: String(t.value), quote: t.quote, span: [t.span[0], t.span[1]] },
      requiredBinding: spec.requiredBinding,
      requiredArtifactId: spec.requiredArtifactId,
      permittedIssuer: spec.permittedIssuer,
      expectedSourceId: spec.expectedSourceId,
      witnessId: spec.witnessId,
    };
  }

  return {
    id,
    ordinal,
    title,
    sourceLabel: "buyer requirement",
    sourceText: requirement,
    status: reached ? "COMPILED" : "FAILED",
    claim: {
      subject: claim.subject,
      property: claim.property,
      opcode: signed?.opcode ?? "TIMESTAMP_GTE",
      thresholdAbsolute: signed?.threshold ?? "",
      seconds,
    },
    diagnostics,
    witness,
  };
}

// ------------------------------------------------------------------ the payoff

/** Two fields the chain does not carry as a string, so both sides read the fixture. */
const FIXTURE_READ = ["requiredBinding", "requiredArtifactId"];

function buildPayoff(before: WitnessView, signed: SignedCondition, x: ExecutedProof, sourced: WitnessView["thresholdSourced"], seconds: number): Payoff {
  // Rebuilt from the condition as signed and the commitment as recovered on
  // chain, not from the object above.
  const rebuilt = synthesise({
    conditionId: signed.conditionId,
    claimType: signed.claimType,
    quantifier: signed.quantifier as "UNIVERSAL" | "SCALAR",
    opcode: signed.opcode as Opcode,
    thresholdAbsolute: signed.threshold,
    thresholdSourced: { value: Number(sourced.value), from: "REQUIREMENT", quote: sourced.quote, span: sourced.span } as never,
    thresholdSeconds: seconds,
    permittedIssuer: x.issuer,
    expectedSourceId: x.sourceId,
    artifact: RECOURSE_COMMITMENT,
  });

  const spec: BreachWitnessSpec = {
    conditionId: before.conditionId,
    claimType: before.claimType,
    quantifier: before.quantifier as "UNIVERSAL" | "SCALAR",
    falsifier: { op: before.falsifierOp as never, negates: before.negates as never, reads: before.reads },
    threshold: {
      absolute: before.thresholdAbsolute,
      sourced: { value: Number(before.thresholdSourced.value), from: "REQUIREMENT", quote: before.thresholdSourced.quote, span: before.thresholdSourced.span } as never,
      seconds: before.thresholdSeconds,
    },
    requiredBinding: before.requiredBinding as never,
    requiredArtifactId: before.requiredArtifactId,
    permittedIssuer: before.permittedIssuer,
    expectedSourceId: before.expectedSourceId,
    witnessId: before.witnessId as `0x${string}`,
  };

  const fields: PayoffField[] = checkProof(spec, x).map((f) => {
    const fixture = FIXTURE_READ.some((k) => f.field.startsWith(k));
    return {
      ...f,
      fromChain: !fixture,
      note: fixture
        ? "read from the fixture on both sides: the chain does not carry this as a string"
        : "recomputed from what the escrow recorded",
    };
  });

  return {
    index: x.index,
    offendingIndex: x.offendingIndex,
    txHash: "",
    verdict: "",
    fields,
    witnessIdBefore: before.witnessId,
    witnessIdAfter: witnessIdOf(rebuilt),
    matches: before.witnessId === witnessIdOf(rebuilt),
    fixtureReadFields: FIXTURE_READ,
  };
}

// ------------------------------------------------------------------ entry point

export function buildCompile(signed: SignedCondition | null, executed: ExecutedProof | null): CompileView {
  // The requirement is the phrase the terms carry, so the page and the escrow
  // cannot drift apart. With no captured run there is nothing signed yet, and
  // the fixture requirement stands in.
  const requirement = signed?.sourceQuote ?? "every record generated within the last 60 seconds";
  const sellerPromise = AISA_OFFER.advertises;

  const one = compileSellerPhrase(sellerPromise);
  const two = compileAgainst(2, "requirement-vs-available", "the buyer's requirement, against the evidence this endpoint offers", requirement, AISA_OFFER.artifacts, signed);
  const three = compileAgainst(3, "requirement-vs-protected", "the same requirement, against a bound delivery commitment", requirement, PROTECTED_OFFER.artifacts, signed);

  let payoff: Payoff | null = null;
  if (three.witness && signed && executed) {
    payoff = buildPayoff(three.witness, signed, executed, three.witness.thresholdSourced, three.witness.thresholdSeconds);
  }

  return { requirement, sellerPromise, compilations: [one, two, three], payoff };
}
