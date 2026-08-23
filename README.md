# Recourse

Buyer protection for autonomous commerce. Recourse makes objectively falsifiable delivery
promises enforceable at settlement.

Escrow that checks the goods before releasing the money. Settlement is optimistic: funds
release after a challenge window unless someone submits a cryptographic proof that the
delivery broke an objective promise. One counterexample refunds the buyer. No arbiter.

## Three acts

**INSPECT** takes a commercial claim and the evidence artifacts that actually exist, and says
which can establish the claim, which cannot, and at exactly which gate each one fails.

**PROTECT** takes a buyer requirement carrying an explicit threshold and compiles it into a
Protection Manifest, or refuses and names the dimensions it is missing.

**ENFORCE** is the escrow, the predicate evaluator and the Merkle breach verifier.

INSPECT and PROTECT sit entirely above ENFORCE. They add no Solidity, no on-chain call and no
new opcode, and `contracts/` is frozen. No model call sits anywhere in the settlement path.

Full data shapes are in [`spec/SPEC.md`](spec/SPEC.md). The evidence type system is in
[`spec/EVIDENCE.md`](spec/EVIDENCE.md).

## Positioning

x402r already ships escrow-based refunds for x402 with pluggable per-arbiter dispute
resolution, and TessPay, Virtuals ACP and RAILS all occupy this space. We are not inventing
agent buyer protection.

> x402r gives agent payments a refund path with a configurable arbiter. Recourse is the
> condition that needs no arbiter, because objectively falsifiable fulfilment claims can be
> disproved by a single cryptographic counterexample.

## INSPECT: which evidence can carry a claim

An artifact is tested against a claim by four gates in a fixed order. The first gate that
fails is the reason, so the same artifact against the same claim always produces the same
sentence.

| Gate | The question it asks |
|---|---|
| 1 Subject | is this about the right thing at all: each record, the response, or the transaction |
| 2 Property | is it the right observable of that thing |
| 3 Attestation | can anyone check who said it, and were they permitted to |
| 4 Binding | is the value tied to the bytes it describes, or merely adjacent to them |

Subject precedes property because "this is a fact about the payment" defeats an artifact
before the question of which property it carries becomes interesting. Property precedes
binding because the founding rejection, a signed blob timestamp offered for a claim about
record generation time, is a perfectly bound artifact. Binding is not what is wrong with it.
Property is.

Nine reason codes, none of them dead:

```
SUBJECT_MISMATCH   SUBJECT_COLLAPSE                              gate 1
PROPERTY_MISMATCH  PROPERTY_REFUTED  PROPERTY_NOT_COMPARABLE     gate 2
ISSUER_UNSIGNED    ISSUER_NOT_PERMITTED  ISSUER_IS_OBLIGOR       gate 3
NO_ARTIFACT_OFFERED
```

### Five measured artifacts against one claim

The claim is `"every record generated within the last 60 seconds"`. Every row below was
measured against a live API on 2026-08-22 rather than imagined.

| Artifact | Stops at | Why |
|---|---|---|
| x402 payment receipt | Subject | `SUBJECT_MISMATCH`. It commits to payer, transaction and issuedAt. Every one is a fact about the payment, none about a record |
| CoinGecko `last_updated` | Subject | `SUBJECT_COLLAPSE`. A per-item field carrying a per-batch value: 4 calls, 400 records, one distinct value each time, spread 0.0 seconds |
| CoinGecko `is_stale` | Property | `PROPERTY_REFUTED`. Read false on a record whose last trade was 5692 seconds earlier. A verdict rather than a measurement, and the verdict is wrong |
| CoinGecko `last_traded_at` | Attestation | `ISSUER_UNSIGNED`. The right property at the right scope, genuinely varying, signed by nobody |
| Recourse delivery commitment | passes | `ENFORCEABLE`. Settles by counterexample |

Gate 1 carries two of the five lanes and they carry different codes. Lane 1 is refuted by
reading the schema. Lane 2 only by measurement. A declared scope is disproved only by
measurement, so the surface says which of the two happened rather than implying the field was
checked.

## PROTECT: compiling a requirement into a manifest

A requirement compiles, or it refuses and names what is missing. `UNPROTECTABLE` and
`REFUSED` are normal outcomes, not errors.

Three rules keep the compiler honest.

**A model may classify and extract. It may never invent a contractual value.** Every
threshold, quantifier, issuer and identifier in a Protection Manifest is a `Sourced<T>`
carrying either an exact span of the buyer requirement or a named policy field. There is no
constructor that takes a bare value, so a field without provenance cannot be written at all
and the manifest abstains instead.

**A vague term reports which dimensions are missing. It never proposes a value for them.**
`"high quality investment research"` returns `MISSING SUBJECT`, `MISSING PROPERTY` and
`MISSING THRESHOLD`, and no suggestion for any of them.

