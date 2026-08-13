"use client";

import { useEffect, useRef, useState } from "react";
import { money, shortHash } from "../../lib/format";
import type { DemoTrace, TraceEvent } from "../../../agent/src/trace";

/** Comfortably above the 400ms floor for a visible transition. */
const STEP_MS = 480;

type CapturedStep = { step: number; label: string; detail: string };
type CapturedSettlement = {
  verdict: string;
  refundAmount: string;
  to: string;
  txHash: string;
  blockNumber: string;
  offendingIndex: string;
  escrowBalanceAfter: string;
};

type Phase = "idle" | "running" | "live" | "captured";

export function Verification({
  steps,
  settlement,
  decimals,
  symbol,
  amount,
}: {
  steps: CapturedStep[];
  settlement: CapturedSettlement;
  decimals: number;
  symbol: string;
  amount: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [trace, setTrace] = useState<DemoTrace | null>(null);
  const [visible, setVisible] = useState(0);
  const [note, setNote] = useState<string>("");
  const started = useRef(false);

  // Reveal one event at a time. Order is structural: we only ever increment,
  // so an event can never appear before the one that precedes it.
  useEffect(() => {
    if (phase !== "live" || !trace) return;
    if (visible >= trace.events.length) return;
    const t = setTimeout(() => setVisible((v) => v + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [phase, trace, visible]);

  async function run() {
    if (started.current) return; // exactly one run
    started.current = true;
    setPhase("running");
    try {
      const res = await fetch("/api/demo/breach", { method: "POST" });
      if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
      const data = (await res.json()) as DemoTrace;
      if (!data?.events?.length) throw new Error("empty trace");
      setTrace(data);
      setVisible(1);
      setPhase("live");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "live execution unavailable");
      setPhase("captured");
    }
  }

  const shown = trace ? trace.events.slice(0, visible) : [];
  const last = shown[shown.length - 1];
  const refundEvent = shown.find((e) => e.kind === "REFUND_MINED");

  if (phase === "idle" || phase === "running") {
    return (
      <div className="split" style={{ alignItems: "start" }} data-phase={phase} data-trace-source="none">
        <div className="card pay">
          <div className="card-head">
            <span className="card-title">Settlement</span>
            <span className="badge plain">{phase === "running" ? "Executing" : "Ready"}</span>
          </div>
          <div className="pay-body">
            <div>
              <div className="amount">
                {money(amount, decimals)}
                <span className="cur">{symbol}</span>
              </div>
              <p style={{ color: "var(--ink-3)", fontSize: "0.9rem", marginTop: "0.4rem" }}>
                Runs the breach scenario against the local chain and settles it for real.
              </p>
            </div>
            <button className="btn" type="button" onClick={run} disabled={phase === "running"} data-testid="protect-and-pay">
              <svg className="lock" viewBox="0 0 16 16" aria-hidden>
                <rect x="3" y="7" width="10" height="7" rx="1.6" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
              </svg>
              {phase === "running" ? "Executing on chain…" : `Protect & Pay · ${money(amount, decimals)} ${symbol}`}
            </button>
            <p className="pay-note">
              {phase === "running"
                ? "Deploying, funding, committing, proving and settling."
                : "One purchase, one counterexample, one refund."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "captured") {
    return (
      <div className="split" style={{ alignItems: "start" }} data-phase="captured" data-trace-source="captured">
        <div className="card">
          <div className="card-head">
            <span className="card-title">On-chain verification</span>
            <span className="badge plain" data-testid="provenance-label">
              Captured verified run
            </span>
          </div>
          <div className="verify-list">
            {steps.map((s) => (
              <div key={s.step} className="vstep" data-seq={s.step}>
                <span className="dot">{s.step}</span>
                <div>
                  <div className="label">{s.label}</div>
                  <div className="detail">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          {note ? (
            <div className="card-pad" style={{ borderTop: "1px solid var(--line)" }}>
              <p style={{ fontSize: "0.86rem", color: "var(--ink-3)" }}>
                Live execution was unavailable, so this is the verified run captured earlier. Reason: {note}.
              </p>
            </div>
          ) : null}
        </div>
        <RefundPanel
          verdict={settlement.verdict}
          amountText={`${money(settlement.refundAmount, decimals)} ${symbol}`}
          offendingIndex={settlement.offendingIndex}
          blockNumber={settlement.blockNumber}
          escrowText={`${money(settlement.escrowBalanceAfter, decimals)} ${symbol}`}
          txHash={settlement.txHash}
          provenance="Captured verified run"
        />
      </div>
    );
  }

  // live
  return (
    <div className="split" style={{ alignItems: "start" }} data-phase="live" data-trace-source="live">
      <div className="card">
        <div className="card-head">
          <span className="card-title">On-chain verification</span>
          <span className="badge" data-testid="provenance-label">
            Live local execution
          </span>
        </div>
        <div className="verify-list" data-testid="trace-list">
          {shown.map((ev) => (
            <div key={ev.seq} className="vstep" data-seq={ev.seq} data-kind={ev.kind}>
              <span className="dot">{ev.seq}</span>
              <div>
                <div className="label">{ev.label}</div>
                <div className="detail">{ev.detail}</div>
                {ev.checks?.length ? (
                  <div style={{ marginTop: "0.35rem", display: "grid", gap: "0.15rem" }}>
                    {ev.checks.map((c) => (
                      <div key={c.step} className="detail">
                        {c.label} — {c.detail}
                      </div>
                    ))}
                  </div>
                ) : null}
                <FactLine ev={ev} />
              </div>
            </div>
          ))}
        </div>
        <div className="card-pad" style={{ borderTop: "1px solid var(--line)" }}>
          <p style={{ fontSize: "0.86rem", color: "var(--ink-3)" }}>
            {visible < (trace?.events.length ?? 0)
              ? `Replaying step ${visible} of ${trace?.events.length}: ${last?.label ?? ""}`
              : `chain ${trace?.meta.chainId} · block ${trace?.meta.blockNumber} · escrow ${shortHash(trace?.meta.escrow ?? "", 8, 6)}`}
          </p>
        </div>
      </div>

      {refundEvent ? (
        <RefundPanel
          verdict={String(refundEvent.facts.verdict ?? "BREACH_PROVED")}
          amountText={String(refundEvent.facts.amount)}
          offendingIndex={String(refundEvent.facts.offendingIndex)}
          blockNumber={String(refundEvent.facts.blockNumber)}
          escrowText="0.00 USDC"
          txHash={String(refundEvent.facts.txHash)}
          provenance="Live local execution"
        />
      ) : (
        <div />
      )}
    </div>
  );
}

/** Renders whichever real values this event carries, never a placeholder. */
function FactLine({ ev }: { ev: TraceEvent }) {
  const bits: { k: string; v: string }[] = [];
  const f = ev.facts;
  if (f.txHash) bits.push({ k: "tx", v: shortHash(String(f.txHash), 10, 6) });
  if (f.merkleRoot) bits.push({ k: "root", v: shortHash(String(f.merkleRoot), 10, 6) });
  if (f.specHash) bits.push({ k: "spec", v: shortHash(String(f.specHash), 10, 6) });
  if (f.records !== undefined) bits.push({ k: "records", v: String(f.records) });
  if (f.staleCount !== undefined) bits.push({ k: "stale", v: String(f.staleCount) });
  if (f.firstViolation !== undefined) bits.push({ k: "first violation", v: String(f.firstViolation) });
  if (f.index !== undefined) bits.push({ k: "index", v: String(f.index) });
  if (f.leafCount) bits.push({ k: "leaves", v: String(f.leafCount) });
  if (!bits.length) return null;
  return (
    <div style={{ marginTop: "0.4rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
      {bits.map((b) => (
        <span key={b.k} className="hash" title={`${b.k}: ${b.v}`}>
          {b.k} {b.v}
        </span>
      ))}
    </div>
  );
}

function RefundPanel({
  verdict,
  amountText,
  offendingIndex,
  blockNumber,
  escrowText,
  txHash,
  provenance,
}: {
  verdict: string;
  amountText: string;
  offendingIndex: string;
  blockNumber: string;
  escrowText: string;
  txHash: string;
  provenance: string;
}) {
  const [value, unit] = amountText.split(" ");
  return (
    <div className="refund" data-testid="refund-panel">
      <div className="refund-top">
        <span className="verdict-tag">Verdict · {verdict.replace("_", " ")}</span>
        <span className="verdict-tag">{provenance}</span>
      </div>

      <div>
        <div className="amount">
          {value}
          <span className="cur">{unit}</span>
        </div>
        <p className="explain" style={{ marginTop: "0.75rem" }}>
          Refunded in full to the buyer. One record broke an objective promise, so the payment never became final.
        </p>
      </div>

      <dl className="refund-grid">
        <div>
          <dt>Offending record</dt>
          <dd>index {offendingIndex}</dd>
        </div>
        <div>
          <dt>Settled in block</dt>
          <dd>{blockNumber}</dd>
        </div>
        <div>
          <dt>Escrow balance</dt>
          <dd>{escrowText}</dd>
        </div>
      </dl>

      <div>
        <dt
          style={{
            fontSize: "0.68rem",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            opacity: 0.55,
            fontWeight: 600,
            marginBottom: "0.4rem",
          }}
        >
          Transaction
        </dt>
        <span className="hash on-dark" title={txHash} data-testid="refund-tx">
          {shortHash(txHash, 22, 12)}
        </span>
      </div>
    </div>
  );
}
