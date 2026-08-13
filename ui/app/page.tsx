import { Verification } from "./components/Verification";
import { compactAddresses, duration, money, pct, shortHash, stamp } from "../lib/format";
import { loadRun } from "../lib/run";

export const dynamic = "force-dynamic";

function Tick({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "tick" : "tick bad"} aria-hidden>
      <svg viewBox="0 0 12 12">
        {ok ? <path d="M2 6.4 4.6 9 10 3.2" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

export default function Page() {
  const run = loadRun();

  if (!run) {
    return (
      <main className="shell empty">
        <h1>No captured run</h1>
        <p className="lede">
          This page only renders values produced by a live run. Start anvil, then run <code>npm run capture</code> to
          execute the five scenarios and write the artifact.
        </p>
      </main>
    );
  }

  const { meta, unprotected, protectedPurchase: prot, release, unprotectable, stalled } = run;
  const dec = meta.assetDecimals;
  const sym = meta.assetSymbol;

  return (
    <main>
      <header className="masthead">
        <div className="shell masthead-inner">
          <div className="wordmark">
            <strong>Recourse</strong>
            <span>Buyer protection for autonomous commerce</span>
          </div>
          <span className="livechip">
            <span className="pulse" />
            Live run · {meta.chainId === 31337 ? "local anvil" : `chain ${meta.chainId}`} · block{" "}
            {meta.blockNumber}
          </span>
        </div>
      </header>

      <section className="shell hero">
        <h1>
          Payment becomes final only if nobody can prove the delivery <em>broke its promise</em>.
        </h1>
        <p className="lede">
          An agent buys a data feed. The file is new, signed and correctly shaped, and every check an agent runs today
          passes. The records inside it are yesterday&rsquo;s. Recourse settles that difference with one cryptographic
          counterexample, and no arbiter.
        </p>
        <div className="hero-meta">
          <div className="metric">
            <span className="k">Order value</span>
            <span className="v">
              {money(prot.amount, dec)} {sym}
            </span>
          </div>
          <div className="metric">
            <span className="k">Records delivered</span>
            <span className="v">{unprotected.recordCount}</span>
          </div>
          <div className="metric">
            <span className="k">Records in breach</span>
            <span className="v">{prot.scan.violations}</span>
          </div>
          <div className="metric">
            <span className="k">Proofs required</span>
            <span className="v">1</span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 1 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="01">
            Today&rsquo;s normal
          </span>
          <h2>Every check passes. The money is gone.</h2>
          <p>
            This is an unprotected purchase, settled directly to the seller. The buyer&rsquo;s agent verifies the row
            count, the schema, and an independent timestamp over the delivered file.
          </p>
        </div>

        <div className="split">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Acceptance checks</span>
              <span className="badge">{unprotected.allPassed ? "All passed" : "Failed"}</span>
            </div>
            <div className="checklist">
              {unprotected.checks.map((c) => (
                <div className="check" key={c.name}>
                  <Tick ok={c.passed} />
                  <span className="check-name">{c.name}</span>
                  <span className="check-detail">{compactAddresses(c.detail)}</span>
                </div>
              ))}
            </div>
            <div className="card-pad" style={{ borderTop: "1px solid var(--line)" }}>
              <dl className="rows">
                <div className="row">
                  <dt>Settled to seller</dt>
                  <dd>
                    <strong>
                      {money(unprotected.payment.amount, dec)} {sym}
                    </strong>
                  </dd>
                </div>
                <div className="row">
                  <dt>Transaction</dt>
                  <dd>
                    <span className="hash" title={unprotected.payment.txHash}>
                      {shortHash(unprotected.payment.txHash)}
                    </span>
                  </dd>
                </div>
                <div className="row">
                  <dt>Timestamp countersigned by</dt>
                  <dd>
                    <span className="hash" title={unprotected.blobTimestamp.issuer}>
                      {shortHash(unprotected.blobTimestamp.issuer, 8, 6)}
                    </span>
                  </dd>
                </div>
              </dl>
              <p style={{ marginTop: "1rem", fontSize: "0.9rem", color: "var(--ink-3)" }}>
                Final and irreversible. The timestamp is authentic and the signer had nothing to gain.
              </p>
            </div>
          </div>

          <div className="reveal-panel">
            <div className="card-head">
              <span className="card-title">Per-record generation time</span>
              <span className="card-note">nobody checked this</span>
            </div>
            {unprotected.reveal.samples.map((s) => (
              <div className={`stamp ${s.stale ? "stale" : "fresh"}`} key={s.index}>
                <span className="idx">#{s.index}</span>
                <span className="when">{stamp(s.generatedAt)}</span>
                <span className="age">{duration(s.ageSeconds)}</span>
              </div>
            ))}
            <div className="gap-callout">
              <div className="big">
                <b>{unprotected.reveal.staleCount}</b> of {unprotected.recordCount} records predate the{" "}
                {duration(unprotected.reveal.windowSeconds)} window
              </div>
              <p>
                The first {unprotected.reveal.firstStaleIndex} records are current, so the head of the file looks clean.
                Oldest record is {duration(unprotected.reveal.oldestAgeSeconds)} old. Blob existence time is not record
                generation time, and that gap is the whole attack.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 2 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="02">
            Protection
          </span>
          <h2>What the listing promised, and what we can prove.</h2>
          <p>
            Each phrase in the seller&rsquo;s listing is compiled into a machine-checkable condition, or it is not
            protected at all. The phrase that generated each condition stays attached to it, and so does the
            difference between what we can prove from the delivery and what we are taking the issuer&rsquo;s word for.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Protection panel · {prot.conditions.length} conditions</span>
            <span className="badge">
              {prot.conditions.filter((c) => c.quantifier === "UNIVERSAL").length} proved from delivery ·{" "}
              {prot.conditions.filter((c) => c.quantifier === "SCALAR").length} issuer attested
            </span>
          </div>
          {prot.conditions.map((c) => {
            const provedFromDelivery = c.quantifier === "UNIVERSAL";
            return (
            <div className="condition" key={c.conditionId}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                <blockquote className="quote" style={{ margin: 0, flex: "1 1 320px" }}>
                  <span className="quote-src">From the listing</span>
                  &ldquo;{c.sourceQuote}&rdquo;
                </blockquote>
                <span className={provedFromDelivery ? "badge" : "badge plain"}>
                  {provedFromDelivery ? "Protected" : "Issuer attested"}
                </span>
              </div>
              <dl className="spec-grid">
                <div>
                  <dt>Claim</dt>
                  <dd>{c.claimType.replace(/_/g, " ").toLowerCase()}</dd>
                </div>
                <div>
                  <dt>Quantifier</dt>
                  <dd>{c.quantifier.toLowerCase()}</dd>
                </div>
                <div>
                  <dt>Test</dt>
                  <dd>{c.opcode}</dd>
                </div>
                <div>
                  <dt>Threshold</dt>
                  <dd>
                    {c.thresholdKind === "timestamp"
                      ? stamp(c.threshold)
                      : `${Number(c.threshold).toLocaleString("en-US")} leaves claimed`}
                  </dd>
                </div>
                <div>
                  <dt>Settles by</dt>
                  <dd>{c.settlement}</dd>
                </div>
              </dl>
              <p style={{ fontSize: "0.88rem", color: "var(--ink-3)", maxWidth: "62ch" }}>
                {provedFromDelivery
                  ? "Proved from leaves the buyer holds. A single record that breaks this refunds the purchase, so the seller cannot assert its way out of it."
                  : "Establishes that the permitted issuer signed a commitment whose leaf count reads " +
                    `${Number(c.threshold).toLocaleString("en-US")}. It does not establish that the tree holds that many leaves, nor that the buyer received that many records. Authentic evidence can still prove the wrong claim, and this is where that applies to us.`}
              </p>
            </div>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------- 3 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="03">
            Evidence screening
          </span>
          <h2>Authentic evidence, for the wrong claim.</h2>
          <p>
            Before any money moves, the seller&rsquo;s offered evidence is compared against what the condition actually
            requires. This rejection happened pre-payment.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Condition {prot.rejectedOffer.conditionId} · offer rejected</span>
            <span className="badge warn">{prot.rejectedOffer.error}</span>
          </div>
          <div className="card-pad">
            <p style={{ maxWidth: "60ch" }}>
              The seller offered a signed timestamp over the delivered file. It verifies. It is simply not evidence of
              the thing that was promised.
            </p>
            <p style={{ marginTop: "0.9rem", fontSize: "0.9rem", color: "var(--ink-3)" }}>
              Escrow balance after the rejection: {money(prot.rejectedOffer.escrowBalanceAfter, dec)} {sym}. Nothing was
              taken.
            </p>
          </div>
          <details className="disclose" open>
            <summary>
              <span className="chev" aria-hidden />
              Compare what was offered against what was required
            </summary>
            <div className="versus">
              <div>
                <h4>Evidence offered establishes</h4>
                <div className="claim">{prot.rejectedOffer.offeredEstablishes.replace(/_/g, " ").toLowerCase()}</div>
                <p>When the delivered file existed. A seller can put yesterday&rsquo;s records into a new file this morning and have it timestamped honestly.</p>
              </div>
              <div>
                <h4>Condition requires</h4>
                <div className="claim">{prot.rejectedOffer.conditionRequires.replace(/_/g, " ").toLowerCase()}</div>
                <p>{prot.rejectedOffer.whyRejected}</p>
              </div>
            </div>
          </details>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 4 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="04">
            Checkout
          </span>
          <h2>Pay into protection, not to the seller.</h2>
          <p>
            Once the evidence matches the claim, the buyer funds an escrow. The seller is paid only if the delivery
            survives its challenge window.
          </p>
        </div>

        <div className="card pay">
          <div className="card-head">
            <span className="card-title">Order</span>
            <span className="badge">Protected</span>
          </div>
          <div className="pay-body">
            <div>
              <div className="amount">
                {money(prot.amount, dec)}
                <span className="cur">{sym}</span>
              </div>
              <p style={{ color: "var(--ink-3)", fontSize: "0.9rem", marginTop: "0.4rem" }}>
                ETH-USD spot feed · {unprotected.recordCount} records
              </p>
            </div>
            <dl className="rows">
              <div className="row">
                <dt>Conditions</dt>
                <dd>
                  {prot.conditions.filter((c) => c.quantifier === "UNIVERSAL").length} proved ·{" "}
                  {prot.conditions.filter((c) => c.quantifier === "SCALAR").length} attested
                </dd>
              </div>
              <div className="row">
                <dt>Challenge window</dt>
                <dd>{duration(prot.challengeWindowSeconds)}</dd>
              </div>
              <div className="row">
                <dt>Delivery deadline</dt>
                <dd>{stamp(prot.deliveryDeadline)}</dd>
              </div>
              <div className="row">
                <dt>Escrow</dt>
                <dd>
                  <span className="hash" title={meta.escrow}>
                    {shortHash(meta.escrow, 8, 6)}
                  </span>
                </dd>
              </div>
            </dl>
            <button className="btn" type="button">
              <svg className="lock" viewBox="0 0 16 16" aria-hidden>
                <rect x="3" y="7" width="10" height="7" rx="1.6" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
              </svg>
              Protect &amp; Pay {money(prot.amount, dec)} {sym}
            </button>
            <p className="pay-note">
              Funds released to the seller only after the challenge window closes with no valid proof of breach.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 5 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="05">
            Settlement
          </span>
          <h2>One counterexample reverses the payment.</h2>
          <p>
            The buyer&rsquo;s verifier scanned all {prot.scan.totalRecords} records locally and found{" "}
            {prot.scan.violations} in breach ({pct(prot.scan.violations, prot.scan.totalRecords)}). It submitted exactly
            one, at index {prot.scan.firstViolationIndex}, with a {prot.proof.pathLength}-hash Merkle path.
          </p>
        </div>

        <Verification
          steps={prot.verification}
          settlement={prot.settlement}
          decimals={dec}
          symbol={sym}
          amount={prot.amount}
        />
      </section>

      {/* ---------------------------------------------------------------- 6 */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="06">
            Limits
          </span>
          <h2>Some promises cannot be proved.</h2>
          <p>
            When a term maps to no supported condition, no protected payment opens. That is a normal outcome, and
            saying so is more honest than pretending to check it.
          </p>
        </div>

        <div className="unprot">
          <div>
            <span className="quote-src">Term that could not be objectively verified</span>
            <div className="term">&ldquo;{unprotectable.phrase}&rdquo;</div>
          </div>
          <p style={{ color: "var(--ink-2)", maxWidth: "60ch" }}>
            {unprotectable.reason}. &ldquo;High quality&rdquo; is not objectively falsifiable, so no counterexample
            could ever exist. We do not stretch a test to cover it, and we do not ask a model to judge it.
          </p>
          <div>
            <span className="quote-src">The complete vocabulary, which never grows to fit a term</span>
            <div className="vocab">
              {unprotectable.opcodes.map((o) => (
                <span className="chip" key={o}>
                  {o}
                </span>
              ))}
            </div>
          </div>
          <p style={{ fontSize: "0.9rem", color: "var(--ink-3)" }}>
            Escrow opened: none. The buyer may still transact unprotected. It just knows that it is unprotected.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------- other outcomes */}
      <section className="shell section">
        <div className="section-head">
          <span className="eyebrow" data-step="+">
            Also verified this run
          </span>
          <h2>The other two ways this ends.</h2>
        </div>
        <div className="outcomes">
          <div className="card outcome">
            <span className="badge">Release</span>
            <span className="verdict">
              {money(release.amount, dec)} {sym} to the seller
            </span>
            <p>
              A compliant delivery: {release.violations} violations across {unprotected.recordCount} records, and the
              scalar row count evaluated at {release.scalarObserved} against a threshold of {release.scalarThreshold}.
              Releasing early reverts with {release.earlyReleaseError}.
            </p>
            <span className="hash" title={release.txHash}>
              {shortHash(release.txHash)}
            </span>
          </div>
          <div className="card outcome">
            <span className="badge warn">Stalled</span>
            <span className="verdict">
              {money(stalled.amount, dec)} {sym} reclaimed
            </span>
            <p>
              The seller took the order and never delivered: {stalled.committed} of {stalled.required} conditions
              committed at the deadline. Non-delivery is the trivial breach. Reclaiming early reverts with{" "}
              {stalled.earlyReclaimError}.
            </p>
            <span className="hash" title={stalled.txHash}>
              {shortHash(stalled.txHash)}
            </span>
          </div>
        </div>
      </section>

      <footer className="shell foot">
        <div>
          Every figure on this page was produced by a live run against anvil at {meta.rpc}, chain {meta.chainId}, block{" "}
          {meta.blockNumber}, captured {new Date(meta.capturedAt).toISOString().replace("T", " ").slice(0, 19)} UTC.
        </div>
        <div>
          Escrow {shortHash(meta.escrow, 10, 8)} · asset {shortHash(meta.usdc, 10, 8)} · upstream issuer{" "}
          {shortHash(meta.accounts.upstream, 10, 8)}
        </div>
      </footer>
    </main>
  );
}
