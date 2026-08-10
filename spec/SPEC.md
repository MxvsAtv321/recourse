# Recourse specification

Frozen data shapes. Four corrections from the previous draft are marked FIXED.

---

## 1. PurchaseTerms (EIP-712, signed by both parties before escrow opens)

```solidity
struct PurchaseTerms {
    bytes32     purchaseId;       // random unique identifier, chosen by the buyer
    address     buyer;
    address     seller;
    uint256     amount;           // base units
    address     asset;            // test USDC
    Condition[] conditions;
    uint64      challengeWindow;  // seconds after delivery commitment before release
}
```

`specHash = EIP712 typed-data hash of PurchaseTerms`, **derived, never a field.**

> **FIXED.** The previous draft put `specId` inside the struct it was supposedly the hash
> of, which is circular and unimplementable. `purchaseId` distinguishes otherwise identical
> purchases; `specHash` is the digest of what both parties signed.

The EIP-712 domain is `{ name: "Recourse", version: "1", chainId, verifyingContract }`.
Terms valid for one purchase must revert on another. Tested.

## 2. Condition

```solidity
struct Condition {
    uint8      conditionId;
    ClaimType  requires;          // what must be established
    Quantifier quantifier;        // SCALAR | UNIVERSAL
    Opcode     opcode;            // UINT_GTE | UINT_EQ | TIMESTAMP_GTE | BYTES32_EQ
    bytes32    threshold;
    address    permittedIssuer;   // the signing key allowed to attest this claim
    bytes32    expectedSourceId;  // semantic origin, e.g. COINBASE_ETH_USD_FEED
    string     sourceQuote;       // the phrase in the listing that generated this
}
```

> **FIXED.** The previous draft said "verify `sourceId` equals `permittedSource`", conflating
> a bytes32 semantic identifier with an Ethereum signing address. They are different things.
> The contract now recovers the signer and compares it to `permittedIssuer`, and separately
> checks the leaf's `sourceId` against `expectedSourceId`.

`sourceQuote` is for the UI. Showing the judge which words created which protection is most
of the "we understood the agreement" story at zero engineering cost.

`quantifier = UNIVERSAL` means enforcement by counterexample. No on-chain iteration.

## 3. ClaimType and what establishes it

```solidity
enum ClaimType { ROW_COUNT, SCHEMA_HASH, RECORD_GENERATION_TIME, BLOB_EXISTENCE_TIME }
```

| Claim | Established by | NOT established by |
|---|---|---|
| `ROW_COUNT` | committed payload, recomputable by anyone | seller assertion |
| `SCHEMA_HASH` | committed payload, recomputable by anyone | seller assertion |
| `RECORD_GENERATION_TIME` | upstream-signed delivery commitment over bound leaves | **a signed timestamp over the delivered file** |
| `BLOB_EXISTENCE_TIME` | a signed timestamp over the delivered file | anything about the records inside |

The last two rows are the intellectual core. A signed blob timestamp is cryptographically
authentic and establishes when the *file* existed. The seller can put yesterday's records in
a new file this morning and have it timestamped honestly.

## 4. EvidenceOffer, checked before escrow opens

```solidity
struct EvidenceOffer {
    uint8     conditionId;
    ClaimType establishes;   // what the seller's evidence actually proves
    address   issuer;
}
```

> **FIXED.** The previous draft described rejecting mismatched evidence but gave the contract
> nothing to compare against, since only the condition's required claim existed. Both sides
> of the comparison must be represented.

Before opening escrow, for every condition:

```
require(offer.establishes == condition.requires, CLAIM_TYPE_MISMATCH);
require(offer.issuer      == condition.permittedIssuer);
```

Demo path: seller offers `BLOB_EXISTENCE_TIME` for a condition requiring
`RECORD_GENERATION_TIME`, gets `CLAIM_TYPE_MISMATCH`, then re-offers an upstream-signed
record commitment and is accepted.

