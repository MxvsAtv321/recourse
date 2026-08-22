# Recourse

Buyer protection for autonomous commerce. Recourse makes objectively falsifiable delivery
promises enforceable at settlement.

NTU InnovateX 2026, Track 1. Stage 1 due 14 Aug, submit 10:00 EDT.

Full data shapes: `spec/SPEC.md`. Evidence type system: `spec/EVIDENCE.md`.
Path-scoped detail: `.claude/rules/recourse-invariants.md`.
The rules below are here rather than there because root CLAUDE.md is re-injected after
compaction and path-scoped rules are not.

---

## What this is

Escrow that checks the goods before releasing the money. Settlement is optimistic: funds
release after a challenge window unless someone submits a cryptographic proof that the
delivery broke an objective promise. One counterexample refunds the buyer. No arbiter.

Three acts. INSPECT takes a commercial claim and the evidence artifacts that actually exist,
and says which can establish the claim, which cannot, and at exactly which gate each one
fails. PROTECT takes a buyer requirement carrying an explicit threshold and emits a
Protection Manifest, or refuses and names the missing dimensions. ENFORCE is the escrow, the
predicate evaluator and the Merkle breach verifier, and it is frozen.

INSPECT and PROTECT sit entirely above ENFORCE. They add no Solidity, no on-chain call and no
new opcode.

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
9. **A model may classify and extract. It may never invent a contractual value.** Every
   threshold, quantifier, issuer and identifier in a Protection Manifest is a `Sourced<T>`
   carrying either an exact span of the buyer requirement or seller offer, or a named policy
   field. There is no constructor that takes a bare value. If provenance cannot be produced,
   the field is not written and the manifest abstains.
10. **A vague term reports which dimensions are missing. It never proposes a value for them.**
    `REFUSED` with a `missing` list is a normal outcome, like `UNPROTECTABLE`.
11. **A relative threshold resolves against a clock the obligor does not control.** Agreement
    time, frozen into the signed terms, or chain time. Never a field in the delivery.
    Measured 2026-08-22: AIsa's `last_fetch_at` drifted between 10 and 149 seconds behind the
    request across four calls, flipping the sign of a computed record age on 93 records in one
    call and 22 in another.
12. **A declared scope is disproved only by measurement.** An `Artifact` without a
    `Resolution` is one whose schema is being trusted, unless its binding is `PREIMAGE` over a
    per-record index, which makes per-record scope structural. Say so on the surface rather
    than implying the field was checked.

## Hard scope

`contracts/` holds exactly three things: one escrow, one predicate evaluator, one Merkle
breach verifier.

`contracts/` is frozen. INSPECT and PROTECT are TypeScript above it. Any proposal that
requires a Solidity change is out of scope by definition, not by budget.

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
