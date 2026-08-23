"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompileView } from "../../../agent/src/compile";
import type { DecisionView, RefusalView } from "../../../agent/src/xray";
import type { DemoTrace } from "../../../agent/src/trace";
import { money } from "../../lib/format";

/**
 * Presentation mode. Fourteen full screen states, right arrow forward, left back.
 *
 * Four states advance themselves once entered, because in each of them the
 * arrival of the parts IS the argument rather than decoration:
 *
 *   3   the span underlines, then the typed error lands on it
 *   4   the four evidence errors arrive one at a time, so a room can see that
 *       four different artifacts fail four different ways against one claim
 *   8   the offer that passes resolves first, then the refusal, so the refusal
 *       reads as the policy not being satisfied rather than as a verdict
 *   10  the scan counts to the first violating record
 *
 * Everything else waits for a key, because everything else is a single fact.
 *
 * Right arrow during a self-advancing sequence completes it immediately instead
 * of skipping it, so a slow animation can never strand the presenter.
 */

const AUTO: Record<number, number> = { 3: 1, 4: 4, 8: 2, 10: 1 };
const DELAY: Record<number, number> = { 3: 600, 4: 700, 8: 900, 10: 60 };
const TOTAL = 14;
const TRACE_MS = 480;

type RunPhase = "probing" | "idle" | "running" | "live" | "captured";

