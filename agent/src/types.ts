import type { Address, Hex } from "viem";

/** Mirrors ClaimType in contracts/src/RecourseEscrow.sol. Order is load-bearing. */
export const ClaimType = {
  ROW_COUNT: 0,
  SCHEMA_HASH: 1,
  RECORD_GENERATION_TIME: 2,
  BLOB_EXISTENCE_TIME: 3,
} as const;
export type ClaimTypeValue = (typeof ClaimType)[keyof typeof ClaimType];
export const claimTypeName = (v: number) =>
  (Object.keys(ClaimType) as (keyof typeof ClaimType)[]).find((k) => ClaimType[k] === v)!;

export const Quantifier = { SCALAR: 0, UNIVERSAL: 1 } as const;

/** The complete opcode set. It never grows to fit a term. */
export const Opcode = {
  UINT_GTE: 0,
  UINT_EQ: 1,
  TIMESTAMP_GTE: 2,
  BYTES32_EQ: 3,
} as const;
export const opcodeName = (v: number) =>
  (Object.keys(Opcode) as (keyof typeof Opcode)[]).find((k) => Opcode[k] === v)!;

export type Condition = {
  conditionId: number;
  requires: number;
  quantifier: number;
  opcode: number;
  threshold: Hex;
  permittedIssuer: Address;
  expectedSourceId: Hex;
  sourceQuote: string;
};

export type PurchaseTerms = {
  purchaseId: Hex;
  buyer: Address;
  seller: Address;
  amount: bigint;
  asset: Address;
  conditions: Condition[];
  challengeWindow: bigint;
  /** Absolute timestamp. Past it, an undelivered purchase is reclaimable. */
  deliveryDeadline: bigint;
};

export type EvidenceOffer = {
  conditionId: number;
  establishes: number;
  issuer: Address;
};

export type DeliveryCommitment = {
  specHash: Hex;
  conditionId: number;
  merkleRoot: Hex;
  /** Leaves in the committed tree. Signed, so a scalar row count binds to it. */
  leafCount: bigint;
  sourceId: Hex;
};

export type BreachProof = {
  specHash: Hex;
  conditionId: number;
  index: bigint;
  recordBytes: Hex;
  generatedAt: bigint;
  sourceId: Hex;
  merklePath: Hex[];
};

/** One delivered row, as the seller produced it. */
export type DeliveredRecord = {
  index: number;
  bytes: Hex;
  generatedAt: bigint;
  sourceId: Hex;
};

export type Delivery = {
  records: DeliveredRecord[];
  /** keccak256 over the serialised delivery file, which is what a blob timestamp covers. */
  blobHash: Hex;
  blobTimestamp: SignedBlobTimestamp;
};

/**
 * NOT RFC-3161. An issuer signature over the delivered file hash and a time.
 * It establishes when the FILE existed. It says nothing about the records inside.
 */
export type SignedBlobTimestamp = {
  blobHash: Hex;
  timestampedAt: bigint;
  issuer: Address;
  signature: Hex;
};
