---
name: proof-check
description: Audit the breach proof verification path against spec/SPEC.md and report gaps. Read-only.
disable-model-invocation: true
context: fork
background: false
allowed-tools: Read Grep Bash(forge test *)
disallowed-tools: Edit Write
---

Read `spec/SPEC.md` sections 5 and 6, then the escrow contract and the Merkle breach
verifier.

Report PASS or FAIL for each item below, with the offending file and line for any FAIL.

1. Is the leaf recomputed inside the contract from `index`, `keccak256(recordBytes)`,
   `generatedAt` AND `sourceId`? All four, from the proof's own inputs.
2. Is the Merkle path verified against the root inside the stored, signed
   `DeliveryCommitment`, rather than a root supplied alongside the proof?
3. Does the `DeliveryCommitment` bind `specHash` and `conditionId`, and are both checked
   against the purchase and obligation being settled?
4. Is the recovered commitment signer compared to `condition.permittedIssuer` as an address?
5. Is `sourceId` separately compared to `condition.expectedSourceId` as bytes32? These must
   be two distinct checks over two distinct types.
6. Is `EvidenceOffer.establishes` compared to `Condition.requires` before escrow opens?
7. Does the contract confirm the opcode is VIOLATED, rather than merely evaluating it?
8. Does every failure path revert, rather than returning a status or a boolean?
9. Is there any loop over records in Solidity? There must not be.
10. Can a signed `DeliveryCommitment` from purchase A be replayed against purchase B? Trace
    the actual guard rather than assuming the struct fields are enough.
11. Is `specHash` derived as the EIP-712 hash of `PurchaseTerms`, and absent as a field
    inside that struct?

Then run `forge test -vv` and confirm `testRejectProofWithUnboundContent` and
`testRejectRootReplayAcrossSpec` are present and passing.

Report only. Do not modify anything.
