/**
 * The two offers the buyer's policy evaluates, and the policy itself.
 *
 * The first is the real AIsa endpoint. Its price and its advertised text are
 * recorded observations, quoted rather than paraphrased. Its available evidence
 * is exactly the four artifacts measured on 2026-08-22, which is why it is the
 * subject of the x-ray above.
 *
 * The second publishes a signed commercial Protection Manifest and makes a bound
 * delivery commitment available, which is the artifact that reaches the fourth
 * gate.
 */
import type { Offer, Policy } from "../policy.js";
import { SELECTION_RULE } from "../policy.js";
import { PROVIDER_MANIFEST } from "./manifest.signed.js";
import { IS_STALE, LAST_TRADED_AT, LAST_UPDATED, RECOURSE_COMMITMENT, X402_RECEIPT } from "./evidence.js";

/** Measured: x-aisa-customer-cost-micros-usd 8000, and $0.008000 in the x402 catalogue. */
export const AISA_PRICE_MICROS = 8_000;

/** The provider's own figure, carried inside the manifest it signed. */
export const PROTECTED_PRICE_MICROS = Number(PROVIDER_MANIFEST.manifest.priceMicrosUsd);

export const AISA_OFFER: Offer = {
  id: "aisa-coingecko-markets",
  vendor: "AIsa",
  endpoint: "/apis/v1/coingecko/coins/markets",
  priceMicrosUsd: AISA_PRICE_MICROS,
  advertises:
    "Real-time and historical cryptocurrency market data via CoinGecko: prices, market-cap rankings, charts, OHLC candles, token lookup, exchanges, categories, trending searches, and news.",
  artifacts: [X402_RECEIPT, LAST_UPDATED, IS_STALE, LAST_TRADED_AT],
};

export const PROTECTED_OFFER: Offer = {
  id: PROVIDER_MANIFEST.manifest.offerId,
  vendor: PROVIDER_MANIFEST.manifest.vendor,
  endpoint: PROVIDER_MANIFEST.manifest.endpoint,
  priceMicrosUsd: PROTECTED_PRICE_MICROS,
  advertises:
    "The same feed, delivered under a signed Protection Manifest naming the upstream issuer whose per-record commitments the escrow will accept.",
  artifacts: [RECOURSE_COMMITMENT],
  manifest: PROVIDER_MANIFEST,
};

export const OFFERS: readonly Offer[] = [AISA_OFFER, PROTECTED_OFFER];

/** The buyer's policy. Data, not judgement. Printed on screen exactly as it runs. */
export const BUYER_POLICY: Policy = {
  maxPriceMicrosUsd: 12_000,
  requiredClaim: "every record generated within the last 60 seconds",
  protectionMandatory: true,
  selectionRule: SELECTION_RULE,
};
