/**
 * Breach witness synthesis.
 *
 * When a claim compiles to ENFORCEABLE, the compiler emits the structured,
 * minimal falsifying condition for that claim: the shape a counterexample must
 * have to reverse the settlement. It is an artifact, not prose.
 *
 * Nothing here executes on chain, adds a gate, adds a reason code or touches the
 * settlement path. The opcode set does not grow either: the falsifier vocabulary
 * below is the negation of the four opcodes, used to describe what a witness must
 * satisfy. The contract still checks `!satisfied(opcode, observed, threshold)`.
 */
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import type { Artifact, Binding, Claim } from "./evidence.js";
import { showSourced, type Sourced } from "./evidence.js";

/** The negation of each opcode. One entry per opcode, and it never grows either. */
export const NEGATION = {
  UINT_GTE: "UINT_LT",
  UINT_EQ: "UINT_NEQ",
  TIMESTAMP_GTE: "TIMESTAMP_LT",
  BYTES32_EQ: "BYTES32_NEQ",
} as const;

export type Opcode = keyof typeof NEGATION;
export type FalsifierOp = (typeof NEGATION)[Opcode];

/**
 * Which field of a bound leaf the falsifier reads. Mirrors RecourseEscrow._observed
 * and verifier.ts observedFor: generation time is the only per-record observable a
 * bound leaf establishes.
 */
const READS: Record<string, string> = {
  RECORD_GENERATION_TIME: "generatedAt",
  ROW_COUNT: "leafCount",
};

export type WitnessBody = {
  conditionId: number;
  claimType: string;
  quantifier: "UNIVERSAL" | "SCALAR";
  falsifier: {
    /** The negation of the claim's opcode, not a restatement of it. */
    op: FalsifierOp;
    negates: Opcode;
    /** The leaf field a witness must carry. */
    reads: string;
  };
  threshold: {
    /** The absolute value the predicate compares against, as signed into terms. */
    absolute: string;
    /** The literal the buyer wrote, with its exact provenance. */
    sourced: Sourced<number>;
    /** sourced.value times its unit. What makes the literal and the absolute connect. */
    seconds: number;
  };
  /** Only an artifact bound this tightly can produce a witness. */
  requiredBinding: Binding;
  /** The artifact that reached the fourth gate, and must be the one that produces it. */
  requiredArtifactId: string;
  permittedIssuer: string;
  expectedSourceId: string;
};

export type BreachWitnessSpec = WitnessBody & { witnessId: Hex };

/** Where each field came from. Printed beside the spec so nothing looks authored. */
export type Provenance = Record<string, string>;

const CANON = [
  { name: "conditionId", type: "uint8" },
  { name: "claimType", type: "string" },
  { name: "quantifier", type: "string" },
  { name: "falsifierOp", type: "string" },
  { name: "negates", type: "string" },
  { name: "reads", type: "string" },
  { name: "thresholdAbsolute", type: "uint256" },
  { name: "thresholdSourcedValue", type: "uint256" },
  { name: "thresholdSeconds", type: "uint256" },
  { name: "thresholdProvenance", type: "string" },
  { name: "requiredBinding", type: "string" },
  { name: "requiredArtifactId", type: "string" },
  { name: "permittedIssuer", type: "address" },
  { name: "expectedSourceId", type: "bytes32" },
] as const;

/** Canonical by construction: fixed field order, fixed ABI types, no JSON ambiguity. */
export function canonicalise(b: WitnessBody): Hex {
  return encodeAbiParameters(CANON as never, [
    b.conditionId,
    b.claimType,
    b.quantifier,
    b.falsifier.op,
    b.falsifier.negates,
    b.falsifier.reads,
    BigInt(b.threshold.absolute),
    BigInt(b.threshold.sourced.value),
    BigInt(b.threshold.seconds),
    showSourced(b.threshold.sourced),
    b.requiredBinding,
    b.requiredArtifactId,
    b.permittedIssuer as `0x${string}`,
    b.expectedSourceId as `0x${string}`,
  ] as never);
}

export const witnessIdOf = (b: WitnessBody): Hex => keccak256(canonicalise(b));

export type SynthesisInput = {
  conditionId: number;
  claimType: string;
  quantifier: "UNIVERSAL" | "SCALAR";
  /** The opcode the claim compiled to. */
  opcode: Opcode;
  /** The absolute threshold signed into the terms. */
  thresholdAbsolute: string;
  /** The buyer's literal, carrying its span. */
  thresholdSourced: Sourced<number>;
  /** The window the claim resolved to, from the sourced literal and its unit. */
  thresholdSeconds: number;
  permittedIssuer: string;
  expectedSourceId: string;
  /** The artifact that reached the fourth gate. */
  artifact: Artifact;
};

/**
 * Emit the spec. Every field is read off the compiled claim or the matching
 * artifact. There is no parameter here that lets a caller author a value.
 */