**A relative threshold resolves against a clock the obligor does not control.** Agreement time
frozen into the signed terms, or chain time, never a field in the delivery. Measured on
2026-08-22, AIsa's `last_fetch_at` drifted between 10 and 149 seconds behind the request
across four calls, which flipped the sign of a computed record age on 93 records in one call.

### The breach witness spec

When a claim compiles, PROTECT also emits the exact shape of the counterexample that would
refund the buyer, stated before any money moves. The falsifier is the negation of the claim's
opcode, and the canonical spec is hashed into a `witnessId`.

```
A record whose generatedAt is TIMESTAMP_LT 1787438194.

falsifier   TIMESTAMP_LT     negation of TIMESTAMP_GTE
threshold   1787438194       from requirement[39..41] "60"
binding     PREIMAGE
witnessId   0x18687631e32b9d6dc02e3d7b378edec7fc231697c1f3b2ac71ea0a290a2c5a36
```

After the proof executes, the witnessId is recomputed from what the chain recorded and
compared field by field. The same hex on both sides is what makes "stated before, satisfied
after" checkable rather than narrated. A spec whose threshold differs by one second hashes to
`0x485828…`, so the digest is doing work.

The seller signs the commercial manifest and the upstream issuer signs delivery commitments.
Signing refuses if the two addresses are the same, because an obligor attesting to its own
performance establishes nothing.

## ENFORCE: how settlement works

| Claim shape | Settles by |
|---|---|
| Universal, over every record | one counterexample, proved from leaves the buyer holds |
| Scalar, over the delivery | direct evaluation against the signed commitment |
| Neither | `UNPROTECTABLE`, and no protected payment opens |

Merkle leaves bind content to timestamp in one preimage:

```
leaf = keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))
```

A tree over bare timestamps would let a fresh timestamp be paired with stale content. That
gap, between when a file existed and when the records inside it were generated, is the attack
the whole design exists to close.

The opcode set is exactly `UINT_GTE`, `UINT_EQ`, `TIMESTAMP_GTE`, `BYTES32_EQ`, and it never
grows to fit a term. Universal claims are enforced by counterexample, never by on-chain
iteration. A breach proof that fails any check reverts; there is no partial success.

## The demo path

```
an unprotected purchase passes every check an agent runs today
  -> per-record timestamps reveal yesterday's data
  -> the same delivery through Recourse
  -> one breach proof
  -> refund
```

$0.010 goes into escrow against `"every record generated within the last 60 seconds"`. The
delivery carries 500 records, 251 of them break the promise, and the first violating record is
at index 187, so the head of the file looks clean to anyone who spot checks it. One
counterexample at that index refunds the full amount.

## Layout

```
contracts/src/    three contracts: escrow, predicate evaluator, Merkle breach verifier
contracts/test/   the suite, 45 tests
spec/             SPEC.md, the data shapes. EVIDENCE.md, the evidence type system
agent/src/        evidence engine, claim compiler, witness synthesis, purchasing policy,
                  manifest signing, seller mock, buyer verifier, scenario engine
agent/src/demo/   walkthroughs, each of which prints every value it asserts
ui/               product surface: one continuous page at /, presentation mode at /present
scripts/          demo, deployment, verification
```

## Running it

```bash
forge test -vv          # the suite, 45 tests
bash scripts/demo.sh    # six scenarios end to end against a local anvil
```

The demo starts its own anvil on `127.0.0.1:8545`, deploys fresh contracts, runs every
scenario and cleans up after itself.

The INSPECT and PROTECT walkthroughs need no chain, and print what they checked rather than a
pass count:

```bash
npm run inspect:check        # four gates and nine reasons over the five measured artifacts
npm run inspect:walkthrough  # the same ground, at length
npm run witness:check        # synthesis, and correspondence with the executed proof
npm run present:check        # all fourteen presentation states
```

To see the product surface:

```bash
anvil &                 # or let the demo do it
npm run capture         # execute the scenarios, write ui/data/run.json
npm run build && npm start
```

`/` is one page and reads in one direction: the requirement compiles, the manifest is signed,
the escrow settles, the money comes back. Every figure is read from the captured run, and the
enforcement section upgrades to a live run against anvil when one is reachable. If the
artifact is missing the page says so rather than inventing numbers.

`/present` is the same argument as fourteen full screen states advanced by arrow keys, for a
projector. `?s=N` addresses any state directly, which is what saves you when a question sends
you backwards.

## Scenarios

| Verdict | What it demonstrates |
|---|---|
| `UNPROTECTED` | every check an agent runs today passes on a stale delivery |
| `BREACH_PROVED` | one counterexample reverses settlement |
| `RELEASE` | compliant delivery, nobody challenges, funds to seller |
| `UNPROTECTABLE` | a term that maps to no supported condition opens no escrow |
| `STALLED` | seller never delivers, buyer reclaims after the deadline |
| `WITHHELD` | seller commits a root but sends no payload, buyer contests availability |