## 5. DeliveryCommitment (signed by the upstream issuer)

```solidity
struct DeliveryCommitment {
    bytes32 specHash;      // binds to THIS purchase
    uint8   conditionId;   // binds to THIS obligation
    bytes32 merkleRoot;    // binds to THIS delivery
    bytes32 sourceId;      // semantic origin
}
```

> **FIXED.** The previous draft had the issuer sign a bare Merkle root, so a valid signature
> from one purchase could be replayed against another. The signed object is now a typed
> commitment bound to the purchase and the obligation.

Leaf construction, unchanged and correct:

```solidity
leaf = keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId));
```

Content hash and timestamp live in the same leaf. A tree over bare timestamps proves only
that some timestamp appeared in some tree, which permits pairing a fresh timestamp with
stale content.

## 6. BreachProof

```solidity
struct BreachProof {
    bytes32   specHash;
    uint8     conditionId;
    uint256   index;
    bytes     recordBytes;
    uint64    generatedAt;
    bytes32   sourceId;
    bytes32[] merklePath;
}
```

Verification order in `submitBreachProof`:

1. recompute the leaf from `index`, `keccak256(recordBytes)`, `generatedAt`, `sourceId`
2. verify `merklePath` against the root in the stored, signed `DeliveryCommitment`
3. verify that commitment's `specHash` and `conditionId` match this purchase and obligation
4. verify the recovered commitment signer equals `condition.permittedIssuer`
5. verify `sourceId` equals `condition.expectedSourceId`
6. verify the condition's `requires` matches the claim this evidence establishes
7. evaluate the opcode and confirm it is **violated**
8. refund the buyer in full, emit the offending index

Any failure reverts.

## 7. Verdicts

| Verdict | Trigger | Settlement |
|---|---|---|
| `RELEASE` | challenge window expired, no valid proof | funds to seller |
| `BREACH_PROVED` | valid counterexample verified | full refund, emit index |
| `UNPROTECTABLE` | a term maps to no supported condition | no escrow opens at all |
| `CLAIM_TYPE_MISMATCH` | offered evidence establishes the wrong claim | rejected pre-payment |

## 8. The eight tests

| Test | Proves |
|---|---|
| `testReleaseAfterChallengeWindow` | optimistic settlement works |
| `testBreachProofRefunds` | one counterexample reverses settlement |
| `testRejectProofWithUnboundContent` | **sacred.** A proof pairing a fresh timestamp leaf with different record bytes reverts. |
| `testRejectProofWithBadMerklePath` | inclusion is actually verified |
| `testRejectProofFromUnpermittedIssuer` | recovered signer is checked against `permittedIssuer` |
| `testRejectClaimTypeMismatch` | authentic-but-irrelevant evidence is refused pre-payment |
| `testRejectCrossSpecReplay` | signed terms cannot move between purchases |
| `testRejectRootReplayAcrossSpec` | a signed DeliveryCommitment from purchase A reverts on purchase B |

Without `testRejectProofWithUnboundContent` the entire proof system is decorative.

## 9. Answers to have ready, not to build

**Who runs the verifier?** Anyone can challenge. The buyer has the strongest incentive and
its agent scans deliveries locally. At scale you would bond challengers. Not built.

**Isn't the upstream issuer still trusted?** Yes. We removed the seller's ability to attest
to its own performance. We did not remove the need for a source of record. Say this first.

**Isn't this x402r?** x402r provides refundable agent payments with pluggable per-arbiter
dispute resolution. Recourse contributes typed fulfilment claims and arbiter-free
counterexample proofs for objectively falsifiable conditions. If integration is under an
hour after the core works, plug in as an x402r condition; otherwise keep the demo escrow and
say so plainly.

**Isn't this TessPay / ACP / RAILS?** TessPay is verify-then-pay on execution proofs. ACP
uses evaluator agents. RAILS is broad evidence-based clearing. All three determine outcomes
through a verifier or evaluator; we remove that role for the falsifiable subset.
