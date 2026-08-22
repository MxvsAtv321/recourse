import type { XRayView } from "../../../agent/src/xray";

/**
 * PROTECT: the purchasing policy, the manifest and the refusal.
 *
 * The lane board that used to live here is replaced by the compile surface,
 * which reports the same failures as typed errors against exact source spans.
 * Nothing below is gated behind an animation any more: it renders on the server
 * and a dead client costs nothing.
 */
export function XRay({ view }: { view: XRayView }) {
  return (
    <>
      <PolicyPanel view={view} />
      {view.manifest ? <ManifestPanel view={view} /> : null}
      {view.refusal ? <RefusalPanel view={view} /> : null}
    </>
  );
}

/**
 * The policy is the buyer's input, not a result of the animation, so it is never
 * gated behind the lanes resolving. A judge must be able to read the rule and
 * execute it themselves at any point on the page.
 */
function PolicyPanel({ view }: { view: XRayView }) {
  const d = view.decision;
  return (
    <section className="policy-act" style={{ marginTop: "3.5rem" }} data-act="PROTECT">
      <span className="eyebrow" data-step="PROTECT">
        Purchasing policy
      </span>
      <h2 style={{ marginTop: "0.5rem" }}>The buyer decides. Deterministically.</h2>

      <dl className="policy-obj">
        <div>
          <dt>maxPrice</dt>
          <dd>{d.policy.maxPrice} per call</dd>
        </div>
        <div>
          <dt>requiredClaim</dt>
          <dd>&ldquo;{d.policy.requiredClaim}&rdquo;</dd>
        </div>
        <div>
          <dt>protectionMandatory</dt>
          <dd>{String(d.policy.protectionMandatory)}</dd>
        </div>
        <div className="rule">
          <dt>selectionRule</dt>
          <dd>{d.policy.selectionRule}</dd>
        </div>
      </dl>

      <div className="offers">
        {d.offers.map((o) => (
          <article className={o.selected ? "offer selected" : "offer"} key={o.id} data-offer={o.id}>
            <div className="offer-head">
              <div>
                <span className="v">{o.vendor}</span>
                <span className="e">{o.endpoint}</span>
              </div>
              <span className="p">{o.price}</span>
            </div>
            <span className={o.selected ? "ostate sel" : "ostate ref"}>
              {o.selected ? "Selected by the policy" : "Policy not satisfied"}
            </span>
            <p className="ad">&ldquo;{o.advertises}&rdquo;</p>

            <div className="pchecks">
              {o.checks.map((c) => (
                <div className={c.passed ? "pcheck ok" : "pcheck no"} key={c.label}>
                  <span className="m" aria-hidden>
                    {c.passed ? "\u2713" : "\u2715"}
                  </span>
                  <span className="l">{c.label}</span>
                  <p className="d">{c.detail}</p>
                </div>
              ))}
            </div>

            {o.manifest ? (
              <div className="sigbox">
                <div className="sighead">
                  signed protection manifest, served at <code>{o.manifest.servedAt}</code>
                </div>
                <dl>
                  {o.manifest.fields.map((f) => (
                    <div key={f.k}>
                      <dt>{f.k}</dt>
                      <dd>{f.v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="roles">
                  <div>
                    <span className="rk">seller signed</span>
                    <span className="rv">{o.manifest.signer}</span>
                  </div>
                  <div>
                    <span className="rk">permittedIssuer named inside</span>
                    <span className="rv">{o.manifest.permittedIssuer}</span>
                  </div>
                </div>
                <p className="rolenote">
                  {o.manifest.rolesSeparate
                    ? "Two different keys. The seller signs what is promised. The issuer signs what was observed, and only the issuer's signature is what the escrow checks at settlement."
                    : "One key signs both, which collapses the two trust roles."}
                </p>
                <div className="sig">{o.manifest.signature}</div>
              </div>
            ) : null}

            <div className={o.eligible ? "presult ok" : "presult no"}>
              {o.eligible ? (
                <>
                  <b>Policy result: eligible.</b> {o.selected ? "Lowest priced offer satisfying the policy." : ""}
                </>
              ) : (
                o.refusal
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="decision" data-result={d.result}>
        <span className="dk">policy result</span>
        <span className="dv">{d.result.replace(/_/g, " ")}</span>
        <p>{d.rationale}</p>
        <p className="funded">
          The escrow funds {d.fundedPrice}, which is {d.fundedBaseUnits} base units of a six decimal asset, and that is
          the advertised price of the selected offer.
        </p>
      </div>
    </section>
  );
}

/** The buyer's own sentence, with every sourced literal highlighted in place. */
function Highlighted({ text, spans }: { text: string; spans: [number, number][] }) {
  if (spans.length === 0) return <>{text}</>;
  const ordered = [...spans].sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  ordered.forEach(([a, b], i) => {
    if (a > at) out.push(<span key={`t${i}`}>{text.slice(at, a)}</span>);
    out.push(<mark key={`m${i}`}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);
  return <>{out}</>;
}

function ManifestPanel({ view }: { view: XRayView }) {
  const m = view.manifest!;
  const spans = m.literals.map((l) => l.span).filter((s): s is [number, number] => s !== null);
  return (
    <section className="manifest-wrap on" style={{ marginTop: "3.5rem" }}>
      <span className="eyebrow" data-step="PROTECT">
        Protection manifest
      </span>
      <h2 style={{ marginTop: "0.5rem" }}>One path is enforceable. This is what gets signed.</h2>

      <p className="src-line" style={{ marginTop: "1.4rem" }}>
        &ldquo;
        <Highlighted text={m.requirement} spans={spans} />
        &rdquo;
      </p>

      <dl className="mf-grid">
        <div className="mf-cell">
          <dt>claim type</dt>
          <dd className="mono">{m.claimType}</dd>
        </div>
        <div className="mf-cell">
          <dt>quantifier</dt>
          <dd>{m.quantifier}</dd>
        </div>
        <div className="mf-cell">
          <dt>opcode</dt>
          <dd className="mono">{m.opcode}</dd>
        </div>
        <div className="mf-cell">
          <dt>settles by</dt>
          <dd>{m.settlesBy.toLowerCase()}</dd>
        </div>
      </dl>

      <dl className="mf-grid">
        {m.literals.map((l) => (
          <div className="mf-cell" key={l.label}>
            <dt>{l.label}</dt>
            <dd className={/^0x[0-9a-fA-F]{40}$/.test(l.value) ? "mono addr" : "mono"}>{l.value}</dd>
            {l.quote !== null && l.span !== null ? (
              <div className="prov">
                requirement[{l.span[0]}..{l.span[1]}] &ldquo;{l.quote}&rdquo;
              </div>
            ) : (
              <div className="prov policy">policy.{l.policyField}</div>
            )}
          </div>
        ))}
      </dl>

      <dl className="mf-grid">
        <div className="mf-cell">
          <dt>required evidence</dt>
          <dd className="mono">{m.requiredEvidence.property}</dd>
          <div className="prov addr">
            binding {m.requiredEvidence.binding}, {m.requiredEvidence.attestation}
          </div>
        </div>
        <div className="mf-cell" style={{ gridColumn: "span 2" }}>
          <dt>the commitment binds</dt>
          <dd className="mono" style={{ fontSize: "0.9rem" }}>
            {m.requiredEvidence.commitsTo.join("  ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RefusalPanel({ view }: { view: XRayView }) {
  const r = view.refusal!;
  return (
    <section className="manifest-wrap on refusal">
      <span className="eyebrow" data-step="LIMIT">
        {r.status}
      </span>
      <p className="refusal-term">&ldquo;{r.requirement}&rdquo;</p>
      <p style={{ color: "var(--ink-2)", maxWidth: "60ch", marginTop: "0.8rem" }}>
        No protected payment opens. The dimensions it is missing are named. No value is proposed for any of them.
      </p>
      <ul className="missing-list">
        {r.missing.map((mm) => (
          <li key={mm.dimension}>
            <span className="d">missing {mm.dimension}</span>
            <span className="w">{mm.why}</span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: "1.8rem" }}>
        <span className="eyebrow">the complete vocabulary, which never grows to fit a term</span>
        <div className="vocab-set">
          <span className="brace">{"{"}</span>
          {r.opcodes.map((o) => (
            <span className="op" key={o}>
              {o}
            </span>
          ))}
          <span className="brace">{"}"}</span>
        </div>
      </div>
    </section>
  );
}