## Deploying to Base Sepolia

```bash
cp .env.example .env    # set DEPLOYER_PRIVATE_KEY, fund the address from a faucet
bash scripts/deploy-base-sepolia.sh
```

`.env` is gitignored. The deploy script reads the key into its own process and never prints
it or writes it to the deployment record.

<!-- deployed:start -->
## Deployed

**Base Sepolia**, chain `84532`.

| Contract | Address | Created in block | Built from |
|---|---|---|---|
| `RecourseEscrow` | [`0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696`](https://sepolia.basescan.org/address/0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696) | [45323814](https://sepolia.basescan.org/block/45323814) | commit `6e27a8d` |

**This address is pinned to commit `6e27a8d` and does not track `HEAD`.** `HEAD` has since
moved in two directions. Two `openPurchase` guards were added, rejecting an asset with no
deployed code and a zero amount, worth 93 bytes of runtime bytecode. The `SCHEMA_HASH` branch
was then cut from `_establishedByBoundLeaves` and `_observed`, giving 45 bytes back. `HEAD` is
therefore 48 bytes larger than the deployed contract rather than 93, and it differs by more
than the guards, so a build of `HEAD` will not reproduce this address. Reproduce against
`6e27a8d`.

Source is not verified on Basescan. The bytecode check below is the stronger claim anyway,
and anyone can reproduce it.

### Why only one address

`PredicateEvaluator` and `MerkleBreachVerifier` have no deployed address, and should not
have one. Every function in both is `internal`. Solidity inlines internal library functions
into the calling contract rather than linking them, so their logic is compiled directly into
`RecourseEscrow` and reached by `JUMP`, never by `DELEGATECALL`. `RecourseEscrow`'s build
artifact confirms it: `linkReferences` is empty.

Deploying them separately would produce addresses that nothing references and nothing can
call, since a library with no `public` or `external` functions exposes no ABI. Listing such
addresses here would imply a runtime dependency that does not exist, so they are not listed.

The two libraries are real and are exercised by the test suite. They are at
`contracts/src/PredicateEvaluator.sol` and `contracts/src/MerkleBreachVerifier.sol`, and
their code runs at the escrow address above.

### The deployed bytecode is the code at commit 6e27a8d

Verified rather than asserted. The runtime bytecode at the address above is 13,415 bytes
(26,832 hex chars). A `forge build` of `contracts/src/` **at commit `6e27a8d`** produces the
same length, and the two are byte-identical once the two immutable spans recorded in the
artifact (offsets 847 and 10669, 32 bytes each) are masked. Those 64 bytes hold
`_domainSeparator`, computed in the constructor from `address(this)` and therefore different
per deployment address by design. Nothing else differs.

A build of `HEAD` produces 26,928 hex chars, 13,463 bytes, and does not match. The 48 byte
difference is the two `openPurchase` guards adding 93 bytes and the removal of the
`SCHEMA_HASH` branch taking 45 back. That is expected, not a discrepancy.

To reproduce, check out the pinned commit first. A worktree keeps your working tree intact:

```bash
git worktree add --detach /tmp/recourse-6e27a8d 6e27a8d
cd /tmp/recourse-6e27a8d && forge build

node scripts/assert-runtime-bytecode.mjs \
  0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696 \
  /tmp/recourse-6e27a8d/out/RecourseEscrow.sol/RecourseEscrow.json \
  https://sepolia.base.org

git worktree remove /tmp/recourse-6e27a8d
```

`scripts/assert-runtime-bytecode.mjs` does the masking and exits non-zero on any mismatch.
Run it from the repo root; it works against any checkout, so pass the artifact path from the
worktree as above.

### The recorded demo runs on local anvil, deliberately

`scripts/demo.sh` and the captured run behind the product surface both execute against a
local anvil node, not against this address. That is for determinism. The demo time travels
through challenge windows and cure periods with `evm_increaseTime`, deploys fresh contracts
every run so addresses and transaction hashes are reproducible, and finishes in seconds
instead of waiting on public block times.

The code is the same at the pinned commit. Both come from `forge build` over the same
unmodified sources at `6e27a8d`, and the bytecode check above is what establishes that.
Nothing is stubbed, mocked or compiled differently for the demo. The escrow at this address
accepts the identical calls the demo made at that commit.

The demo you run today executes against `HEAD`, which carries the two extra guards and no
longer accepts a `SCHEMA_HASH` condition. The guards only reject purchases the deployed
contract would have accepted and then failed to fund, and no scenario ever compiled a schema
condition, so no scenario behaves differently. If you need the deployed address and the demo
to be bytecode identical again, redeploy from `HEAD`.
<!-- deployed:end -->
