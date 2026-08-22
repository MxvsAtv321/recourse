import { XRay } from "../components/XRay";
import { buildXRay } from "../../../agent/src/xray";

export const dynamic = "force-dynamic";

/**
 * INSPECT and PROTECT. The whole page is a readout of what the engine returned
 * for one claim against the frozen fixtures. Change a fixture, change the page.
 */
export default function InspectPage() {
  const view = buildXRay();

  return (
    <main className="xray-page">
      <section className="claim-field">
        <div className="shell">
          <span className="eyebrow" data-step="INSPECT">
            One claim, five artifacts
          </span>
          <h1 className="claim-quote">&ldquo;{view.claim.quote}&rdquo;</h1>
          <div className="claim-meta">
            <span>
              subject <b>{view.claim.subject}</b>
            </span>
            <span>
              property <b>{view.claim.property}</b>
            </span>
            <span>
              threshold <b>{view.claim.seconds}s</b>
            </span>
            <span>
              clock <b>{view.claim.frame.replace(/_/g, " ")}</b>
            </span>
          </div>
        </div>
      </section>

      <section className="shell section" style={{ borderTop: 0, paddingTop: "0.75rem" }}>
        <XRay view={view} />
      </section>
    </main>
  );
}