export function Present({
  compile,
  decision,
  refusal,
  scan,
  settlement,
  amount,
  decimals,
  symbol,
  initialState = 1,
  initialSub = 0,
}: {
  compile: CompileView;
  decision: DecisionView;
  refusal: RefusalView | null;
  scan: { totalRecords: number; violations: number; firstViolationIndex: number; observedAt: string; thresholdAt: string; shortBySeconds: string };
  settlement: { verdict: string; refundAmount: string; txHash: string; blockNumber: string; offendingIndex: string; escrowBalanceAfter: string };
  amount: string;
  decimals: number;
  symbol: string;
  initialState?: number;
  initialSub?: number;
}) {
  const [i, setI] = useState(initialState);
  const [sub, setSub] = useState(initialSub);
  const [scanN, setScanN] = useState(initialState === 10 && initialSub > 0 ? scan.firstViolationIndex : 0);

  // the real execution path, the same endpoints the scrolling page uses
  const [phase, setPhase] = useState<RunPhase>("probing");
  const [reasons, setReasons] = useState<string[]>([]);
  const [trace, setTrace] = useState<DemoTrace | null>(null);
  const [visible, setVisible] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/demo/breach", { method: "GET", cache: "no-store" });
        const probe = (await res.json()) as { available?: boolean; reasons?: string[] };
        if (cancelled) return;
        if (probe.available) setPhase("idle");
        else {
          setReasons(probe.reasons ?? []);
          setPhase("captured");
        }
      } catch {
        if (!cancelled) {
          setReasons(["live execution unavailable"]);
          setPhase("captured");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    if (started.current) return;
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
      setReasons([e instanceof Error ? e.message : "live execution unavailable"]);
      setPhase("captured");
    }
  }, []);

  // trace events arrive as they arrive
  useEffect(() => {
    if (phase !== "live" || !trace || visible >= trace.events.length) return;
    const t = setTimeout(() => setVisible((v) => v + 1), TRACE_MS);
    return () => clearTimeout(t);
  }, [phase, trace, visible]);

  // the self-advancing states
  useEffect(() => {
    const max = AUTO[i] ?? 0;
    if (sub >= max) return;
    if (i === 10) {
      const target = scan.firstViolationIndex;
      if (scanN >= target) {
        setSub(1);
        return;
      }
      const t = setTimeout(() => setScanN((n) => Math.min(target, n + Math.max(1, Math.ceil(target / 40)))), DELAY[10]);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setSub((s) => s + 1), DELAY[i] ?? 700);
    return () => clearTimeout(t);
  }, [i, sub, scanN, scan.firstViolationIndex]);

  const complete = useCallback(() => {
    setSub(AUTO[i] ?? 0);
    if (i === 10) setScanN(scan.firstViolationIndex);
  }, [i, scan.firstViolationIndex]);

  const forward = useCallback(() => {
    const max = AUTO[i] ?? 0;
    if (sub < max) {
      complete();
      return;
    }
    if (i === 9) {
      if (phase === "idle") {
        void run();
        return;
      }
      if (phase === "running") return;
      if (phase === "live" && trace && visible < trace.events.length) {
        setVisible(trace.events.length);
        return;
      }
    }
    setI((n) => {
      const next = Math.min(TOTAL, n + 1);
      if (next !== n) {
        setSub(0);
        if (next === 10) setScanN(0);
      }
      return next;
    });
  }, [i, sub, phase, trace, visible, complete, run]);

  const back = useCallback(() => {
    setI((n) => {
      const prev = Math.max(1, n - 1);
      if (prev !== n) {
        setSub(AUTO[prev] ?? 0);
        if (prev === 10) setScanN(scan.firstViolationIndex);
      }
      return prev;
    });
  }, [scan.firstViolationIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        forward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forward, back]);

  const [one, two, three] = compile.compilations;
  const witness = three.witness;
  const payoff = compile.payoff;
  const events = trace ? trace.events.slice(0, visible) : [];

  return (
    <main className="present" data-state={i} data-sub={sub} onClick={forward}>
      <div className="p-rail">
        <span className="p-n">{String(i).padStart(2, "0")}</span>
        <span className="p-of">/ {TOTAL}</span>
      </div>

      {i === 1 ? (
        <State k="the buyer's requirement">
          <p className="p-huge">&ldquo;{compile.requirement}&rdquo;</p>
        </State>
      ) : null}

      {i === 2 ? (
        <State k="two pieces of text">
          <div className="p-two">
            <div>
              <span className="p-k">seller promise</span>
              <p className="p-mid">&ldquo;{compile.sellerPromise}&rdquo;</p>
            </div>
            <div>
              <span className="p-k">buyer requirement</span>
              <p className="p-mid">&ldquo;{compile.requirement}&rdquo;</p>
            </div>
          </div>
        </State>
      ) : null}

      {i === 3 ? (
        <State k={`compile 1 of 3 · ${one.title}`}>
          {/* the span underlines on entry, the typed error lands on it a beat later */}
          <Source text={one.sourceText} spans={spansOf(one)} />
          {sub >= 1 ? <Diags list={one.diagnostics} n={one.diagnostics.length} /> : <div className="p-pending" />}
          {sub >= 1 ? <div className="p-status no">Failed</div> : null}
        </State>
      ) : null}

      {i === 4 ? (
        <State k={`compile 2 of 3 · ${two.title}`}>
          <Source text={two.sourceText} spans={spansOf(two, sub)} />
          {two.claim ? (
            <p className="p-claim">
              compiles to <b>{two.claim.subject}</b> · <b>{two.claim.property}</b> · <b>{two.claim.opcode}</b>{" "}
              <b>{two.claim.thresholdAbsolute}</b>
            </p>
          ) : null}
          <Diags list={two.diagnostics} n={sub} />
          {sub >= 4 ? <div className="p-status no">Failed</div> : null}
        </State>
      ) : null}

      {i === 5 ? (
        <State k={`compile 3 of 3 · ${three.title}`}>
          <Source text={three.sourceText} spans={[]} />
          {three.claim ? (
            <p className="p-claim">
              compiles to <b>{three.claim.subject}</b> · <b>{three.claim.property}</b> · <b>{three.claim.opcode}</b>{" "}
              <b>{three.claim.thresholdAbsolute}</b>
            </p>
          ) : null}
          <div className="p-status ok">Guarantee compiled</div>
        </State>
      ) : null}

      {i === 6 && witness ? (
        <State k="breach witness spec · stated before any money moves">
          <p className="p-mid">
            A record whose <b>{witness.reads}</b> is <b>{witness.falsifierOp}</b> <b>{witness.thresholdAbsolute}</b>.
          </p>
          <dl className="p-grid">
            <div>
              <dt>falsifier</dt>
              <dd>
                {witness.falsifierOp} <span className="p-sub">negation of {witness.negates}</span>
              </dd>
            </div>
            <div>
              <dt>threshold</dt>
              <dd>
                {witness.thresholdAbsolute}{" "}
                <span className="p-sub">
                  requirement[{witness.thresholdSourced.span[0]}..{witness.thresholdSourced.span[1]}] &ldquo;
                  {witness.thresholdSourced.quote}&rdquo;
                </span>
              </dd>
            </div>
            <div>
              <dt>binding</dt>
              <dd>{witness.requiredBinding}</dd>
            </div>
            <div>
              <dt>permitted issuer</dt>
              <dd className="p-addr">{witness.permittedIssuer}</dd>
            </div>
          </dl>
          <div className="p-wid" data-witness-6={witness.witnessId}>
            <span className="p-k">witnessId</span>
            <span className="p-hex">{witness.witnessId}</span>
          </div>
        </State>
      ) : null}

      {i === 7 ? (
        <State k="the buyer's purchasing policy">
          <dl className="p-grid three">
            <div>
              <dt>maxPrice</dt>
              <dd>{decision.policy.maxPrice}</dd>
            </div>
            <div>
              <dt>requiredClaim</dt>
              <dd className="p-small">&ldquo;{decision.policy.requiredClaim}&rdquo;</dd>
            </div>
            <div>
              <dt>protectionMandatory</dt>
              <dd>{String(decision.policy.protectionMandatory)}</dd>
            </div>
          </dl>
          <p className="p-rule">{decision.policy.selectionRule}</p>
        </State>
      ) : null}

      {i === 8 ? (
        <State k="two offers, one policy">
          <div className="p-two">
            {[...decision.offers]
              .sort((a, b) => Number(b.selected) - Number(a.selected))
              .map((o, k) => (
                <div className={`p-offer${o.selected ? " sel" : ""}${sub > k ? " on" : ""}`} key={o.id}>
                  <span className="p-k">{o.vendor}</span>
                  <p className="p-price">{o.price}</p>
                  {sub > k ? (
                    <>
                      <ul className="p-checks">
                        {o.checks.map((c) => (
                          <li key={c.label} className={c.passed ? "ok" : "no"}>
                            <span aria-hidden>{c.passed ? "✓" : "✕"}</span> {c.label}
                          </li>
                        ))}
                      </ul>
                      <p className={o.eligible ? "p-res ok" : "p-res no"}>{o.eligible ? "Selected by the policy" : o.refusal}</p>
                    </>
                  ) : null}
                </div>
              ))}
          </div>
        </State>
      ) : null}

      {i === 9 ? (
        <State k="the purchase">
          <p className="p-mid">
            {money(amount, decimals)} {symbol} into escrow, released only if nobody proves the delivery broke its promise.
          </p>
          {phase === "idle" ? <div className="p-cta">Press → to run it on chain</div> : null}
          {phase === "running" ? <div className="p-cta live">Executing…</div> : null}
          {phase === "captured" ? (
            <div className="p-cap">
              <span className="p-k">captured verified run</span>
              <p className="p-small">{reasons.join("; ") || "no local chain is reachable"}</p>
            </div>
          ) : null}
          {phase === "live" ? (
            <ol className="p-trace" data-trace-source="live">
              {events.map((e) => (
                <li key={e.seq} data-kind={e.kind}>
                  <span className="s">{e.seq}</span>
                  <span className="l">{e.label}</span>
                  <span className="d">{e.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </State>
      ) : null}

      {i === 10 ? (
        <State k="the buyer's verifier scans the delivery, locally">
          <p className="p-count">
            {scanN}
            <span className="p-of-n"> / {scan.totalRecords}</span>
          </p>
          <p className="p-mid">
            {sub >= 1 ? (
              <>
                first violating record at index <b>{scan.firstViolationIndex}</b>, {scan.violations} of {scan.totalRecords} in
                breach
              </>
            ) : (
              <>reading generation times</>
            )}
          </p>
          {sub >= 1 ? (
            <p className="p-small">
              short of the threshold by {scan.shortBySeconds} seconds. The first {scan.firstViolationIndex} records are
              current, so the head of the file looks clean.
            </p>
          ) : null}
        </State>
      ) : null}

      {i === 11 && payoff ? (
        <State k={`the proof at index ${payoff.index}, against the spec compiled before payment`}>
          <ul className="p-fields">
            {payoff.fields.map((f) => (
              <li key={f.field} className={f.passed ? "ok" : "no"}>
                <span aria-hidden>{f.passed ? "✓" : "✕"}</span>
                <span className="fn">{f.field}</span>
                <span className={f.fromChain ? "src chain" : "src fixture"}>{f.fromChain ? "escrow record" : "fixture both sides"}</span>
              </li>
            ))}
          </ul>
          <div className="p-wid" data-witness-11={payoff.witnessIdAfter}>
            <span className="p-k">witnessId, recomputed</span>
            <span className="p-hex">{payoff.witnessIdAfter}</span>
          </div>
        </State>
      ) : null}

      {i === 12 ? (
        <State k="settlement" dark>
          <p className="p-k">verdict · {settlement.verdict.replace(/_/g, " ")}</p>
          <p className="p-huge">
            {money(settlement.refundAmount, decimals)} <span className="p-cur">{symbol}</span>
          </p>
          <p className="p-mid">
            Refunded in full. One record broke an objective promise, so the payment never became final.
          </p>
          <p className="p-hex">{trace ? String(events.find((e) => e.kind === "REFUND_MINED")?.facts.txHash ?? settlement.txHash) : settlement.txHash}</p>
        </State>
      ) : null}

      {i === 13 && refusal ? (
        <State k="the limit">
          <p className="p-mid">&ldquo;{refusal.requirement}&rdquo;</p>
          <ul className="p-missing">
            {refusal.missing.map((m) => (
              <li key={m.dimension}>
                <b>missing {m.dimension}</b> {m.why}
              </li>
            ))}
          </ul>
          <div className="p-ops">
            <span className="brace">{"{"}</span>
            {refusal.opcodes.map((o) => (
              <span className="op" key={o}>
                {o}
              </span>
            ))}
            <span className="brace">{"}"}</span>
          </div>
          <p className="p-small">The complete vocabulary. It never grows to fit a term.</p>
        </State>
      ) : null}

      {i === 14 ? (
        <State k="" dark>
          <div className="p-layers">
            <div>
              <span className="lk">price</span>
              <span className="lv">machine-readable</span>
            </div>
            <div>
              <span className="lk">payment</span>
              <span className="lv">machine-verifiable</span>
            </div>
            <div className="now">
              <span className="lk">the promise</span>
              <span className="lv">
                <em>not yet</em>
              </span>
            </div>
          </div>
          <p className="p-closer">
            One bad record. One proof. <em>No arbiter.</em>
          </p>
        </State>
      ) : null}
    </main>
  );
}

function State({ k, dark, children }: { k: string; dark?: boolean; children: React.ReactNode }) {
  return (
    <section className={dark ? "pstate dark" : "pstate"}>
      {k ? <span className="p-eyebrow">{k}</span> : null}
      {children}
    </section>
  );
}

/** Spans a diagnostic points at. In state 4 they arrive with their diagnostic. */
function spansOf(c: CompileView["compilations"][number], upto?: number): [number, number][] {
  const list = upto === undefined ? c.diagnostics : c.diagnostics.slice(0, upto);
  return list
    .map((d) => (d.at.kind === "SPAN" ? ([d.at.span[0], d.at.span[1]] as [number, number]) : null))
    .filter((s): s is [number, number] => s !== null);
}

function Source({ text, spans }: { text: string; spans: [number, number][] }) {
  if (spans.length === 0) return <p className="p-src">&ldquo;{text}&rdquo;</p>;
  const merged = [...spans].sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  merged.forEach(([a, b], n) => {
    if (a < at) return;
    if (a > at) out.push(<span key={`t${n}`}>{text.slice(at, a)}</span>);
    out.push(<u key={`u${n}`}>{text.slice(a, b)}</u>);
    at = b;
  });
  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);
  return <p className="p-src">&ldquo;{out}&rdquo;</p>;
}

function Diags({ list, n }: { list: CompileView["compilations"][number]["diagnostics"]; n: number }) {
  return (
    <div className="p-diags">
      {list.slice(0, n).map((d, k) => (
        <div className="p-diag" key={`${d.code}${k}`}>
          <span className="dc">{d.code}</span>
          <span className="da">
            {d.at.kind === "SPAN" ? `${d.at.label}[${d.at.span[0]}..${d.at.span[1]}] "${d.at.quote}"` : `${d.at.label}.${d.at.field}`}
          </span>
          <p className="dl">
            found <b>{d.found}</b>, required <b>{d.required}</b>
          </p>
        </div>
      ))}
    </div>
  );
}
