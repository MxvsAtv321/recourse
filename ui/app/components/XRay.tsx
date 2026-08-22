"use client";

import { useEffect, useRef, useState } from "react";
import {
  TIMING,
  gateOnAt,
  manifestOnAt,
  reasonOnAt,
  targetOnAt,
  type LaneView,
  type XRayView,
} from "../../../agent/src/xray";

/**
 * Five lanes attempting one claim. Nothing here knows an artifact name, a gate,
 * a verdict or a reason. Every string rendered below comes from the view the
 * engine produced.
 */
export function XRay({ view }: { view: XRayView }) {
  const laneCount = view.lanes.length;
  const last = manifestOnAt(laneCount);
  const [tick, setTick] = useState(0);
  const [run, setRun] = useState(0);

  // The dark claim field sits directly above the board and states the same
  // sentence, so the condensed copy is redundant until it is actually stuck.
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = stickyRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setStuck(e.intersectionRatio < 1), {
      threshold: [1],
      rootMargin: "-3.7rem 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setTick(last);
      return;
    }
    setTick(0);
    const id = setInterval(() => setTick((t) => (t >= last ? t : t + 1)), TIMING.tickMs);
    return () => clearInterval(id);
  }, [last, run]);

  return (
    <>
      <div className="xray">
        <div className={stuck ? "claim-sticky stuck" : "claim-sticky"} ref={stickyRef}>
          <span className="q">&ldquo;{view.claim.quote}&rdquo;</span>
          <span className="m">
            {view.claim.subject} &middot; {view.claim.property.replace(/_/g, " ")} &middot;{" "}
            <b>{view.claim.seconds}s</b>
          </span>
        </div>

        <div className="xray-board">
          <div className="xray-head">
            <div />
            {view.gates.map((g) => (
              <div className="gate-label" key={g.index}>
                gate {g.index}
                <b>{g.short}</b>
              </div>
            ))}
            <div className="target-label">the claim</div>
          </div>

          {view.lanes.map((lane, i) => (
            <Lane key={lane.id} lane={lane} index={i} tick={tick} />
          ))}
        </div>

        <div className="xray-foot">
          <span>
            {view.lanes.filter((l) => l.crosses).length} of {laneCount} reach the claim. Fixtures recorded{" "}
            {view.observedWindow}, never re-fetched.
          </span>
          <button className="replay" type="button" onClick={() => setRun((r) => r + 1)}>
            replay
          </button>
        </div>
      </div>

      {view.manifest ? <ManifestPanel view={view} on={tick >= last} /> : null}
      {view.refusal ? <RefusalPanel view={view} on={tick >= last} /> : null}
    </>
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

function ManifestPanel({ view, on }: { view: XRayView; on: boolean }) {
  const m = view.manifest!;
  const spans = m.literals.map((l) => l.span).filter((s): s is [number, number] => s !== null);
  return (
    <section className={on ? "manifest-wrap on" : "manifest-wrap"} style={{ marginTop: "3.5rem" }}>
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

function RefusalPanel({ view, on }: { view: XRayView; on: boolean }) {
  const r = view.refusal!;
  return (
    <section className={on ? "manifest-wrap on refusal" : "manifest-wrap refusal"}>
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

function Lane({ lane, index, tick }: { lane: LaneView; index: number; tick: number }) {
  const gates = [1, 2, 3, 4];
  const reasonOn = !lane.crosses && tick >= reasonOnAt(index, lane.stopsAt);
  const targetOn = lane.crosses && tick >= targetOnAt(index);

  return (
    <div className="lane">
      <div className="lane-name">
        <span className={lane.nameIsMono ? "n mono" : "n"}>{lane.name}</span>
        <span className="s">{lane.source}</span>
      </div>

      {gates.map((g) => {
        // A lane that crosses travels every segment. A lane that stops travels
        // the segments before its gate, then a stub and a terminal bar in it.
        const travelled = lane.crosses || g < lane.stopsAt;
        const terminal = !lane.crosses && g === lane.stopsAt;
        const on = tick >= gateOnAt(index, g);
        // Every cell in the row is placed explicitly. The reason block occupies
        // row 1 too, and auto-placement would otherwise route these around it.
        const place = { gridColumn: g + 1, gridRow: 1 } as React.CSSProperties;
        if (!travelled && !terminal) return <div className="seg dead" key={g} style={place} />;
        return (
          <div className={`seg${on ? " on" : ""}${terminal ? " term" : ""}`} key={g} style={place}>
            <div className={terminal ? "path stub" : "path full"} />
            {travelled ? <div className="node" /> : null}
            {terminal ? <div className="stop" /> : null}
          </div>
        );
      })}

      <div className={targetOn ? "lane-target on" : "lane-target"}>
        {lane.crosses ? (
          <>
            <span className="v">{lane.verdict}</span>
            <span className="b">{lane.settlesBy}</span>
          </>
        ) : null}
      </div>

      {!lane.crosses ? (
        <div
          className={reasonOn ? "reason on" : "reason"}
          style={
            {
              "--from": String(lane.stopsAt + 1),
              "--span": String(5 - lane.stopsAt),
            } as React.CSSProperties
          }
        >
          <div className="code">
            <span>{lane.code?.replace(/_/g, " ")}</span>
            <span className="how">{lane.discovery === "MEASURED" ? "found by measuring" : "found by reading"}</span>
          </div>
          <div className="h">{lane.headline}</div>
          {lane.showsCommits ? (
            <div className="commits">
              <em>commits to</em>
              {lane.commitsTo.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