export function synthesise(i: SynthesisInput): BreachWitnessSpec {
  const reads = READS[i.claimType];
  if (!reads) throw new Error(`no per-record observable for ${i.claimType}: it cannot be falsified by a witness`);
  const body: WitnessBody = {
    conditionId: i.conditionId,
    claimType: i.claimType,
    quantifier: i.quantifier,
    falsifier: { op: NEGATION[i.opcode], negates: i.opcode, reads },
    threshold: { absolute: i.thresholdAbsolute, sourced: i.thresholdSourced, seconds: i.thresholdSeconds },
    requiredBinding: i.artifact.binding,
    requiredArtifactId: i.artifact.id,
    permittedIssuer: i.permittedIssuer,
    expectedSourceId: i.expectedSourceId,
  };
  return { ...body, witnessId: witnessIdOf(body) };
}

/** Where each field of a synthesised spec came from. Derived, never written down. */
export function provenanceOf(i: SynthesisInput): Provenance {
  return {
    conditionId: "the compiled condition",
    claimType: "the compiled condition",
    quantifier: "the compiled condition",
    "falsifier.op": `NEGATION[${i.opcode}], the negation of the claim's opcode`,
    "falsifier.negates": "the compiled condition's opcode",
    "falsifier.reads": `READS[${i.claimType}], the leaf field that claim type observes`,
    "threshold.absolute": "the value signed into PurchaseTerms",
    "threshold.sourced": `${showSourced(i.thresholdSourced)}, an exact span of the buyer requirement`,
    "threshold.seconds": "the sourced literal times its sourced unit",
    requiredBinding: `${i.artifact.id}.binding`,
    requiredArtifactId: "the artifact that reached gate 4",
    permittedIssuer: "the compiled condition",
    expectedSourceId: "the compiled condition",
    witnessId: "keccak256 of the canonical ABI serialisation of every field above",
  };
}

// ------------------------------------------------------------------ correspondence

/** What the chain actually recorded for the proof that settled. */
export type ExecutedProof = {
  index: string;
  offendingIndex: string;
  observed: string;
  thresholdAt: string;
  conditionId: number;
  claimType: string;
  quantifier: string;
  sourceId: string;
  issuer: string;
  leafFormula: string;
};

export type FieldCheck = { field: string; passed: boolean; spec: string; executed: string };

/**
 * Does the proof that settled satisfy the spec compiled before payment?
 *
 * Each field is compared on its own. A failure is a failure and is returned as
 * one; nothing here reconciles a mismatch.
 */
export function checkProof(spec: BreachWitnessSpec, x: ExecutedProof): FieldCheck[] {
  const eq = (field: string, s: string, e: string): FieldCheck => ({
    field,
    passed: s.toLowerCase() === e.toLowerCase(),
    spec: s,
    executed: e,
  });

  const falsified =
    spec.falsifier.op === "TIMESTAMP_LT" || spec.falsifier.op === "UINT_LT"
      ? BigInt(x.observed) < BigInt(x.thresholdAt)
      : spec.falsifier.op === "UINT_NEQ"
        ? BigInt(x.observed) !== BigInt(x.thresholdAt)
        : x.observed.toLowerCase() !== x.thresholdAt.toLowerCase();

  return [
    eq("conditionId", String(spec.conditionId), String(x.conditionId)),
    eq("claimType", spec.claimType, x.claimType),
    eq("quantifier", spec.quantifier, x.quantifier),
    eq("threshold.absolute", spec.threshold.absolute, x.thresholdAt),
    eq("expectedSourceId", spec.expectedSourceId, x.sourceId),
    eq("permittedIssuer", spec.permittedIssuer, x.issuer),
    {
      field: `falsifier ${spec.falsifier.op}`,
      passed: falsified,
      spec: `${spec.falsifier.reads} ${spec.falsifier.op} ${spec.threshold.absolute}`,
      executed: `${x.observed} ${falsified ? "<" : ">="} ${x.thresholdAt}`,
    },
    {
      field: `requiredBinding ${spec.requiredBinding}`,
      // A preimage binding means the leaf carried the content hash and the
      // observable together. The formula the issuer signed is what shows it.
      passed:
        spec.requiredBinding !== "PREIMAGE" ||
        (x.leafFormula.includes("keccak256(recordBytes)") && x.leafFormula.includes(spec.falsifier.reads)),
      spec: `${spec.falsifier.reads} bound to keccak256(recordBytes) in one preimage`,
      executed: x.leafFormula,
    },
    {
      field: "the record the chain named",
      passed: x.index === x.offendingIndex,
      spec: "the submitted index is the index the escrow emitted",
      executed: `submitted ${x.index}, BreachProved emitted ${x.offendingIndex}`,
    },
  ];
}
