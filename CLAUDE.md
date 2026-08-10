# Recourse

Buyer protection for autonomous commerce. Payment becomes final only when machine-verifiable
delivery terms are satisfied.

NTU InnovateX 2026, Track 1. Stage 1 due 14 Aug, submit 10:00 EDT.

Full data shapes: `spec/SPEC.md`. Path-scoped detail: `.claude/rules/recourse-invariants.md`.
The rules below are here rather than there because root CLAUDE.md is re-injected after
compaction and path-scoped rules are not.

---

## What this is

Escrow that checks the goods before releasing the money. Settlement is optimistic: funds
release after a challenge window unless someone submits a cryptographic proof that the
delivery broke an objective promise. One counterexample refunds the buyer. No arbiter.

## Positioning, which constrains the build

**x402r already exists** and ships escrow-based refunds for x402 with pluggable per-arbiter
dispute resolution. We are not inventing agent buyer protection.

> x402r gives agent payments a refund path with a configurable arbiter. Recourse is the
> condition that needs no arbiter, because objectively falsifiable fulfilment claims can be
> disproved by a single cryptographic counterexample.

Never claim nobody else verifies fulfilment. TessPay, Virtuals ACP, RAILS and x402r all
occupy this space.

## Non-negotiable invariants

1. **No model call anywhere in the settlement path.**
2. **Merkle leaves bind content to timestamp:**
   `keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))`
   A tree over bare timestamps lets a fresh timestamp be paired with stale content.
3. **Universal claims are enforced by counterexample, never by on-chain iteration.**
   There is no ALL_ opcode. If you are looping over records in Solidity, stop.
4. **No sampling, no randomness, no sample seed.** That design was cut for being
   probabilistic on the happy path.
5. **Optimistic settlement with a challenge window is load-bearing.** Do not collapse it
   into immediate settlement. On anvil the window is seconds; the state transition stays.
6. **Opcode set is exactly** `UINT_GTE`, `UINT_EQ`, `TIMESTAMP_GTE`, `BYTES32_EQ`.
   It never grows to fit a term. Unexpressible terms are UNPROTECTABLE.
7. **UNPROTECTABLE is a normal outcome**, not an error.
8. **A breach proof that fails any check reverts.** There is no partial success.

## Hard scope

`contracts/` holds exactly three things: one escrow, one predicate evaluator, one Merkle
breach verifier.

No on-chain strings. No on-chain JSON. No dynamic interpretation. No general VM. No ZK.
No oracle network. No verifier registry.

**Do not implement real RFC-3161.** ASN.1 parsing and TSA chain validation are a trap. The
weak evidence artifact is a "signed blob timestamp": an issuer signature over the delivered
file hash and a time. The intellectual point survives intact, which is that blob existence
time is not record generation time. Never display "RFC-3161 verified".

## Do not build

Sampling. A corpus. An eval harness. Calibration. A learning or promotion loop. A general
natural-language compiler. If you think one is needed, say so and stop.

## Stack

- Solidity, Foundry, local anvil. Base Sepolia only after the demo path is green.
- TypeScript and Next.js for agent, mocks and UI.
- `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/express`. The bare `x402`, `x402-fetch`
  and `x402-axios` packages are v1 and deprecated. `payTo` is the escrow, never the seller.
- Verify the current API model string in the console; do not use one quoted from chat.

## The demo path, which must never break

unprotected purchase passes every check -> per-record timestamps reveal yesterday's data ->
same delivery through Recourse -> one breach proof -> refund

## Language

Product surface says **breach proof**. Technical Q&A says **fraud proof**, because a crypto
judge recognises the shape immediately. No em dashes. "Shrirang Shivesh" formally.
