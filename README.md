# Recourse

Buyer protection for autonomous commerce. Recourse makes objectively falsifiable delivery
promises enforceable at settlement.

Escrow that checks the goods before releasing the money. Settlement is optimistic: funds
release after a challenge window unless someone submits a cryptographic proof that the
delivery broke an objective promise. One counterexample refunds the buyer. No arbiter.

## Positioning

x402r already ships escrow-based refunds for x402 with pluggable per-arbiter dispute
resolution, and TessPay, Virtuals ACP and RAILS all occupy this space. We are not inventing
agent buyer protection.

> x402r gives agent payments a refund path with a configurable arbiter. Recourse is the
> condition that needs no arbiter, because objectively falsifiable fulfilment claims can be
> disproved by a single cryptographic counterexample.

## How settlement works

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
gap, between when a file existed and when the records inside it were generated, is the
attack the whole design exists to close.

The opcode set is exactly `UINT_GTE`, `UINT_EQ`, `TIMESTAMP_GTE`, `BYTES32_EQ`, and it never
grows to fit a term.

## Layout

```
contracts/src/    three contracts: escrow, predicate evaluator, Merkle breach verifier
contracts/test/   the suite
agent/            term compiler, seller mock, buyer verifier, scenario engine
ui/               product surface, rendered from a captured live run
scripts/          demo, deployment, verification
```

## Running it

```bash
forge test -vv          # the suite
bash scripts/demo.sh    # six scenarios end to end against a local anvil
```

The demo starts its own anvil on `127.0.0.1:8545`, deploys fresh contracts, runs every
scenario and cleans up after itself.

To see the product surface:

```bash
anvil &                 # or let the demo do it
npm run capture         # execute the scenarios, write ui/data/run.json
npm run build && npm start
```

Every figure the surface shows is read from that captured run. If the artifact is missing
the page says so rather than inventing numbers.

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
advanced by two `openPurchase` guards, which rejects an asset with no deployed code and a
zero amount. Those 8 lines add 93 bytes of runtime bytecode, so the deployed contract does
not contain them and a build of `HEAD` will not reproduce this address. Reproduce against
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

A build of `HEAD` produces 27,018 hex chars and does not match, by exactly the 93 bytes the
two `openPurchase` guards add. That is expected, not a discrepancy.

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

The demo you run today executes against `HEAD`, which carries the two extra guards. Those
guards only reject purchases the deployed contract would have accepted and then failed to
fund, so no scenario behaves differently. If you need the deployed address and the demo to
be bytecode identical again, redeploy from `HEAD`.
<!-- deployed:end -->
