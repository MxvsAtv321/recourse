/**
 * Frozen evidence fixtures.
 *
 * Recorded observations from AIsa's production API on 2026-08-22 between
 * 01:03:30Z and 01:51:22Z. NOTHING HERE IS RE-FETCHED AT RUN TIME. The demo
 * cannot fail on a network call and cannot silently change under a rehearsed
 * pitch. This is not a corpus and nothing depends on it growing.
 *
 * Values are transcribed from spec/EVIDENCE.md section 4. If the spec and this
 * file disagree, the spec is right and this file is a bug.
 */
import type { Artifact } from "../evidence.js";

export const OBSERVED_WINDOW = "2026-08-22T01:03:30Z to 2026-08-22T01:51:22Z";

// ------------------------------------------------------------------ the five measured artifacts

export const X402_RECEIPT: Artifact = {
  id: "x402-receipt",
  origin:
    "x402 Offer & Receipt extension, EIP-712 Receipt schema, specs/extensions/extension-offer-and-receipt.md",
  commitsTo: ["version", "network", "resourceUrl", "payer", "issuedAt", "transaction"],
  subject: "TRANSACTION",
  property: "OBSERVATION_TIME",
  binding: "PREIMAGE",
  attestation: { kind: "SIGNED", issuer: "resource server", scheme: "EIP712" },
};

export const LAST_UPDATED: Artifact = {
  id: "coingecko-markets-last_updated",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/markets?vs_currency=usd&per_page=100",
  commitsTo: ["last_updated"],
  subject: "RECORD",
  property: "OBSERVATION_TIME",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "4 calls, 400 records, 2026-08-22T01:03:30Z to 01:51:22Z, identical 100-coin basket",
    maxDistinctPerResponse: 1,
    effectiveSubject: "RESPONSE",
  },
};

export const IS_STALE: Artifact = {
  id: "coingecko-tickers-is_stale",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/bitcoin/tickers",
  commitsTo: ["is_stale"],
  subject: "RECORD",
  property: "JUDGMENT",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "4 calls, 400 records, 2026-08-22T01:04:50Z to 01:51:22Z",
    // Uniformly false. See spec/EVIDENCE.md 1.2: uniformity does not collapse a boolean.
    maxDistinctPerResponse: 1,
    effectiveSubject: "RECORD",
    refutedBy: {
      record: "GMO Coin Japan, BTC/JPY, call of 2026-08-22T01:36:21Z",
      asserted: "is_stale = false",
      actual:
        "last_traded_at 2026-08-21T23:59:48+00:00 against last_fetch_at 2026-08-22T01:34:40+00:00, 5692 seconds",
    },
  },
};

export const LAST_TRADED_AT: Artifact = {
  id: "coingecko-tickers-last_traded_at",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/bitcoin/tickers",
  commitsTo: ["last_traded_at", "timestamp"],
  subject: "RECORD",
  property: "GENERATION_TIME",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "3 calls, 300 records, 2026-08-22T01:21:19Z to 01:51:22Z",
    // 23, 25, 24 across the three calls.
    maxDistinctPerResponse: 25,
    effectiveSubject: "RECORD",
  },
};

/** No Resolution: index enters the leaf preimage, so per-record scope is structural. */
export const RECOURSE_COMMITMENT: Artifact = {
  id: "recourse-delivery-commitment",
  origin: "RecourseEscrow.submitDeliveryCommitment, contracts/src/RecourseEscrow.sol",
  commitsTo: ["specHash", "conditionId", "merkleRoot", "leafCount", "sourceId", "payloadRef"],
  subject: "RECORD",
  property: "GENERATION_TIME",
  binding: "PREIMAGE",
  attestation: { kind: "SIGNED", issuer: "condition.permittedIssuer", scheme: "EIP712" },
};

/** The five lanes of the X-Ray, in spec order. */
export const MEASURED: readonly Artifact[] = [
  X402_RECEIPT,
  LAST_UPDATED,
  IS_STALE,
  LAST_TRADED_AT,
  RECOURSE_COMMITMENT,
];

// ------------------------------------------------------------------ section 5.2 reachability
//
// Not measured observations. These exist so that no reason code in the
// vocabulary is dead. See spec/EVIDENCE.md section 5.2.

/** agent/src/seller.ts signBlobTimestamp. Authentic, perfectly bound, wrong property. */
export const BLOB_TIMESTAMP: Artifact = {
  id: "signed-blob-timestamp",
  origin: "agent/src/seller.ts signBlobTimestamp, an issuer signature over the delivered file hash and a time",
  commitsTo: ["blobHash", "timestampedAt"],
  subject: "RESPONSE",
  property: "EXISTENCE_TIME",
  binding: "PREIMAGE",
  attestation: { kind: "SIGNED", issuer: "condition.permittedIssuer", scheme: "EIP712" },
};

/** The precedence witness: same shape as is_stale, no observed counterexample. */
export const IS_ANOMALY: Artifact = {
  id: "coingecko-tickers-is_anomaly",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/bitcoin/tickers",
  commitsTo: ["is_anomaly"],
  subject: "RECORD",
  property: "JUDGMENT",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "4 calls, 400 records, 2026-08-22T01:04:50Z to 01:51:22Z, no record demonstrably anomalous",
    maxDistinctPerResponse: 1,
    effectiveSubject: "RECORD",
  },
};

/** leafCount inside the signed DeliveryCommitment. Signed, adjacent, not recomputable. */
export const LEAF_COUNT: Artifact = {
  id: "delivery-commitment-leafCount",
  origin: "DeliveryCommitment.leafCount, inside the signed struct, contracts/src/RecourseEscrow.sol",
  commitsTo: ["specHash", "conditionId", "merkleRoot", "leafCount", "sourceId", "payloadRef"],
  subject: "RESPONSE",
  property: "CARDINALITY",
  binding: "ADJACENT",
  attestation: { kind: "SIGNED", issuer: "condition.permittedIssuer", scheme: "EIP712" },
};

/** Same commitment, signed by a key the terms do not name. */
export const COMMITMENT_STRANGER_KEY: Artifact = {
  ...RECOURSE_COMMITMENT,
  id: "recourse-delivery-commitment (stranger key)",
  attestation: { kind: "SIGNED", issuer: "0xStranger", scheme: "EIP712" },
};

/** Same commitment, signed by the seller, who cannot attest to its own performance. */
export const COMMITMENT_SELLER_SIGNED: Artifact = {
  ...RECOURSE_COMMITMENT,
  id: "recourse-delivery-commitment (seller signed)",
  attestation: { kind: "SIGNED", issuer: "0xSeller", scheme: "EIP712" },
};

export const PERMITTED_ISSUER = "condition.permittedIssuer";
export const OBLIGOR = "0xSeller";
