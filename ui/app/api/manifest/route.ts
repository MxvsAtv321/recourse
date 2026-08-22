import { PROVIDER_MANIFEST } from "../../../../agent/src/fixtures/manifest.signed";

/**
 * The provider serves its signed commercial Protection Manifest.
 *
 * The buyer fetches this, recovers the signer from the EIP-712 signature and
 * checks it is the seller and not the permitted issuer named inside, before its
 * policy will treat the offer as protected.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(PROVIDER_MANIFEST, { headers: { "cache-control": "no-store" } });
}
