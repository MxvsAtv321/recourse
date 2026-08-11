// Asserts that the runtime bytecode at an address is the artifact's compiled
// output, ignoring immutable spans, which are address dependent by construction.
//
// This is the check that would have caught deploying the wrong contract: three
// deployments of the same contract to three addresses all pass a "has code"
// test and all fail this one.
//
// usage: node scripts/assert-runtime-bytecode.mjs <address> <artifact.json> <rpcUrl>
import { readFileSync } from "node:fs";

const [, , address, artifactPath, rpcUrl] = process.argv;
if (!address || !artifactPath || !rpcUrl) {
  console.error("usage: assert-runtime-bytecode.mjs <address> <artifact.json> <rpcUrl>");
  process.exit(2);
}

const res = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
});
const onchain = (await res.json()).result;

if (!onchain || onchain === "0x") {
  console.error(`  MISMATCH: no code at ${address}`);
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const expected = artifact.deployedBytecode.object;
const immutables = artifact.deployedBytecode.immutableReferences ?? {};

const mask = (hex) => {
  const b = Buffer.from(hex.slice(2), "hex");
  for (const occurrences of Object.values(immutables)) {
    for (const { start, length } of occurrences) b.fill(0, start, start + length);
  }
  return b;
};

if (onchain.length !== expected.length) {
  console.error(
    `  MISMATCH: on-chain runtime is ${onchain.length} chars, artifact is ${expected.length}. ` +
      `Wrong contract at this address, or a different build.`,
  );
  process.exit(1);
}

const a = mask(onchain);
const b = mask(expected);
if (!a.equals(b)) {
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  console.error(`  MISMATCH: ${differing} bytes differ outside immutable spans. Wrong contract or different sources.`);
  process.exit(1);
}

const spans = Object.values(immutables).flat().length;
console.log(`  bytecode matches artifact (${(onchain.length - 2) / 2} bytes, ${spans} immutable span(s) masked)`);
