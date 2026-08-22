import { XRay } from "./components/XRay";
import { Verification } from "./components/Verification";
import { compactAddresses, duration, money, pct, shortHash, stamp } from "../lib/format";
import { loadRun } from "../lib/run";
import { buildXRay } from "../../agent/src/xray";

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

/**
 * One page, three acts, no navigation.
 *
 * INSPECT   what an unprotected agent checks, then the claim and which evidence
 *           can establish it.
 * PROTECT   the manifest that gets signed, and the term that is refused.
 * ENFORCE   the escrow. Unchanged: the same Verification component, the same
 *           captured run, the same live path and the same refund panel.
 */
export default function Page() {
  const xray = buildXRay();
  const run = loadRun();

  return (
    <main>
      <header className="masthead">
        <div className="shell masthead-inner">
          <div className="wordmark">
            <strong>Recourse</strong>
            <span>Buyer protection for autonomous commerce</span>
          </div>
          {run ? (
            <span className="livechip">
              <span className="pulse" />
              Live run · {run.meta.chainId === 31337 ? "local anvil" : `chain ${run.meta.chainId}`} · block{" "}
              {run.meta.blockNumber}
            </span>
          ) : null}
        </div>
      </header>

      {/* ============================================================ ACT I */}

      <section className="shell hero">
        <h1>
          Payment becomes final only if nobody can prove the delivery <em>broke its promise</em>.
        </h1>
        <p className="lede">
          An agent buys a data feed. The file is new, signed and correctly shaped, and every check an agent runs today
          passes. The records inside it are yesterday&rsquo;s. Recourse settles that difference with one cryptographic
          counterexample, and no arbiter.
        </p>
        {run ? (
          <div className="hero-meta">
            <div className="metric">
              <span className="k">Order value</span>
              <span className="v">
                {money(run.protectedPurchase.amount, run.meta.assetDecimals)} {run.meta.assetSymbol}
              </span>
            </div>
            <div className="metric">
              <span className="k">Records delivered</span>
              <span className="v">{run.unprotected.recordCount}</span>
            </div>
            <div className="metric">
              <span className="k">Records in breach</span>
              <span className="v">{run.protectedPurchase.scan.violations}</span>
            </div>
            <div className="metric">
              <span className="k">Proofs required</span>
              <span className="v">1</span>
            </div>
          </div>
        ) : null}
      </section>

      {run ? (
        <section className="shell section" data-act="INSPECT">
          <div className="section-head">
            <span className="eyebrow" data-step="INSPECT">
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
                <span className="badge">{run.unprotected.allPassed ? "All passed" : "Failed"}</span>
              </div>
              <div className="checklist">
                {run.unprotected.checks.map((c) => (
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
                        {money(run.unprotected.payment.amount, run.meta.assetDecimals)} {run.meta.assetSymbol}
                      </strong>
                    </dd>
                  </div>
                  <div className="row">
                    <dt>Transaction</dt>
                    <dd>
                      <span className="hash" title={run.unprotected.payment.txHash}>
                        {shortHash(run.unprotected.payment.txHash)}
                      </span>
                    </dd>
                  </div>
                  <div className="row">
                    <dt>Timestamp countersigned by</dt>
                    <dd>
                      <span className="hash" title={run.unprotected.blobTimestamp.issuer}>
                        {shortHash(run.unprotected.blobTimestamp.issuer, 8, 6)}
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
              {run.unprotected.reveal.samples.map((s) => (
                <div className={`stamp ${s.stale ? "stale" : "fresh"}`} key={s.index}>
                  <span className="idx">#{s.index}</span>
                  <span className="when">{stamp(s.generatedAt)}</span>
                  <span className="age">{duration(s.ageSeconds)}</span>
                </div>
              ))}
              <div className="gap-callout">
                <div className="big">
                  <b>{run.unprotected.reveal.staleCount}</b> of {run.unprotected.recordCount} records predate the{" "}
                  {duration(run.unprotected.reveal.windowSeconds)} window
                </div>
                <p>
                  The first {run.unprotected.reveal.firstStaleIndex} records are current, so the head of the file looks
                  clean. Oldest record is {duration(run.unprotected.reveal.oldestAgeSeconds)} old. Blob existence time
                  is not record generation time, and that gap is the whole attack.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="claim-field" data-act="INSPECT">
        <div className="shell">
          <span className="eyebrow" data-step="INSPECT">
            So the buyer states a claim
          </span>
          <h1 className="claim-quote">&ldquo;{xray.claim.quote}&rdquo;</h1>
          <div className="claim-meta">
            <span>
              subject <b>{xray.claim.subject}</b>
            </span>
            <span>
              property <b>{xray.claim.property}</b>
            </span>
            <span>
              threshold <b>{xray.claim.seconds}s</b>
            </span>
            <span>
              clock <b>{xray.claim.frame.replace(/_/g, " ")}</b>
            </span>
          </div>
        </div>
      </section>

      {/* The x-ray, then the manifest and the refusal, are one client component
          so the PROTECT act reveals only once the lanes have resolved. */}
      <section className="shell section" style={{ borderTop: 0, paddingTop: "0.75rem" }} data-act="INSPECT">
        <XRay view={xray} />
      </section>

      {/* =========================================================== ACT III */}

      {run ? (
        <>
          <section className="shell section" data-act="ENFORCE">
            <div className="section-head">
              <span className="eyebrow" data-step="ENFORCE">
                Evidence screening
              </span>
              <h2>The contract refuses the same evidence, before any money moves.</h2>
              <p>
                The x-ray is an analysis. This is the escrow. The seller offered a signed timestamp over the delivered
                file, and <code>openPurchase</code> reverted.
              </p>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="card-title">Condition {run.protectedPurchase.rejectedOffer.conditionId} · offer rejected</span>
                <span className="badge warn">{run.protectedPurchase.rejectedOffer.error}</span>
              </div>
              <div className="card-pad">
                <p style={{ maxWidth: "60ch" }}>
                  It verifies. It is simply not evidence of the thing that was promised.
                </p>
                <p style={{ marginTop: "0.9rem", fontSize: "0.9rem", color: "var(--ink-3)" }}>
                  Escrow balance after the rejection:{" "}
                  {money(run.protectedPurchase.rejectedOffer.escrowBalanceAfter, run.meta.assetDecimals)}{" "}
                  {run.meta.assetSymbol}. Nothing was taken.
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
                    <div className="claim">
                      {run.protectedPurchase.rejectedOffer.offeredEstablishes.replace(/_/g, " ").toLowerCase()}
                    </div>
                    <p>
                      When the delivered file existed. A seller can put yesterday&rsquo;s records into a new file this
                      morning and have it timestamped honestly.
                    </p>
                  </div>
                  <div>
                    <h4>Condition requires</h4>
                    <div className="claim">
                      {run.protectedPurchase.rejectedOffer.conditionRequires.replace(/_/g, " ").toLowerCase()}
                    </div>
                    <p>{run.protectedPurchase.rejectedOffer.whyRejected}</p>
                  </div>
                </div>
              </details>
            </div>
          </section>

          <section className="shell section" data-act="ENFORCE">
            <div className="section-head">
              <span className="eyebrow" data-step="ENFORCE">
                Settlement
              </span>
              <h2>Pay into protection. One counterexample reverses it.</h2>
              <p>
                The buyer&rsquo;s verifier scanned all {run.protectedPurchase.scan.totalRecords} records locally and
                found {run.protectedPurchase.scan.violations} in breach (
                {pct(run.protectedPurchase.scan.violations, run.protectedPurchase.scan.totalRecords)}). It submits
                exactly one, at index {run.protectedPurchase.scan.firstViolationIndex}, with a{" "}
                {run.protectedPurchase.proof.pathLength}-hash Merkle path.
              </p>
            </div>

            <dl className="rows enforce-terms">
              <div className="row">
                <dt>Challenge window</dt>
                <dd>{duration(run.protectedPurchase.challengeWindowSeconds)}</dd>
              </div>
              <div className="row">
                <dt>Delivery deadline</dt>
                <dd>{stamp(run.protectedPurchase.deliveryDeadline)}</dd>
              </div>
              <div className="row">
                <dt>Escrow</dt>
                <dd>
                  <span className="hash" title={run.meta.escrow}>
                    {shortHash(run.meta.escrow, 8, 6)}
                  </span>
                </dd>
              </div>
            </dl>

            <Verification
              steps={run.protectedPurchase.verification}
              settlement={run.protectedPurchase.settlement}
              decimals={run.meta.assetDecimals}
              symbol={run.meta.assetSymbol}
              amount={run.protectedPurchase.amount}
            />
          </section>

          <section className="shell section" data-act="ENFORCE">
            <div className="section-head">
              <span className="eyebrow" data-step="ENFORCE">
                Also verified this run
              </span>
              <h2>The other two ways this ends.</h2>
            </div>
            <div className="outcomes">
              <div className="card outcome">
                <span className="badge">Release</span>
                <span className="verdict">
                  {money(run.release.amount, run.meta.assetDecimals)} {run.meta.assetSymbol} to the seller
                </span>
                <p>
                  A compliant delivery: {run.release.violations} violations across {run.unprotected.recordCount}{" "}
                  records, and the scalar row count evaluated at {run.release.scalarObserved} against a threshold of{" "}
                  {run.release.scalarThreshold}. Releasing early reverts with {run.release.earlyReleaseError}.
                </p>
                <span className="hash" title={run.release.txHash}>
                  {shortHash(run.release.txHash)}
                </span>
              </div>
              <div className="card outcome">
                <span className="badge warn">Stalled</span>
                <span className="verdict">
                  {money(run.stalled.amount, run.meta.assetDecimals)} {run.meta.assetSymbol} reclaimed
                </span>
                <p>
                  The seller took the order and never delivered: {run.stalled.committed} of {run.stalled.required}{" "}
                  conditions committed at the deadline. Non-delivery is the trivial breach. Reclaiming early reverts
                  with {run.stalled.earlyReclaimError}.
                </p>
                <span className="hash" title={run.stalled.txHash}>
                  {shortHash(run.stalled.txHash)}
                </span>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="shell section" data-act="ENFORCE">
          <div className="section-head">
            <span className="eyebrow" data-step="ENFORCE">
              Settlement
            </span>
            <h2>No captured run.</h2>
            <p>
              INSPECT and PROTECT above need no chain and are computed from the frozen fixtures. The enforcement act
              renders values from a real run only. Start anvil, then <code>npm run capture</code>.
            </p>
          </div>
        </section>
      )}

      <footer className="shell foot">
        {run ? (
          <div>
            Every enforcement figure on this page was produced by a live run against anvil at {run.meta.rpc}, chain{" "}
            {run.meta.chainId}, block {run.meta.blockNumber}, captured{" "}
            {new Date(run.meta.capturedAt).toISOString().replace("T", " ").slice(0, 19)} UTC.
          </div>
        ) : null}
        <div>
          Evidence fixtures recorded {xray.observedWindow}, never re-fetched.
          {run ? (
            <>
              {" "}
              Escrow {shortHash(run.meta.escrow, 10, 8)} · asset {shortHash(run.meta.usdc, 10, 8)} · upstream issuer{" "}
              {shortHash(run.meta.accounts.upstream, 10, 8)}
            </>
          ) : null}
        </div>
      </footer>
    </main>
  );
}
