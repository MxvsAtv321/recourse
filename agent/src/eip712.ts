import type { Address, Hex, TypedDataDomain } from "viem";
import type { DeliveryCommitment, PurchaseTerms } from "./types.js";

export const domainFor = (chainId: number, verifyingContract: Address): TypedDataDomain => ({
  name: "Recourse",
  version: "1",
  chainId,
  verifyingContract,
});

export const purchaseTermsTypes = {
  Condition: [
    { name: "conditionId", type: "uint8" },
    { name: "requires", type: "uint8" },
    { name: "quantifier", type: "uint8" },
    { name: "opcode", type: "uint8" },
    { name: "threshold", type: "bytes32" },
    { name: "permittedIssuer", type: "address" },
    { name: "expectedSourceId", type: "bytes32" },
    { name: "sourceQuote", type: "string" },
  ],
  PurchaseTerms: [
    { name: "purchaseId", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "conditions", type: "Condition[]" },
    { name: "challengeWindow", type: "uint64" },
    { name: "deliveryDeadline", type: "uint64" },
    { name: "curePeriod", type: "uint64" },
  ],
} as const;

export const deliveryCommitmentTypes = {
  DeliveryCommitment: [
    { name: "specHash", type: "bytes32" },
    { name: "conditionId", type: "uint8" },
    { name: "merkleRoot", type: "bytes32" },
    { name: "leafCount", type: "uint64" },
    { name: "sourceId", type: "bytes32" },
    { name: "payloadRef", type: "bytes32" },
  ],
} as const;

export const termsMessage = (t: PurchaseTerms) => ({
  purchaseId: t.purchaseId,
  buyer: t.buyer,
  seller: t.seller,
  amount: t.amount,
  asset: t.asset,
  conditions: t.conditions,
  challengeWindow: t.challengeWindow,
  deliveryDeadline: t.deliveryDeadline,
  curePeriod: t.curePeriod,
});

export const commitmentMessage = (c: DeliveryCommitment) => ({
  specHash: c.specHash,
  conditionId: c.conditionId,
  merkleRoot: c.merkleRoot,
  leafCount: c.leafCount,
  sourceId: c.sourceId,
  payloadRef: c.payloadRef,
});

export type Signed<T> = { value: T; signature: Hex };
