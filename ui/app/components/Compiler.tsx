"use client";

import { useEffect, useState } from "react";
import type { CompileView, Compilation, Diagnostic, WitnessView } from "../../../agent/src/compile";

/**
 * The compile surface. Two pieces of source text, one action, three
 * compilations in sequence.
 *
 * Everything is rendered on the server and visible without JavaScript. The
 * client only adds a sweep that walks the three in order when COMPILE GUARANTEE
 * is pressed. A dead client costs the sweep and nothing else.
 */
export function Compiler({ view }: { view: CompileView }) {
  const [sweep, setSweep] = useState<number | null>(null);

  useEffect(() => {
    if (sweep === null || sweep >= view.compilations.length) return;
    const t = setTimeout(() => setSweep((s) => (s === null ? null : s + 1)), 700);
    return () => clearTimeout(t);
  }, [sweep, view.compilations.length]);

  return (
    <div className="compiler">
      <div className="src-pair">
        <div className="src">
          <span className="sk">seller promise</span>
          <p className="st">&ldquo;{view.sellerPromise}&rdquo;</p>
        </div>
        <div className="src">
          <span className="sk">buyer requirement</span>
          <p className="st">&ldquo;{view.requirement}&rdquo;</p>
        </div>
      </div>

      <button className="compile-action" type="button" onClick={() => setSweep(0)}>
        Compile guarantee
      </button>

      {view.compilations.map((c, i) => (
        <Compiled key={c.id} c={c} active={sweep !== null && sweep === i} />
      ))}
    </div>
  );
}

/** The source line, with every span a diagnostic points at underlined in place. */
function Underlined({ text, spans }: { text: string; spans: [number, number][] }) {
  if (spans.length === 0) return <>{text}</>;
  const merged = [...spans].sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  merged.forEach(([a, b], i) => {
    if (a < at) return;
    if (a > at) out.push(<span key={`t${i}`}>{text.slice(at, a)}</span>);
    out.push(<u key={`u${i}`}>{text.slice(a, b)}</u>);
    at = b;
  });
  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);
  return <>{out}</>;
}

function Compiled({ c, active }: { c: Compilation; active: boolean }) {
  const spans = c.diagnostics
    .map((d) => (d.at.kind === "SPAN" ? ([d.at.span[0], d.at.span[1]] as [number, number]) : null))
    .filter((s): s is [number, number] => s !== null);

  return (
    <section className={`unit${active ? " active" : ""}`} data-compilation={c.id} data-status={c.status}>
      <div className="unit-head">
        <span className="ord">{c.ordinal}</span>
        <span className="ut">{c.title}</span>
      </div>

      <p className="usrc">
        <span className="usrc-k">{c.sourceLabel}</span>
        &ldquo;
        <Underlined text={c.sourceText} spans={spans} />
        &rdquo;
      </p>

      {c.claim ? (
        <p className="uclaim">
          compiles to <b>{c.claim.subject}</b> &middot; <b>{c.claim.property}</b> &middot; <b>{c.claim.opcode}</b>{" "}
          <b>{c.claim.thresholdAbsolute}</b>
        </p>
      ) : null}

      {c.diagnostics.map((d, i) => (
        <Diag key={`${d.code}${i}`} d={d} />
      ))}

      <div className={c.status === "COMPILED" ? "ustatus ok" : "ustatus no"}>
        {c.status === "COMPILED" ? "Guarantee compiled" : "Failed"}
      </div>

      {c.witness ? <Witness w={c.witness} /> : null}
    </section>
  );
}

function Diag({ d }: { d: Diagnostic }) {
  return (
    <div className="diag">
      <span className="dcode">{d.code}</span>
      <span className="dat">
        {d.at.kind === "SPAN"
          ? `${d.at.label}[${d.at.span[0]}..${d.at.span[1]}] "${d.at.quote}"`
          : `${d.at.label}.${d.at.field}`}
      </span>
      <p className="dline">
        found <b>{d.found}</b>, required <b>{d.required}</b>
      </p>
    </div>
  );
}

