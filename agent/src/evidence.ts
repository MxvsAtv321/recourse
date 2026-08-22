/**
 * The evidence type system. INSPECT and PROTECT only.
 *
 * Nothing in this file is reachable from the settlement path. It imports no
 * chain client, no artifact loader and nothing from verifier.ts. See
 * spec/EVIDENCE.md section 0.
 *
 * Four gates in a fixed order, nine reasons. The first gate that fails is the
 * reason, so the same artifact against the same claim always renders the same
 * sentence.
 */

// ------------------------------------------------------------------ dimensions

export type Subject = "RECORD" | "RESPONSE" | "TRANSACTION";

export type Property =
  | "GENERATION_TIME"
  | "OBSERVATION_TIME"
  | "EXISTENCE_TIME"
  | "CONTENT_DIGEST"
  | "CARDINALITY"
  | "JUDGMENT";

export type Binding = "PREIMAGE" | "ADJACENT" | "NONE";

export type Attestation =
  | { kind: "SIGNED"; issuer: string; scheme: "EIP712" | "JWS" }
  | { kind: "UNSIGNED" };

/** The only thing that can disprove a declared subject or a field's asserted meaning. */
export type Resolution = {
  method: string;
  maxDistinctPerResponse: number;
  effectiveSubject: Subject;
  refutedBy?: { record: string; asserted: string; actual: string };
};

export type Artifact = {
  id: string;
  origin: string;
  commitsTo: string[];
  subject: Subject;
  property: Property;
  binding: Binding;
  attestation: Attestation;
  measured?: Resolution;
};

// ------------------------------------------------------------------ the claim

export type Frame =
  | { kind: "AGREEMENT_TIME" }
  | { kind: "CHAIN_TIME" }
  | { kind: "ARTIFACT_FIELD"; field: string };

export type Test =
  | { op: "AT_OR_AFTER"; seconds: number; frame: Frame }
  | { op: "GTE" | "EQ"; count: number }
  | { op: "DIGEST_EQ"; digest: string };

export type Claim = {
  quote: string;
  subject: Subject;
  property: Property;
  test: Test;
  permittedIssuer?: string;
};

// ------------------------------------------------------------------ provenance
//
// Sourced<T> is invariant 9 made structural. The brand below is a module-private
// unique symbol, so a value of this type cannot be produced by an object literal
// written anywhere else in the program. The only two constructors are below and
// NEITHER accepts a T. A caller supplies text and a span, or a policy object and
// a field name; the value is always derived from what it points at.

declare const PROVENANCE: unique symbol;
type Provenanced = { readonly [PROVENANCE]: true };

export type Span = readonly [number, number];

type SpanSourced<T> = {
  readonly value: T;
  readonly from: "REQUIREMENT" | "OFFER";
  readonly quote: string;
  readonly span: Span;
};

type PolicySourced<T> = {
  readonly value: T;
  readonly from: "POLICY";
  readonly field: string;
};

export type Sourced<T> = (SpanSourced<T> | PolicySourced<T>) & Provenanced;

/**
 * Derive a contractual value from an exact span of a source text.
 *
 * `parse` never sees a caller-supplied value, only the slice. If the slice does
 * not parse, this returns null and the claim abstains. There is no path by which
 * a number that does not appear in the text becomes a threshold.
 */
export function fromSpan<T>(
  from: "REQUIREMENT" | "OFFER",
  text: string,
  span: Span,
  parse: (slice: string) => T | null,
): Sourced<T> | null {
  const [start, end] = span;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || start >= end) return null;
  const quote = text.slice(start, end);
  const value = parse(quote);
  if (value === null || value === undefined) return null;
  return { value, from, quote, span } as Sourced<T>;
}

/** Read a contractual value from an explicit, named policy field. */
export function fromPolicy<T>(
  policy: Readonly<Record<string, unknown>>,
  field: string,
  parse: (raw: unknown) => T | null,
): Sourced<T> | null {
  if (!Object.prototype.hasOwnProperty.call(policy, field)) return null;
  const value = parse(policy[field]);
  if (value === null || value === undefined) return null;
  return { value, from: "POLICY", field } as Sourced<T>;
}

