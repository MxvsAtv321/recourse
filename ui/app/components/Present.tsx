"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompileView, Diagnostic } from "../../../agent/src/compile";
import type { DecisionView, RefusalView } from "../../../agent/src/xray";
import type { DemoTrace } from "../../../agent/src/trace";
import type { Field } from "../../../agent/src/field";
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

/**
 * The schedule, in one place. These numbers drive the React clock below AND are
 * written onto the slides as CSS custom properties, so the stylesheet animates
 * on exactly the values the walkthrough reads back out of the markup. There is
 * no second copy of the timing to drift.
 */
const GATE_MS = 500; // one gate of travel
const STAGGER_MS = 260; // between one artifact setting off and the next
const SWEEP_MS = 1500; // the whole field, index 0 to the first violation
const SWEEP_TICKS = 30;
const CARRY_MS = 700; // the spec hash crossing the screen to meet its recomputation
const TRACE_MS = 480;

/** Where each gate sits, as a percent of the run from an artifact to the claim. */
const GATE_X = [18, 38, 58, 78] as const;
const GATE_LABEL = ["subject", "property", "attestation", "binding"] as const;

const AUTO: Record<number, number> = { 3: 1, 4: 4, 8: 2, 10: 2, 11: 2 };
const DELAY: Record<number, number> = { 3: 600, 4: 700, 8: 900 };
const TOTAL = 14;

type RunPhase = "probing" | "idle" | "running" | "live" | "captured";

