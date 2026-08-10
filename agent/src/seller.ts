import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { buildTree, leafOf, rootOf } from "./merkle.js";
import type { Delivery, DeliveredRecord, SignedBlobTimestamp } from "./types.js";

export const SOURCE_ID = keccak256(toHex("COINBASE_ETH_USD_FEED"));

/**
 * Build a delivery of correctly shaped records. `generatedAtOffset` is how far
 * before `now` each record was actually produced upstream. The seller controls
 * when the FILE is assembled; it does not control when the records were made.
 */
export function buildDelivery(count: number, now: bigint, generatedAtOffset: bigint): DeliveredRecord[] {
  const records: DeliveredRecord[] = [];
  for (let i = 0; i < count; i++) {
    const row = JSON.stringify({
      pair: "ETH-USD",
      seq: i,
      priceE8: 300000000000 + i * 137,
      venue: "coinbase",
    });
    records.push({
      index: i,
      bytes: toHex(row),
      generatedAt: now - generatedAtOffset,
      sourceId: SOURCE_ID,
    });
  }
  return records;
}

export const serialiseDelivery = (records: DeliveredRecord[]): Hex =>
  toHex(
    JSON.stringify(
      records.map((r) => ({ i: r.index, b: r.bytes, g: r.generatedAt.toString(), s: r.sourceId })),
    ),
  );

/**
 * NOT RFC-3161. A signature over the delivered file hash and a time.
 * Cryptographically authentic, and about the file only.
 */
export async function signBlobTimestamp(
  issuer: PrivateKeyAccount,
  blobHash: Hex,
  timestampedAt: bigint,
): Promise<SignedBlobTimestamp> {
  const digest = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [blobHash, timestampedAt]),
  );
  const signature = await issuer.signMessage({ message: { raw: digest } });
  return { blobHash, timestampedAt, issuer: issuer.address, signature };
}

export async function assembleFile(
  records: DeliveredRecord[],
  timestampIssuer: PrivateKeyAccount,
  assembledAt: bigint,
): Promise<Delivery> {
  const blobHash = keccak256(serialiseDelivery(records));
  return { records, blobHash, blobTimestamp: await signBlobTimestamp(timestampIssuer, blobHash, assembledAt) };
}

/** The Merkle commitment the upstream issuer will sign, over bound leaves. */
export function commitTo(records: DeliveredRecord[]) {
  const leaves = records.map((r) => leafOf(r.index, keccak256(r.bytes), r.generatedAt, r.sourceId));
  const levels = buildTree(leaves);
  return { leaves, levels, root: rootOf(levels), leafCount: BigInt(leaves.length) };
}
