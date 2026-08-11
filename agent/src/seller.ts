import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { buildTree, leafOf, rootOf } from "./merkle.js";
import type { Delivery, DeliveredRecord, SignedBlobTimestamp } from "./types.js";

export const SOURCE_ID = keccak256(toHex("COINBASE_ETH_USD_FEED"));

/** How far before `now` a record was produced. Constant, or per index. */
export type AgeOffset = bigint | ((index: number) => bigint);

/**
 * A partially refreshed feed: the collector ran current for the first stretch,
 * then the upstream source went stale and only a fraction of records refreshed
 * after that.
 *
 * Scattered rather than blocked on purpose. A contiguous stale tail is the one
 * shape a naive spot check stumbles into by accident, and a delivery that is
 * stale from index 0 makes the counterexample look planted. Interleaving means
 * the head of the file is clean and the breach is real but not where a sampler
 * would look.
 */
export function partiallyStale(freshBy: bigint, staleBy: bigint, onset: number): AgeOffset {
  return (index: number): bigint => (index >= onset && (index * 7 + 3) % 5 !== 0 ? staleBy : freshBy);
}

/**
 * Build a delivery of correctly shaped records. `generatedAtOffset` is how far
 * before `now` each record was actually produced upstream. The seller controls
 * when the FILE is assembled; it does not control when the records were made.
 */
export function buildDelivery(count: number, now: bigint, generatedAtOffset: AgeOffset): DeliveredRecord[] {
  const offsetAt = typeof generatedAtOffset === "function" ? generatedAtOffset : () => generatedAtOffset;
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
      generatedAt: now - offsetAt(i),
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

/**
 * The content address of the delivered payload: the digest of the serialised
 * file. This is what the issuer binds itself to when it names where the
 * committed bytes are retrievable.
 */
export const payloadRefOf = (records: DeliveredRecord[]): Hex => keccak256(serialiseDelivery(records));

/** The Merkle commitment the upstream issuer will sign, over bound leaves. */
export function commitTo(records: DeliveredRecord[]) {
  const leaves = records.map((r) => leafOf(r.index, keccak256(r.bytes), r.generatedAt, r.sourceId));
  const levels = buildTree(leaves);
  return { leaves, levels, root: rootOf(levels), leafCount: BigInt(leaves.length) };
}