export function Present({
  compile,
  decision,
  refusal,
  scan,
  field,
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
  field: Field;
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

  // Slide 11: the spec's hash is carried on screen from slide 6 and has to end
  // up beside its own recomputation. The chip never leaves fixed position; it is
  // translated onto the slot, so nothing reflows and nothing is reparented.
  const carryRef = useRef<HTMLSpanElement>(null);
  const slotRef = useRef<HTMLSpanElement>(null);
  const [carryT, setCarryT] = useState<string | null>(null);
  const [landed, setLanded] = useState(initialState === 11 && initialSub > 0);

  // Final states, immediately, for anyone who asked not to be moved at.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(m.matches);
    read();
    m.addEventListener("change", read);
    return () => m.removeEventListener("change", read);
  }, []);

  /**
   * When each of slide 4's paths comes to a stop. Lane k sets off one stagger
   * after the one above it and travels one gate at a time, so this is read off
   * the engine's own gate occupancy rather than written down beside it.
   */
  const landings = useMemo(
    () => (compile.compilations[1]?.diagnostics ?? []).map((d, k) => STAGGER_MS * k + GATE_MS * Math.max(1, d.gate)),
    [compile.compilations],
  );

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

  /** How long the step from `sub` to `sub + 1` takes on a given state. */
  const stepDelay = useCallback(
    (state: number, s: number) => {
      if (state === 4) return s === 0 ? (landings[0] ?? GATE_MS) : (landings[s] ?? 0) - (landings[s - 1] ?? 0);
      if (state === 10) return 700; // the tail resolving, once the sweep has stopped
      if (state === 11) return s === 0 ? CARRY_MS + 120 : 620;
      return DELAY[state] ?? 700;
    },
    [landings],
  );

  // the self-advancing states
  useEffect(() => {
    const max = AUTO[i] ?? 0;
    if (sub >= max) return;
    if (reduced) {
      setSub(max);
      if (i === 10) setScanN(scan.firstViolationIndex);
      return;
    }
    // Slide 10's first step is the sweep itself, which advances by index rather
    // than by time, and stops on the record that breaks the promise.
    if (i === 10 && sub === 0) {
      const target = scan.firstViolationIndex;
      if (scanN >= target) {
        setSub(1);
        return;
      }
      const step = Math.max(1, Math.ceil(target / SWEEP_TICKS));
      const t = setTimeout(() => setScanN((n) => Math.min(target, n + step)), Math.round(SWEEP_MS / SWEEP_TICKS));
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setSub((s) => s + 1), stepDelay(i, sub));
    return () => clearTimeout(t);
  }, [i, sub, scanN, scan.firstViolationIndex, stepDelay, reduced]);

  // Slide 11, the crossing. One measurement, one transform, no layout written.
  useLayoutEffect(() => {
    if (i !== 11) {
      setCarryT(null);
      setLanded(false);
      return;
    }
    const c = carryRef.current;
    const slot = slotRef.current;
    if (!c || !slot) {
      setLanded(true);
      return;
    }
    const a = c.getBoundingClientRect();
    const b = slot.getBoundingClientRect();
    setCarryT(`translate(${Math.round(b.left - a.left)}px, ${Math.round(b.top - a.top)}px)`);
    if (reduced) {
      setLanded(true);
      return;
    }
    const t = setTimeout(() => setLanded(true), CARRY_MS);
    return () => clearTimeout(t);
  }, [i, reduced]);

  const complete = useCallback(() => {
    setSub(AUTO[i] ?? 0);
    if (i === 10) setScanN(scan.firstViolationIndex);
    if (i === 11) setLanded(true);
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
      {/* The spec's hash, carried from slide 6 so that on slide 11 it can be
          beside its own recomputation rather than remembered. Fixed position and
          translated onto the slot, so it never reflows anything it passes. */}
      {i >= 7 && i <= 11 && payoff ? (
        <span
          ref={carryRef}
          className={`p-carry${i === 11 ? " meeting" : ""}${landed ? " met" : ""}`}
          style={carryT ? { transform: carryT, transitionDuration: reduced ? "0ms" : undefined } : undefined}
          data-carry={payoff.witnessIdBefore}
        >
          <span className="p-k">spec</span>
          <span className="p-hex">{payoff.witnessIdBefore}</span>
        </span>
      ) : null}
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
          <Gates lanes={two.diagnostics} shown={sub} />
          {sub >= two.diagnostics.length ? <div className="p-status no">Failed</div> : null}
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
                <div
                  className={`p-offer${o.selected ? " sel" : ""}${sub > k ? " on" : ""}${o.eligible ? " pass" : " fail"}`}
                  key={o.id}
                  data-price={o.price}
                  data-eligible={String(o.eligible)}
                >
                  <span className="p-k">{o.vendor}</span>
                  {/* The price is the slide. Both are at full strength from the
                      first frame, on one baseline, so the room has compared them
                      before a single check resolves. */}
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
          <FieldGrid field={field} head={scanN} tail={sub >= 2} />
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
          {/* The rows recede while the two hashes meet, then come back. */}
          <ul className={sub >= 2 ? "p-fields" : "p-fields recede"}>
            {payoff.fields.map((f) => (
              <li key={f.field} className={f.passed ? "ok" : "no"}>
                <span aria-hidden>{f.passed ? "✓" : "✕"}</span>
                <span className="fn">{f.field}</span>
                <span className={f.fromChain ? "src chain" : "src fixture"}>{f.fromChain ? "escrow record" : "fixture both sides"}</span>
              </li>
            ))}
          </ul>
          <div className={landed ? "p-meet met" : "p-meet"}>
            <div className="row">
              <span className="p-k">the spec, stated before payment</span>
              {/* The carried chip lands exactly here. Same string, same metrics,
                  hidden rather than absent so the slot cannot be the wrong size. */}
              <span className="p-carryghost" ref={slotRef} aria-hidden>
                <span className="p-k">spec</span>
                <span className="p-hex">{payoff.witnessIdBefore}</span>
              </span>
            </div>
            <span className="eq" aria-hidden>
              =
            </span>
            <div className="row">
              <span className="p-k">recomputed from what the chain recorded</span>
              <span className="p-hex" data-witness-11={payoff.witnessIdAfter}>
                {payoff.witnessIdAfter}
              </span>
            </div>
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

/**
 * Slide 4. Four artifacts reaching for one claim, each running left to right
 * through the four gates and stopping at the one that defeated it.
 *
 * The distance IS the finding. Two paths stop at gate one and they stop there
 * for different reasons: one artifact is refuted by reading its schema, the
 * other only by measuring it. Per spec/EVIDENCE.md 5.1 that occupancy is
 * load-bearing, so the two are drawn as two lanes and never merged.
 *
 * Each typed error renders at its break point, occupying the run the path did
 * not travel, so the artifact that got furthest has the least room to explain
 * itself. Timing rides on custom properties set here, which is the same
 * schedule the React clock upstairs is counting.
 */
function Gates({ lanes, shown }: { lanes: Diagnostic[]; shown: number }) {
  return (
    <div
      className={shown >= lanes.length ? "p-gates done" : "p-gates"}
      style={{ "--gate-ms": `${GATE_MS}ms`, "--stagger-ms": `${STAGGER_MS}ms` } as React.CSSProperties}
      data-gate-ms={GATE_MS}
      data-stagger-ms={STAGGER_MS}
    >
      <div className="p-gatehead" aria-hidden>
        {GATE_LABEL.map((g, k) => (
          <span className="gh" key={g} style={{ left: `${GATE_X[k]}%` }}>
            <i>{k + 1}</i> {g}
          </span>
        ))}
        <span className="gh claim">the claim</span>
      </div>

      {lanes.map((d, k) => {
        const gate = Math.min(GATE_X.length, Math.max(1, d.gate));
        const x = GATE_X[gate - 1];
        return (
          <div
            className={k < shown ? "p-lane stopped" : "p-lane"}
            key={`${d.artifact}${k}`}
            data-gate={d.gate}
            data-artifact={d.artifact}
            style={{ "--lane": k, "--gates": gate, "--stop": 100 - x } as React.CSSProperties}
          >
            <span className="who">{d.artifact}</span>
            <svg className="track" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden focusable="false">
              <line x1="0" y1="3" x2="1000" y2="3" className="bed" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1="3" x2="1000" y2="3" className="run" vectorEffect="non-scaling-stroke" pathLength={100} />
            </svg>
            <span className="halt" style={{ left: `${x}%` }} aria-hidden />
            {k < shown ? (
              <div className="p-diag" style={{ left: `calc(${x}% + 1.4vmin)` }}>
                <span className="dc">{d.code}</span>
                <span className="da">
                  {d.at.kind === "SPAN" ? `${d.at.label}[${d.at.span[0]}..${d.at.span[1]}] "${d.at.quote}"` : `${d.at.label}.${d.at.field}`}
                </span>
                <p className="dl">
                  found <b>{d.found}</b>, required <b>{d.required}</b>
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Slide 10. The delivery itself, one cell per record.
 *
 * The sweep runs in index order and halts on the record that breaks the
 * promise. What the shape says without a word: the head of the file is solid
 * green, and the breach that follows is scattered rather than blocked, in runs
 * of four with a compliant record between them. A sampler reading the first
 * page finds nothing, and that is not bad luck, it is what a partially
 * refreshed feed actually looks like.
 *
 * `field.cells` comes from the same age function the seller mock hands to
 * buildDelivery, and `field.agrees` says whether it still counts the same as
 * the captured run. Nothing here is drawn for effect.
 */
function FieldGrid({ field, head, tail }: { field: Field; head: number; tail: boolean }) {
  return (
    <div
      className={tail ? "p-field tail" : "p-field"}
      style={{ "--sweep-ms": `${SWEEP_MS}ms` } as React.CSSProperties}
      data-cells={field.total}
      data-violations={field.violations}
      data-first={field.firstViolationIndex}
      data-longest-run={field.longestRun}
      data-agrees={String(field.agrees)}
    >
      {field.cells.map((bad, k) => (
        <i key={k} className={`c${k <= head ? (bad ? " on bad" : " on") : bad ? " bad" : ""}`} />
      ))}
    </div>
  );
}
