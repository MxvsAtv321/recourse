import { concatHex, encodeAbiParameters, keccak256, type Hex } from "viem";

/**
 * The leaf binds content to timestamp in a single preimage. This must stay
 * byte-identical to MerkleBreachVerifier.leafOf.
 *
 *   keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))
 */
export function leafOf(index: number, recordHash: Hex, generatedAt: bigint, sourceId: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [BigInt(index), recordHash, generatedAt, sourceId],
    ),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concatHex([x, y]));
}

/** Sorted pairs, odd node promoted. Mirrors the Solidity verifier's walk. */
export function buildTree(leaves: Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("empty tree");
  const levels: Hex[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const up: Hex[] = [];
    for (let i = 0; i + 1 < cur.length; i += 2) up.push(hashPair(cur[i], cur[i + 1]));
    if (cur.length % 2 === 1) up.push(cur[cur.length - 1]);
    cur = up;
    levels.push(cur);
  }
  return levels;
}

export const rootOf = (levels: Hex[][]): Hex => levels[levels.length - 1][0];

export function pathFor(levels: Hex[][], index: number): Hex[] {
  const path: Hex[] = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = idx ^ 1;
    if (sib < levels[l].length) path.push(levels[l][sib]);
    idx >>= 1;
  }
  return path;
}
