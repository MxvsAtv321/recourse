"use client";

import { useEffect, useRef, useState } from "react";
import { money, shortHash } from "../../lib/format";
import type { RunArtifact } from "../../lib/run";

const STEP_MS = 260;

/**
 * Reveals the contract's checks in the order the contract performs them, then
 * settles. Every string shown is read from the captured run; the only thing
 * this component invents is the pacing.
 */
export function Verification({
  steps,
  settlement,
  decimals,
  symbol,
}: {
  steps: RunArtifact["protectedPurchase"]["verification"];
  settlement: RunArtifact["protectedPurchase"]["settlement"];
  decimals: number;
  symbol: string;
}) {
  const [started, setStarted] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={host} className="split" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-head">
          <span className="card-title">On-chain verification</span>
          <span className="badge plain">{steps.length} checks</span>
        </div>
        <div className="verify-list">
          {steps.map((s, i) => (
            <div
              key={s.step}
              className="vstep"
              style={{
                animationDelay: started ? `${i * STEP_MS}ms` : "0ms",
                animationPlayState: started ? "running" : "paused",
              }}
            >
              <span className="dot">{s.step}</span>
              <div>
                <div className="label">{s.label}</div>
                <div className="detail">{s.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="refund"
        style={{
          animationDelay: started ? `${steps.length * STEP_MS + 160}ms` : "0ms",
          animationPlayState: started ? "running" : "paused",
        }}
      >
        <div className="refund-top">
          <span className="verdict-tag">Verdict · {settlement.verdict.replace("_", " ")}</span>
          <span className="verdict-tag">No arbiter involved</span>
        </div>

        <div>
          <div className="amount">
            {money(settlement.refundAmount, decimals)}
            <span className="cur">{symbol}</span>
          </div>
          <p className="explain" style={{ marginTop: "0.75rem" }}>
            Refunded in full to the buyer. One record broke an objective promise, so the payment never became
            final.
          </p>
        </div>

        <dl className="refund-grid">
          <div>
            <dt>Offending record</dt>
            <dd>index {settlement.offendingIndex}</dd>
          </div>
          <div>
            <dt>Settled in block</dt>
            <dd>{settlement.blockNumber}</dd>
          </div>
          <div>
            <dt>Escrow balance</dt>
            <dd>
              {money(settlement.escrowBalanceAfter, decimals)} {symbol}
            </dd>
          </div>
        </dl>

        <div>
          <dt style={{ fontSize: "0.68rem", letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.55, fontWeight: 600, marginBottom: "0.4rem" }}>
            Transaction
          </dt>
          <span className="hash on-dark" title={settlement.txHash}>
            {shortHash(settlement.txHash, 22, 12)}
          </span>
        </div>
      </div>
    </div>
  );
}
