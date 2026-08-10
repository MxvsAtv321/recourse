import { encodeAbiParameters, keccak256, recoverMessageAddress, type Address } from "viem";
import { serialiseDelivery } from "./seller.js";
import type { Delivery } from "./types.js";

export type NaiveCheck = { name: string; passed: boolean; detail: string };

/**
 * What an unprotected buyer agent actually checks today. Every one of these
 * passes on a delivery of yesterday's records, because none of them is about
 * when the records were generated.
 */
export async function naiveAcceptanceChecks(
  delivery: Delivery,
  expectedCount: number,
  expectedTimestampIssuer: Address,
  windowSeconds: bigint,
  now: bigint,
): Promise<NaiveCheck[]> {
  const checks: NaiveCheck[] = [];

  checks.push({
    name: "row count",
    passed: delivery.records.length === expectedCount,
    detail: `${delivery.records.length} records, expected ${expectedCount}`,
  });

  const shapeOk = delivery.records.every((r) => {
    try {
      const o = JSON.parse(Buffer.from(r.bytes.slice(2), "hex").toString("utf8"));
      return typeof o.pair === "string" && typeof o.seq === "number" && typeof o.priceE8 === "number";
    } catch {
      return false;
    }
  });
  checks.push({
    name: "schema shape",
    passed: shapeOk,
    detail: "every record parses and carries pair, seq, priceE8",
  });

  const recomputed = keccak256(serialiseDelivery(delivery.records));
  checks.push({
    name: "file hash matches timestamp",
    passed: recomputed === delivery.blobTimestamp.blobHash,
    detail: `${recomputed.slice(0, 18)}...`,
  });

  const digest = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }],
      [delivery.blobTimestamp.blobHash, delivery.blobTimestamp.timestampedAt],
    ),
  );
  const recovered = await recoverMessageAddress({
    message: { raw: digest },
    signature: delivery.blobTimestamp.signature,
  });
  checks.push({
    name: "signed blob timestamp authentic",
    passed: recovered.toLowerCase() === expectedTimestampIssuer.toLowerCase(),
    detail: `signed by ${recovered}`,
  });

  const age = now - delivery.blobTimestamp.timestampedAt;
  checks.push({
    name: "blob timestamp inside window",
    passed: age >= 0n && age <= windowSeconds,
    detail: `file existed ${age}s ago, window is ${windowSeconds}s`,
  });

  return checks;
}
