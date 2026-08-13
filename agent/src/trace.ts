/**
 * The ordered trace section 05 replays.
 *
 * Every field is derived from a real run. The only strings invented here are
 * narrative labels; all counts, hashes, indices and amounts are read off the
 * artifact the engine produced.
 *
 * Dependency free on purpose: the Next.js route imports this type across the
 * workspace boundary, so it must not pull in viem.
 */

export type TraceKind =
  | "PURCHASE_SIGNED"
  | "ESCROW_FUNDED"
  | "COMMITMENT_ACCEPTED"
  | "DELIVERY_RECEIVED"
  | "SCAN_COMPLETE"
  | "BREACH_PROOF_CREATED"
  | "VERIFICATION_GROUP"
  | "REFUND_MINED";

export type TraceCheck = { step: number; label: string; detail: string };

export type TraceEvent = {
  /** Position in the trace. Strictly increasing; the UI never reorders. */
  seq: number;
  kind: TraceKind;
  label: string;
  detail: string;
  facts: Record<string, string | number>;
  checks?: TraceCheck[];
};

export type DemoTrace = {
  source: "live";
  meta: {
    chainId: number;
    rpc: string;
    blockNumber: string;
    escrow: string;
    usdc: string;
    capturedAt: string;
    assetSymbol: string;
    assetDecimals: number;
  };
  amountDisplay: string;
  refundDisplay: string;
  events: TraceEvent[];
};

/** Structural view of what this builder consumes. */
type BreachRun = {
  meta: DemoTrace["meta"];
  protectedPurchase: {
    specHash: string;
    amount: string;
    conditions: { conditionId: number; sourceQuote: string; quantifier: string }[];
    openTx: string;
    commitment: { merkleRoot: string; leafCount: string; issuer: string; txHashes: string[] };
    scan: { totalRecords: number; violations: number; firstViolationIndex: number; thresholdAt: string; shortBySeconds: string };
    proof: { index: string; pathLength: number; verifiedLocally: boolean };
    verification: TraceCheck[];
    settlement: { verdict: string; refundAmount: string; to: string; txHash: string; blockNumber: string; offendingIndex: string };
  };
};

export function formatUnits(base: string, decimals: number): string {
  const n = BigInt(base);
  const d = BigInt(10) ** BigInt(decimals);
  const whole = n / d;
  const frac = (n % d).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toString()}.${frac}`;
}

/**
 * The five groups section 05 shows, in the order submitBreachProof performs
 * them. Steps are assigned by their number so the grouping cannot silently
 * reorder the contract's own sequence; anything unrecognised falls into the
 * final group rather than being dropped.
 */
const GROUPS: { key: string; label: string; blurb: string; steps: number[] }[] = [
  { key: "content-binding", label: "Content binding", blurb: "the leaf is rebuilt from the proof's own inputs", steps: [1] },
  { key: "merkle-inclusion", label: "Merkle inclusion", blurb: "the leaf is inside the committed tree", steps: [2, 3] },
  { key: "purchase-binding", label: "Purchase binding", blurb: "the commitment names this purchase and obligation", steps: [4] },
  { key: "source-authentication", label: "Source authentication", blurb: "the issuer and the origin are the permitted ones", steps: [5, 6] },
  { key: "predicate-violation", label: "Predicate violation", blurb: "the promise is broken, not merely evaluated", steps: [7, 8] },
];

export function buildDemoTrace(run: BreachRun): DemoTrace {
  const p = run.protectedPurchase;
  const dec = run.meta.assetDecimals;
  const sym = run.meta.assetSymbol;
  const amountDisplay = `${formatUnits(p.amount, dec)} ${sym}`;
  const refundDisplay = `${formatUnits(p.settlement.refundAmount, dec)} ${sym}`;

  const events: TraceEvent[] = [];
  const push = (kind: TraceKind, label: string, detail: string, facts: TraceEvent["facts"], checks?: TraceCheck[]) =>
    events.push({ seq: events.length + 1, kind, label, detail, facts, checks });

  push("PURCHASE_SIGNED", "Purchase signed", `${p.conditions.length} conditions, signed by buyer and seller`, {
    specHash: p.specHash,
    conditions: p.conditions.length,
  });

  push("ESCROW_FUNDED", "Escrow funded", `${amountDisplay} moved into escrow`, {
    txHash: p.openTx,
    amount: amountDisplay,
    escrow: run.meta.escrow,
  });

  push("COMMITMENT_ACCEPTED", "Commitment accepted", `upstream issuer signed a root over ${p.commitment.leafCount} leaves`, {
    merkleRoot: p.commitment.merkleRoot,
    leafCount: p.commitment.leafCount,
    issuer: p.commitment.issuer,
    txHash: p.commitment.txHashes[0] ?? "",
  });

  push("DELIVERY_RECEIVED", "Delivery received", `${p.scan.totalRecords} records`, {
    records: p.scan.totalRecords,
  });

  push("SCAN_COMPLETE", "Scan complete", `${p.scan.violations} of ${p.scan.totalRecords} records break the freshness promise`, {
    staleCount: p.scan.violations,
    totalRecords: p.scan.totalRecords,
    firstViolation: p.scan.firstViolationIndex,
    shortBySeconds: p.scan.shortBySeconds,
  });

  push("BREACH_PROOF_CREATED", "Breach proof created", `one counterexample at index ${p.proof.index}`, {
    index: Number(p.proof.index),
    merklePathLength: p.proof.pathLength,
    verifiedLocally: String(p.proof.verifiedLocally),
  });

  const byStep = new Map(p.verification.map((c) => [c.step, c]));
  const claimed = new Set<number>();
  for (const g of GROUPS) {
    const checks = g.steps.map((n) => byStep.get(n)).filter((c): c is TraceCheck => Boolean(c));
    checks.forEach((c) => claimed.add(c.step));
    if (g.key === "predicate-violation") {
      for (const c of p.verification) if (!claimed.has(c.step)) checks.push(c);
    }
    if (!checks.length) continue;
    checks.sort((a, b) => a.step - b.step);
    push("VERIFICATION_GROUP", g.label, g.blurb, { group: g.key, checkCount: checks.length }, checks);
  }

  push("REFUND_MINED", "Refund mined", `${refundDisplay} returned to the buyer`, {
    txHash: p.settlement.txHash,
    amount: refundDisplay,
    blockNumber: p.settlement.blockNumber,
    offendingIndex: p.settlement.offendingIndex,
    verdict: p.settlement.verdict,
    to: p.settlement.to,
  });

  return { source: "live", meta: run.meta, amountDisplay, refundDisplay, events };
}