/**
 * Re-derive a span-sourced value from the original text. Structural provenance
 * makes invention impossible at construction; this makes it checkable afterwards,
 * which is what lets the surface say "traceable" without taking our word for it.
 */
export function verifySourced<T>(
  s: Sourced<T>,
  texts: { REQUIREMENT: string; OFFER: string },
): boolean {
  if (s.from === "POLICY") return true;
  const text = texts[s.from];
  const [start, end] = s.span;
  if (start < 0 || end > text.length || start >= end) return false;
  return text.slice(start, end) === s.quote;
}

export const showSourced = <T>(s: Sourced<T>): string =>
  s.from === "POLICY"
    ? `policy.${s.field}`
    : `${s.from}[${s.span[0]}..${s.span[1]}] ${JSON.stringify(s.quote)}`;

// ------------------------------------------------------------------ verdicts

export type Reason =
  | { code: "SUBJECT_MISMATCH"; needs: Subject; found: Subject }
  | { code: "SUBJECT_COLLAPSE"; declared: Subject; effective: Subject; evidence: string }
  | { code: "PROPERTY_REFUTED"; found: Property; record: string; asserted: string; actual: string }
  | { code: "PROPERTY_NOT_COMPARABLE"; found: Property }
  | { code: "PROPERTY_MISMATCH"; needs: Property; found: Property }
  | { code: "ISSUER_UNSIGNED" }
  | { code: "ISSUER_NOT_PERMITTED"; permitted: string; found: string }
  | { code: "ISSUER_IS_OBLIGOR"; obligor: string }
  | { code: "NO_ARTIFACT_OFFERED" };

export const REASON_CODES = [
  "SUBJECT_MISMATCH",
  "SUBJECT_COLLAPSE",
  "PROPERTY_REFUTED",
  "PROPERTY_NOT_COMPARABLE",
  "PROPERTY_MISMATCH",
  "ISSUER_UNSIGNED",
  "ISSUER_NOT_PERMITTED",
  "ISSUER_IS_OBLIGOR",
  "NO_ARTIFACT_OFFERED",
] as const;

export type Finding =
  | { verdict: "ENFORCEABLE"; artifact: string; settlesBy: "COUNTEREXAMPLE" | "DIRECT_EVALUATION" }
  | { verdict: "ATTESTED"; artifact: string; trusts: string; because: Binding }
  | { verdict: "UNPROTECTABLE"; rejected: { artifact: string; reason: Reason }[] };

export type Gate = 1 | 2 | 3 | 4;

export const GATE_NAME: Record<Gate, string> = {
  1: "SUBJECT",
  2: "PROPERTY",
  3: "ATTESTATION",
  4: "BINDING",
};

/** One artifact's walk through the gates. `gate` is where it stopped. */
export type Lane =
  | { artifact: Artifact; gate: 4; passed: true; finding: Finding }
  | { artifact: Artifact; gate: Gate; passed: false; reason: Reason };

export type MatchContext = { obligor?: string };

// ------------------------------------------------------------------ the gates