/** The spec as the artifact it is, stated before any money moves. */
function Witness({ w }: { w: WitnessView }) {
  return (
    <div className="witness" data-witness-id={w.witnessId}>
      <div className="wk">breach witness spec</div>
      <p className="wsay">
        A record whose <b>{w.reads}</b> is <b>{w.falsifierOp}</b> <b>{w.thresholdAbsolute}</b>.
      </p>
      <dl className="wgrid">
        <div>
          <dt>falsifier</dt>
          <dd>
            {w.falsifierOp} <span className="wneg">negation of {w.negates}</span>
          </dd>
        </div>
        <div>
          <dt>threshold</dt>
          <dd>
            {w.thresholdAbsolute}{" "}
            <span className="wneg">
              requirement[{w.thresholdSourced.span[0]}..{w.thresholdSourced.span[1]}] &ldquo;{w.thresholdSourced.quote}
              &rdquo;, a {w.thresholdSeconds}s window
            </span>
          </dd>
        </div>
        <div>
          <dt>required binding</dt>
          <dd>{w.requiredBinding}</dd>
        </div>
        <div>
          <dt>permitted issuer</dt>
          <dd className="waddr">{w.permittedIssuer}</dd>
        </div>
      </dl>
      <div className="wid">
        <span className="widk">witnessId</span>
        <span className="widv">{w.witnessId}</span>
      </div>
      <p className="wnote">Stated before any money moves.</p>
    </div>
  );
}

/**
 * The payoff. The proof that settled, against the spec compiled before payment,
 * and the same witnessId on both sides.
 *
 * Two of the spec's fields are read from the fixture on both sides because the
 * chain does not carry them as a string. The page says so rather than implying
 * they were recomputed.
 */
export function Payoff({ view, txHash, verdict }: { view: CompileView; txHash: string; verdict: string }) {
  const p = view.payoff;
  if (!p) return null;
  return (
    <div className="payoff" data-payoff data-witness-match={String(p.matches)}>
      <div className="pf-ids">
        <div>
          <span className="pk">witnessId, compiled before payment</span>
          <span className="pv" data-witness-before={p.witnessIdBefore}>
            {p.witnessIdBefore}
          </span>
        </div>
        <div>
          <span className="pk">witnessId, recomputed from what the escrow recorded</span>
          <span className="pv" data-witness-after={p.witnessIdAfter}>
            {p.witnessIdAfter}
          </span>
        </div>
        <div className={p.matches ? "pf-verdict ok" : "pf-verdict no"}>
          {p.matches ? "Identical" : "Different, and that is a failure"}
        </div>
      </div>

      <div className="pf-head">
        the proof at index {p.index}, field by field against that spec
      </div>
      <div className="pf-fields">
        {p.fields.map((f) => (
          <div className={f.passed ? "pff ok" : "pff no"} key={f.field}>
            <span className="m" aria-hidden>
              {f.passed ? "✓" : "✕"}
            </span>
            <span className="fn">{f.field}</span>
            <span className={f.fromChain ? "fsrc chain" : "fsrc fixture"}>
              {f.fromChain ? "from the escrow record" : "fixture on both sides"}
            </span>
            <p className="fv">
              <span>spec {f.spec}</span>
              <span>executed {f.executed}</span>
            </p>
          </div>
        ))}
      </div>
      <p className="pf-note">
        {p.fixtureReadFields.join(" and ")} name the artifact class the commitment is, which the chain does not carry
        as a string. Both sides read the fixture for those. Every other field above is recomputed from what the escrow
        recorded, and the binding itself is checked against the leaf formula the issuer signed.
      </p>
      <p className="pf-tx">
        {verdict} &middot; {txHash}
      </p>
    </div>
  );
}
