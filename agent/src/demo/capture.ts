import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAll } from "../engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "..", "ui", "data", "run.json");

const artifact = await runAll();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`captured live run -> ${OUT}`);
console.log(`  chainId ${artifact.meta.chainId}  block ${artifact.meta.blockNumber}`);
console.log(`  escrow  ${artifact.meta.escrow}`);
console.log(`  1 UNPROTECTED    paid ${artifact.unprotected.payment.txHash}`);
console.log(`  2 BREACH_PROVED  refund ${artifact.protectedPurchase.settlement.txHash}`);
console.log(`  3 RELEASE        ${artifact.release.txHash}`);
console.log(`  4 UNPROTECTABLE  "${artifact.unprotectable.phrase}"`);
console.log(`  5 STALLED        ${artifact.stalled.txHash}`);
