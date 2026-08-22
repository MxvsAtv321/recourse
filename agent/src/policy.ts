/**
 * The buyer's purchasing policy.
 *
 * Completely deterministic. No model ranks, scores, recommends or selects.
 * The policy is data, the selection rule is a total function of that data and
 * the offers, and it is printed on screen exactly as it runs.
 *
 * This consumes the matching rule in evidence.ts unchanged. It adds no gate,
 * no reason code and no settlement behaviour.
 */
import { inspect, type Artifact, type Claim, type Finding, type Lane, type MatchContext } from "./evidence.js";
import type { SignedManifest } from "./manifest.js";

export type Offer = {
  id: string;
  vendor: string;
  endpoint: string;
  /** Advertised price for one call, in millionths of a dollar. */
  priceMicrosUsd: number;
  /** The vendor's own words for what it sells. Quoted, never paraphrased. */
  advertises: string;
  /** The evidence artifacts this offer actually makes available. */
  artifacts: readonly Artifact[];
  /** Present when the provider publishes a signed commercial manifest. */
  manifest?: SignedManifest;
};

export type Policy = {
  /** The buyer will not pay more than this for one call. */
  maxPriceMicrosUsd: number;
  /** The claim the buyer needs, in the buyer's own words. */
  requiredClaim: string;
  /** When true, an offer is ineligible unless the required claim is enforceable. */
  protectionMandatory: boolean;
  /** Printed verbatim on screen. This is the rule, not a description of it. */
  selectionRule: string;
};

export const SELECTION_RULE =
  "Among offers satisfying every mandatory requirement and the price bound, choose the lowest priced offer. " +
  "If none satisfy the policy, purchase nothing.";

export type PolicyCheck = { label: string; passed: boolean; detail: string };

export type OfferEvaluation = {
  offer: Offer;
  checks: PolicyCheck[];
  priceOk: boolean;
  claimEstablishable: boolean;
  protectionOk: boolean;
  eligible: boolean;
  finding: Finding;
  lanes: Lane[];
  /** Why the policy was not satisfied. Names the requirement, never the vendor. */
  refusal: string | null;
};

export type Decision = {
  policy: Policy;
  evaluations: OfferEvaluation[];
  selectedOfferId: string | null;
  /** The rule's output, stated as the rule states it. */
  result: "PURCHASE" | "PURCHASE_NOTHING";
  rationale: string;
};

const micros = (n: number) => `$${(n / 1_000_000).toFixed(3)}`;

function evaluate(policy: Policy, claim: Claim, offer: Offer, ctx: MatchContext): OfferEvaluation {
  const { lanes, finding } = inspect(claim, offer.artifacts, ctx);

  const priceOk = offer.priceMicrosUsd <= policy.maxPriceMicrosUsd;
  const claimEstablishable = finding.verdict === "ENFORCEABLE";
  const protectionOk = !policy.protectionMandatory || claimEstablishable;
  const eligible = priceOk && protectionOk;

  const checks: PolicyCheck[] = [
    {
      label: "price within bound",
      passed: priceOk,
      detail: `${micros(offer.priceMicrosUsd)} against a maximum of ${micros(policy.maxPriceMicrosUsd)}`,
    },
    {
      label: "the required claim is establishable",
      passed: claimEstablishable,
      detail: claimEstablishable
        ? `one artifact reaches ENFORCEABLE and settles by ${
            finding.verdict === "ENFORCEABLE" ? finding.settlesBy.toLowerCase() : ""
          }`
        : `no artifact offered for this endpoint reaches the fourth gate for "${policy.requiredClaim}"`,
    },
    {
      label: "protection is mandatory and satisfied",
      passed: protectionOk,
      detail: policy.protectionMandatory
        ? protectionOk
          ? "the policy requires enforceable protection and it is available"
          : "the policy requires enforceable protection for this claim"
        : "the policy does not require protection for this claim",
    },
  ];

  // The refusal is the buyer's policy not being satisfied. It names what the
  // requirement asked for and what the available evidence establishes. It says
  // nothing about the vendor.
  const refusal = eligible
    ? null
    : !priceOk
      ? `The requirement set a maximum of ${micros(policy.maxPriceMicrosUsd)} for one call. This offer is ${micros(
          offer.priceMicrosUsd,
        )}. Policy result: do not purchase.`
      : `The requirement asked for "${policy.requiredClaim}". The evidence available at this endpoint cannot establish that claim. Policy result: do not purchase.`;

  return { offer, checks, priceOk, claimEstablishable, protectionOk, eligible, finding, lanes, refusal };
}

/**
 * The selection rule, executed. Sorting is by price then by id, so the outcome
 * is total and does not depend on the order offers were listed in.
 */
export function decide(
  policy: Policy,
  claim: Claim,
  offers: readonly Offer[],
  ctx: MatchContext = {},
): Decision {
  const evaluations = offers.map((o) => evaluate(policy, claim, o, ctx));
  const eligible = evaluations
    .filter((e) => e.eligible)
    .sort((a, b) => a.offer.priceMicrosUsd - b.offer.priceMicrosUsd || a.offer.id.localeCompare(b.offer.id));

  if (eligible.length === 0) {
    return {
      policy,
      evaluations,
      selectedOfferId: null,
      result: "PURCHASE_NOTHING",
      rationale: "No offer satisfies every mandatory requirement and the price bound.",
    };
  }
  const winner = eligible[0];
  return {
    policy,
    evaluations,
    selectedOfferId: winner.offer.id,
    result: "PURCHASE",
    rationale: `${eligible.length} of ${evaluations.length} offers satisfy the policy. The lowest priced of those is ${micros(
      winner.offer.priceMicrosUsd,
    )}.`,
  };
}

export const formatMicros = micros;