export function matchArtifact(claim: Claim, artifact: Artifact, ctx: MatchContext = {}): Lane {
  const stop = (gate: Gate, reason: Reason): Lane => ({ artifact, gate, passed: false, reason });

  // Gate 1. Subject. Declared first, then measured, then the claim again.
  const effective = artifact.measured?.effectiveSubject ?? artifact.subject;
  if (artifact.subject !== claim.subject) {
    return stop(1, { code: "SUBJECT_MISMATCH", needs: claim.subject, found: artifact.subject });
  }
  if (effective !== artifact.subject) {
    return stop(1, {
      code: "SUBJECT_COLLAPSE",
      declared: artifact.subject,
      effective,
      evidence: artifact.measured!.method,
    });
  }
  if (effective !== claim.subject) {
    return stop(1, { code: "SUBJECT_MISMATCH", needs: claim.subject, found: effective });
  }

  // Gate 2. Property. A measured refutation outranks the type argument.
  const refuted = artifact.measured?.refutedBy;
  if (refuted) {
    return stop(2, {
      code: "PROPERTY_REFUTED",
      found: artifact.property,
      record: refuted.record,
      asserted: refuted.asserted,
      actual: refuted.actual,
    });
  }
  if (artifact.property === "JUDGMENT") {
    return stop(2, { code: "PROPERTY_NOT_COMPARABLE", found: artifact.property });
  }
  if (artifact.property !== claim.property) {
    return stop(2, { code: "PROPERTY_MISMATCH", needs: claim.property, found: artifact.property });
  }

  // Gate 3. Attestation.
  const att = artifact.attestation;
  if (att.kind === "UNSIGNED") return stop(3, { code: "ISSUER_UNSIGNED" });
  if (ctx.obligor && att.issuer === ctx.obligor) {
    return stop(3, { code: "ISSUER_IS_OBLIGOR", obligor: ctx.obligor });
  }
  if (claim.permittedIssuer && att.issuer !== claim.permittedIssuer) {
    return stop(3, { code: "ISSUER_NOT_PERMITTED", permitted: claim.permittedIssuer, found: att.issuer });
  }

  // Gate 4. Binding decides the tier, never the pass.
  if (artifact.binding === "PREIMAGE") {
    return {
      artifact,
      gate: 4,
      passed: true,
      finding: {
        verdict: "ENFORCEABLE",
        artifact: artifact.id,
        settlesBy: claim.subject === "RECORD" ? "COUNTEREXAMPLE" : "DIRECT_EVALUATION",
      },
    };
  }
  return {
    artifact,
    gate: 4,
    passed: true,
    finding: {
      verdict: "ATTESTED",
      artifact: artifact.id,
      trusts: att.issuer,
      because: artifact.binding,
    },
  };
}

/** Every offered artifact walked, then the best outcome selected. */
export function inspect(
  claim: Claim,
  artifacts: readonly Artifact[],
  ctx: MatchContext = {},
): { lanes: Lane[]; finding: Finding } {
  if (artifacts.length === 0) {
    return {
      lanes: [],
      finding: { verdict: "UNPROTECTABLE", rejected: [{ artifact: "(none)", reason: { code: "NO_ARTIFACT_OFFERED" } }] },
    };
  }
  const lanes = artifacts.map((a) => matchArtifact(claim, a, ctx));
  const enforceable = lanes.find((l) => l.passed && l.finding.verdict === "ENFORCEABLE");
  if (enforceable && enforceable.passed) return { lanes, finding: enforceable.finding };
  const attested = lanes.find((l) => l.passed && l.finding.verdict === "ATTESTED");
  if (attested && attested.passed) return { lanes, finding: attested.finding };
  return {
    lanes,
    finding: {
      verdict: "UNPROTECTABLE",
      rejected: lanes.filter((l) => !l.passed).map((l) => ({ artifact: l.artifact.id, reason: l.reason })),
    },
  };
}

// ------------------------------------------------------------------ sentences

export function renderReason(r: Reason): string {
  switch (r.code) {
    case "SUBJECT_MISMATCH":
      return `establishes a property of the ${r.found.toLowerCase()}, not of each ${r.needs.toLowerCase()}`;
    case "SUBJECT_COLLAPSE":
      return `declared per ${r.declared.toLowerCase()}, effective per ${r.effective.toLowerCase()}: ${r.evidence}`;
    case "PROPERTY_REFUTED":
      return `asserted ${r.asserted}, but ${r.actual} (${r.record})`;
    case "PROPERTY_NOT_COMPARABLE":
      return `carries a ${r.found.toLowerCase()}, which is a verdict rather than a quantity a threshold can compare`;
    case "PROPERTY_MISMATCH":
      return `carries ${r.found.toLowerCase().replace(/_/g, " ")}, the claim needs ${r.needs.toLowerCase().replace(/_/g, " ")}`;
    case "ISSUER_UNSIGNED":
      return "nobody signs it, so any party handling the payload can change it without trace";
    case "ISSUER_NOT_PERMITTED":
      return `signed by ${r.found}, the terms permit only ${r.permitted}`;
    case "ISSUER_IS_OBLIGOR":
      return `signed by ${r.obligor}, who is the party whose performance is in question`;
    case "NO_ARTIFACT_OFFERED":
      return "no evidence artifact was offered for this claim";
  }
}
