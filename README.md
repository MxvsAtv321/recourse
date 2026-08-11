# Recourse

Buyer protection for autonomous commerce. Payment becomes final only when machine-verifiable
delivery terms are satisfied.

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

| Contract | Address | Created in block |
|---|---|---|
| `RecourseEscrow` | [`0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696`](https://sepolia.basescan.org/address/0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696) | [45323814](https://sepolia.basescan.org/block/45323814) |

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

### The deployed bytecode is the same code the tests and demo run

Verified rather than asserted. The runtime bytecode at the address above is 13,415 bytes.
The local artifact from `forge build` over unmodified `contracts/src/` is the same length,
and the two are byte-identical once the two immutable spans recorded in the artifact
(offsets 847 and 10669, 32 bytes each) are masked. Those 64 bytes hold `_domainSeparator`,
which is computed in the constructor from `address(this)` and therefore differs by
deployment address by design. Nothing else differs.

To reproduce:

```bash
forge build
cast code 0x8cac26Ac9cDd66479661035eDAFA898eAc0f8696 --rpc-url https://sepolia.base.org
# compare against out/RecourseEscrow.sol/RecourseEscrow.json -> deployedBytecode.object,
# masking deployedBytecode.immutableReferences
```

### The recorded demo runs on local anvil, deliberately

`scripts/demo.sh` and the captured run behind the product surface both execute against a
local anvil node, not against this address. That is for determinism. The demo time travels
through challenge windows and cure periods with `evm_increaseTime`, deploys fresh contracts
every run so addresses and transaction hashes are reproducible, and finishes in seconds
instead of waiting on public block times.

The code is the same. Both come from `forge build` over the same unmodified sources, and the
bytecode check above is what establishes that. Nothing is stubbed, mocked or compiled
differently for the demo. The escrow at this address accepts the identical calls the demo
makes.
<!-- deployed:end -->
