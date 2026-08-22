/**
 * The commercial Protection Manifest a provider publishes.
 *
 * Trust roles are separate and stay separate. The SELLER signs this: it is a
 * promise about what will be delivered and under whose attestation. The ISSUER
 * named inside it signs delivery commitments later, and that is what the escrow
 * checks. The seller's key never signs evidence and the issuer's key never signs
 * the commercial offer.
 *
 * Nothing here touches settlement. The escrow reads PurchaseTerms, not this.
 */
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export const MANIFEST_DOMAIN = {
  name: "Recourse Protection Manifest",
  version: "1",
} as const;

export const MANIFEST_TYPES = {
  ProtectionManifest: [
    { name: "offerId", type: "string" },
    { name: "vendor", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "priceMicrosUsd", type: "uint256" },
    { name: "claim", type: "string" },
    { name: "subject", type: "string" },
    { name: "property", type: "string" },
    { name: "thresholdSeconds", type: "uint256" },
    { name: "permittedIssuer", type: "address" },
    { name: "expectedSourceId", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export type ManifestBody = {
  offerId: string;
  vendor: string;
  endpoint: string;
  priceMicrosUsd: string;
  claim: string;
  subject: string;
  property: string;
  thresholdSeconds: string;
  /** The key whose delivery commitments the escrow will accept. Not the signer. */
  permittedIssuer: Address;
  expectedSourceId: string;
  issuedAt: string;
};

export type SignedManifest = {
  manifest: ManifestBody;
  /** The seller. Recovering this from the signature is the whole point. */
  signer: Address;
  signature: Hex;
  domain: typeof MANIFEST_DOMAIN;
  primaryType: "ProtectionManifest";
};

const message = (m: ManifestBody) => ({
  offerId: m.offerId,
  vendor: m.vendor,
  endpoint: m.endpoint,
  priceMicrosUsd: BigInt(m.priceMicrosUsd),
  claim: m.claim,
  subject: m.subject,
  property: m.property,
  thresholdSeconds: BigInt(m.thresholdSeconds),
  permittedIssuer: m.permittedIssuer,
  expectedSourceId: m.expectedSourceId,
  issuedAt: BigInt(m.issuedAt),
});

/** The provider signs what it promises. Pass the SELLER account, never the issuer. */
export async function signManifest(seller: PrivateKeyAccount, m: ManifestBody): Promise<SignedManifest> {
  if (seller.address.toLowerCase() === m.permittedIssuer.toLowerCase()) {
    throw new Error("the seller must not be the permitted issuer: that collapses the two trust roles");
  }
  const signature = await seller.signTypedData({
    domain: MANIFEST_DOMAIN,
    types: MANIFEST_TYPES,
    primaryType: "ProtectionManifest",
    message: message(m) as never,
  });
  return { manifest: m, signer: seller.address, signature, domain: MANIFEST_DOMAIN, primaryType: "ProtectionManifest" };
}

export type Verification = {
  ok: boolean;
  recovered: Address | null;
  claimedSigner: Address;
  rolesSeparate: boolean;
  reason: string;
};

/** The buyer recovers the signer and checks it is the seller, not the issuer. */
export async function verifyManifest(s: SignedManifest): Promise<Verification> {
  let recovered: Address | null = null;
  try {
    recovered = await recoverTypedDataAddress({
      domain: MANIFEST_DOMAIN,
      types: MANIFEST_TYPES,
      primaryType: "ProtectionManifest",
      message: message(s.manifest) as never,
      signature: s.signature,
    });
  } catch {
    return { ok: false, recovered: null, claimedSigner: s.signer, rolesSeparate: false, reason: "signature did not recover" };
  }
  const matches = recovered.toLowerCase() === s.signer.toLowerCase();
  const rolesSeparate = recovered.toLowerCase() !== s.manifest.permittedIssuer.toLowerCase();
  if (!matches) {
    return { ok: false, recovered, claimedSigner: s.signer, rolesSeparate, reason: "recovered signer is not the claimed signer" };
  }
  if (!rolesSeparate) {
    return { ok: false, recovered, claimedSigner: s.signer, rolesSeparate, reason: "the signer is also the permitted issuer" };
  }
  return {
    ok: true,
    recovered,
    claimedSigner: s.signer,
    rolesSeparate: true,
    reason: "signed by the seller, and the permitted issuer named inside it is a different key",
  };
}
