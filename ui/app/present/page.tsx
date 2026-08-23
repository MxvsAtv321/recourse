import { Present } from "../components/Present";
import { loadRun } from "../../lib/run";
import { buildXRay } from "../../../agent/src/xray";
import { buildCompile } from "../../../agent/src/compile";

export const dynamic = "force-dynamic";

/**
 * Presentation mode.
 *
 * The same content, from the same engine, as full screen states advanced by the
 * arrow keys. This route adds no data of its own: it assembles exactly what /
 * assembles and hands it to a client component that renders one idea at a time.
 */
/**
 * ?s=N jumps to a state and ?sub=M to a step inside it, so every state is
 * addressable. That makes the states testable from outside the browser, and it
 * means a presenter who needs state 9 does not have to press right nine times.
 */
export default async function PresentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const num = (v: string | string[] | undefined, lo: number, hi: number, dflt: number) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : dflt;
  };
  const initialState = num(q.s, 1, 14, 1);
  const initialSub = num(q.sub, 0, 9, 0);

  const xray = buildXRay();
  const run = loadRun();
  const c = run?.protectedPurchase.conditions[0];

  const compile = buildCompile(
    c
      ? {
          conditionId: c.conditionId,
          sourceQuote: c.sourceQuote,
          claimType: c.claimType,
          quantifier: c.quantifier,
          opcode: c.opcode,
          threshold: c.threshold,
          permittedIssuer: c.permittedIssuer,
          expectedSourceId: c.expectedSourceId,
        }
      : null,
    run
      ? {
          index: run.protectedPurchase.proof.index,
          offendingIndex: run.protectedPurchase.settlement.offendingIndex,
          observed: run.protectedPurchase.scan.observedAt,
          thresholdAt: run.protectedPurchase.scan.thresholdAt,
          conditionId: run.protectedPurchase.conditions[0].conditionId,
          claimType: run.protectedPurchase.conditions[0].claimType,
          quantifier: run.protectedPurchase.conditions[0].quantifier,
          sourceId: run.protectedPurchase.commitment.sourceId,
          issuer: run.protectedPurchase.commitment.issuer,
          leafFormula: run.protectedPurchase.commitment.leafFormula,
        }
      : null,
  );

  if (!run) {
    return (
      <main className="present">
        <div className="pstate">
          <p className="p-lede">No captured run. Start anvil, then npm run capture.</p>
        </div>
      </main>
    );
  }

  return (
    <Present
      compile={compile}
      decision={xray.decision}
      refusal={xray.refusal}
      scan={run.protectedPurchase.scan}
      settlement={run.protectedPurchase.settlement}
      amount={run.protectedPurchase.amount}
      decimals={run.meta.assetDecimals}
      symbol={run.meta.assetSymbol}
      initialState={initialState}
      initialSub={initialSub}
    />
  );
}
