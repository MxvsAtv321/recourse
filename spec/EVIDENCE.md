# Evidence specification

The type system for INSPECT and PROTECT. Frozen shapes.

`spec/SPEC.md` covers ENFORCE, which is the escrow, the predicate evaluator and the Merkle
breach verifier. This file covers the two acts above it.

---

## 0. Scope, and why nothing here can reach settlement

Nothing in this file is reachable from the settlement path. That is checkable rather than
asserted: no type or function defined here is imported by `contracts/`, by
`agent/src/verifier.ts` on the breach path, or by anything `submitBreachProof` touches.
INSPECT and PROTECT run before money moves and produce documents. ENFORCE runs on chain and
produces refunds. Invariant 1 is unchanged: no model call anywhere in the settlement path.

INSPECT answers: given a commercial claim and the evidence artifacts that actually exist,
which artifacts can establish the claim, which cannot, and at exactly which gate each one
fails.

PROTECT answers: given a buyer requirement containing an explicit threshold, produce a
machine-readable Protection Manifest, or refuse and name the missing dimensions.

---

## 1. The four gates, and why they are ordered

An artifact is tested against a claim by four gates in a fixed order. The first gate that
fails is the reason. Fixed order means the same artifact against the same claim always
produces the same sentence, which is what makes the output quotable.

1. **Subject.** Is this about the right thing at all: each record, the response as a whole,
   or the transaction.
2. **Property.** Is it the right observable of that thing.
3. **Attestation.** Can anyone check who said it, and were they permitted to.
4. **Binding.** Is the asserted value tied to the bytes it describes, or merely adjacent to
   them.

Subject precedes property because "this is a fact about the payment" defeats an artifact
before any question about which property it carries becomes interesting. Property precedes
binding because the project's founding rejection, a signed blob timestamp offered for a claim
about record generation time, is a **perfectly bound** artifact. Its value and the content
hash it describes enter one preimage under an authentic signature. Binding is not what is
wrong with it. Property is.

Attestation precedes binding because binding decides the tier, not the pass. An artifact that
is bound but unsigned tells you nothing, whereas an artifact that is signed by the permitted
issuer but only adjacent to its content is `ATTESTED`, which is a real and useful outcome.

## 1.1 Scope is a pair, not a field

A declared subject is what the schema says. An effective subject is what measurement says.
The gap between them is only discoverable by calling the endpoint enough times, and it is the
single most useful thing INSPECT does that a reader of documentation cannot do.

An `Artifact` carrying no `Resolution` is one whose declared subject is being trusted. The
surface must say so rather than implying the field was checked. The exception is an artifact
whose binding is `PREIMAGE` over a per-record index, where per-record scope is structural
rather than observed and no measurement is required.

## 1.2 Uniformity refutes a timestamp. It does not refute a boolean.

`last_updated` and `is_stale` were both observed to carry exactly one distinct value across
every response. Only one of them collapses.

A timestamp field that is byte-identical across 100 rows of a table rebuilt over 14 to 16
minutes cannot be a per-row generation time. The value space is large and uniformity in it is
implausible under the field's declared meaning, so the declared subject is refuted.

A boolean that is uniformly false is just a boolean that is false. Nothing about a
two-valued field being constant contradicts a per-record scope. `is_stale` keeps
`effectiveSubject: "RECORD"` and is defeated later, at gate 2, on different grounds.

`maxDistinctPerResponse` is therefore evidence, not a rule. `effectiveSubject` is set by the
author of the fixture and `method` records what justifies it.

---

## 2. Types

```ts
export type Subject  = "RECORD" | "RESPONSE" | "TRANSACTION";

export type Property =
  | "GENERATION_TIME"   // when the datum came into being upstream
  | "OBSERVATION_TIME"  // when somebody looked at it
  | "EXISTENCE_TIME"    // when the container existed
  | "CONTENT_DIGEST"
  | "CARDINALITY"
  | "JUDGMENT";         // a verdict about a property, never the property itself

export type Binding =
  | "PREIMAGE"          // value and content hash enter one hash together
  | "ADJACENT"          // same object, freely recombinable
  | "NONE";             // asserted out of band, no association with the payload at all

export type Attestation =
  | { kind: "SIGNED"; issuer: string; scheme: "EIP712" | "JWS" }
  | { kind: "UNSIGNED" };

/** The only thing that can ever disprove a declared subject or a field's asserted meaning. */
export type Resolution = {
  method: string;                 // what was called, how many times, over what window
  maxDistinctPerResponse: number; // evidence for effectiveSubject, never the rule itself
  effectiveSubject: Subject;
  /** One observed record the field's asserted meaning cannot account for. */
  refutedBy?: { record: string; asserted: string; actual: string };
};

export type Artifact = {
  id: string;
  origin: string;        // verbatim, e.g. "GET /apis/v1/coingecko/coins/markets"
  commitsTo: string[];   // the exact fields it binds, nothing implied
  subject: Subject;      // what its schema says
  property: Property;
  binding: Binding;
  attestation: Attestation;
  measured?: Resolution;
};

// ---- the claim side ---------------------------------------------------------

export type Frame =
  | { kind: "AGREEMENT_TIME" }                  // frozen into the signed terms
  | { kind: "CHAIN_TIME" }
  | { kind: "ARTIFACT_FIELD"; field: string };  // obligor-supplied. always refused.

export type Test =
  | { op: "AT_OR_AFTER"; seconds: number; frame: Frame }
  | { op: "GTE" | "EQ"; count: number }
  | { op: "EQ"; digest: string };

export type Claim = {
  quote: string;         // exact substring of the requirement
  subject: Subject;
  property: Property;
  test: Test;
  permittedIssuer?: string;
};

// ---- provenance. a value with no origin is never written. -------------------

export type Sourced<T> =
  | { value: T; from: "REQUIREMENT" | "OFFER"; quote: string; span: [number, number] }
  | { value: T; from: "POLICY"; field: string };

// ---- verdicts ---------------------------------------------------------------

export type Reason =
  | { code: "SUBJECT_MISMATCH";        needs: Subject; found: Subject }
  | { code: "SUBJECT_COLLAPSE";        declared: Subject; effective: Subject; evidence: string }
  | { code: "PROPERTY_REFUTED";        found: Property; record: string; asserted: string; actual: string }
  | { code: "PROPERTY_NOT_COMPARABLE"; found: Property }
  | { code: "PROPERTY_MISMATCH";       needs: Property; found: Property }
  | { code: "ISSUER_UNSIGNED" }
  | { code: "ISSUER_NOT_PERMITTED";    permitted: string; found: string }
  | { code: "ISSUER_IS_OBLIGOR";       obligor: string }
  | { code: "NO_ARTIFACT_OFFERED" };

export type Finding =
  | { verdict: "ENFORCEABLE";   artifact: string; settlesBy: "COUNTEREXAMPLE" | "DIRECT_EVALUATION" }
  | { verdict: "ATTESTED";      artifact: string; trusts: string; because: Binding }
  | { verdict: "UNPROTECTABLE"; rejected: { artifact: string; reason: Reason }[] };

// ---- PROTECT ----------------------------------------------------------------

export type Dimension = "SUBJECT" | "PROPERTY" | "THRESHOLD" | "FRAME" | "ISSUER" | "SOURCE";

export type Manifest =
  | { status: "PROTECTED"; claims: {
        claim: Claim;
        threshold: Sourced<number>;
        issuer: Sourced<string>;
        finding: Finding;
      }[] }
  | { status: "REFUSED"; requirement: string; missing: { dimension: Dimension; why: string }[] };
```

`Sourced<T>` is invariant 9 made structural rather than aspirational. There is no constructor
that takes a bare `T`. A classifier can select a span; it cannot author a number. If it
cannot point at characters in the requirement, in the offer, or at a named policy field, the
field does not exist and the manifest abstains.

---

## 3. The matching rule

```
match(claim, artifact):

  1. SUBJECT
     effective = artifact.measured?.effectiveSubject ?? artifact.subject
     if artifact.subject !== claim.subject          -> SUBJECT_MISMATCH
     if effective        !== artifact.subject       -> SUBJECT_COLLAPSE
     if effective        !== claim.subject          -> SUBJECT_MISMATCH

  2. PROPERTY
     if artifact.measured?.refutedBy                -> PROPERTY_REFUTED
     if artifact.property === "JUDGMENT"            -> PROPERTY_NOT_COMPARABLE
     if artifact.property !== claim.property        -> PROPERTY_MISMATCH

  3. ATTESTATION
     if attestation.kind === "UNSIGNED"             -> ISSUER_UNSIGNED
     if issuer === terms.seller                     -> ISSUER_IS_OBLIGOR
     if claim.permittedIssuer && issuer !== it      -> ISSUER_NOT_PERMITTED

  4. BINDING
     PREIMAGE         -> ENFORCEABLE, settlesBy = subject === "RECORD"
                                        ? "COUNTEREXAMPLE" : "DIRECT_EVALUATION"
     ADJACENT | NONE  -> ATTESTED, trusts = issuer, because = binding

  no artifact reaches gate 4  -> UNPROTECTABLE, every rejection listed
  no artifact offered at all  -> NO_ARTIFACT_OFFERED
```

Nine reasons. That is the complete list.

**`PROPERTY_REFUTED` takes precedence over `PROPERTY_NOT_COMPARABLE`.** A field can be both a
judgment and demonstrably wrong. When a `Resolution` carries a `refutedBy`, the observed
counterexample is the headline, because "this flag read false on a record that was 95 minutes
old" defeats the field for any reader, while "a boolean is not a quantity" only defeats it for
a reader who already accepts the type discipline. Without a `refutedBy` the judgment argument
still stands on its own and `PROPERTY_NOT_COMPARABLE` fires.

**`SUBJECT_MISMATCH` is parameterised by `found`** so that the transaction case and the
response case render as different sentences from one code. They are the same defect
discovered the same way, by reading a schema, and a code per `Subject` value would grow with
`Subject`.

**`SUBJECT_COLLAPSE` cannot be reached by inspection.** It requires a `Resolution`, and a
`Resolution` requires that somebody actually called the endpoint enough times.

**`ENFORCEABLE` with `settlesBy: "DIRECT_EVALUATION"` is currently unreachable.** It would
need an artifact whose subject is the response and whose binding is a preimage over the
delivered bytes. Nothing today has that shape. The slot is left open rather than filled.

**`Binding: "NONE"` has no fixture.** It is retained for an assertion delivered entirely out
of band, such as a vendor's published service level page, which has no association with any
particular payload. Nothing in the frozen fixture set reaches it.

---

## 4. Fixtures

Recorded observations from AIsa's production API on 2026-08-22 between 01:03:30Z and
01:51:22Z. **These are fixtures. They are never re-fetched at run time.** The demo therefore
cannot fail on a network call and cannot silently change underneath a rehearsed pitch. They
are not a corpus, not an eval harness and nothing depends on them growing.

```ts
/** accounts.upstream in agent/src/chain.ts: the address the escrow itself checks. */
const PERMITTED_ISSUER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

const X402_RECEIPT: Artifact = {
  id: "x402-receipt",
  origin: "x402 Offer & Receipt extension, EIP-712 Receipt schema, specs/extensions/extension-offer-and-receipt.md",
  commitsTo: ["version", "network", "resourceUrl", "payer", "issuedAt", "transaction"],
  subject: "TRANSACTION",
  property: "OBSERVATION_TIME",
  binding: "PREIMAGE",
  attestation: { kind: "SIGNED", issuer: "resource server", scheme: "EIP712" },
};

const LAST_UPDATED: Artifact = {
  id: "coingecko-markets-last_updated",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/markets?vs_currency=usd&per_page=100",
  commitsTo: ["last_updated"],
  subject: "RECORD",
  property: "OBSERVATION_TIME",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "4 calls, 400 records, 2026-08-22T01:03:30Z to 01:51:22Z, identical 100-coin basket",
    maxDistinctPerResponse: 1,
    effectiveSubject: "RESPONSE",
  },
};

const IS_STALE: Artifact = {
  id: "coingecko-tickers-is_stale",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/bitcoin/tickers",
  commitsTo: ["is_stale"],
  subject: "RECORD",
  property: "JUDGMENT",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "4 calls, 400 records, 2026-08-22T01:04:50Z to 01:51:22Z",
    maxDistinctPerResponse: 1,          // uniformly false. see 1.2: does not collapse a boolean.
    effectiveSubject: "RECORD",
    refutedBy: {
      record: "GMO Coin Japan, BTC/JPY, call of 2026-08-22T01:36:21Z",
      asserted: "is_stale = false",
      actual: "last_traded_at 2026-08-21T23:59:48+00:00 against last_fetch_at 2026-08-22T01:34:40+00:00, 5692 seconds",
    },
  },
};

const LAST_TRADED_AT: Artifact = {
  id: "coingecko-tickers-last_traded_at",
  origin: "GET https://api.aisa.one/apis/v1/coingecko/coins/bitcoin/tickers",
  commitsTo: ["last_traded_at", "timestamp"],
  subject: "RECORD",
  property: "GENERATION_TIME",
  binding: "ADJACENT",
  attestation: { kind: "UNSIGNED" },
  measured: {
    method: "3 calls, 300 records, 2026-08-22T01:21:19Z to 01:51:22Z",
    maxDistinctPerResponse: 25,         // 23, 25, 24 across the three calls
    effectiveSubject: "RECORD",
  },
};

/** No Resolution: index enters the leaf preimage, so per-record scope is structural. */
const RECOURSE_COMMITMENT: Artifact = {
  id: "recourse-delivery-commitment",
  origin: "RecourseEscrow.submitDeliveryCommitment, contracts/src/RecourseEscrow.sol",
  commitsTo: ["specHash", "conditionId", "merkleRoot", "leafCount", "sourceId", "payloadRef"],
  subject: "RECORD",
  property: "GENERATION_TIME",
  binding: "PREIMAGE",
  attestation: { kind: "SIGNED", issuer: PERMITTED_ISSUER, scheme: "EIP712" },
};
```

Leaf construction, unchanged from `spec/SPEC.md` section 5:

```
leaf = keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))
```

---

## 5. The five fixtures against one claim

```
quote:    "every record generated within the last 60 seconds"
subject:  RECORD
property: GENERATION_TIME
test:     { op: "AT_OR_AFTER", seconds: 60, frame: { kind: "AGREEMENT_TIME" } }
```

| # | Artifact | subject decl / obs | property | binding | attestation | verdict | reason |
|---|---|---|---|---|---|---|---|
| 1 | x402 payment receipt | TRANSACTION / not measured | OBSERVATION_TIME | PREIMAGE | SIGNED EIP712 | UNPROTECTABLE | `SUBJECT_MISMATCH` needs RECORD, found TRANSACTION |
| 2 | `last_updated` | RECORD / **RESPONSE** | OBSERVATION_TIME | ADJACENT | UNSIGNED | UNPROTECTABLE | `SUBJECT_COLLAPSE` declared RECORD, effective RESPONSE |
| 3 | `is_stale` | RECORD / RECORD | **JUDGMENT** | ADJACENT | UNSIGNED | UNPROTECTABLE | `PROPERTY_REFUTED` false on a 5692 second old record |
| 4 | `last_traded_at` | RECORD / RECORD | GENERATION_TIME | ADJACENT | **UNSIGNED** | UNPROTECTABLE | `ISSUER_UNSIGNED` |
| 5 | Recourse delivery commitment | RECORD / structural | GENERATION_TIME | **PREIMAGE** | SIGNED EIP712, permitted issuer | **ENFORCEABLE** | settles by counterexample |

Rendered sentences, which is what goes on the surface:

1. Commits to `version`, `network`, `resourceUrl`, `payer`, `issuedAt` and `transaction`.
   Every one of those is a fact about the payment. None is a fact about a record. The
   extension offers itself as dispute evidence and cannot support a dispute about content.
2. A per-item field carrying a per-batch value. Four calls, 400 records, one distinct value
   every time, spread 0.0 seconds. The table is rebuilt every 14 to 16 minutes and every row
   is stamped with the build instant, so no record can be distinguished from any other.
3. Read false on a record whose last trade was 95 minutes before the response was assembled.
   It is a verdict rather than a measurement, so there is no quantity to compare against 60
   seconds, and the verdict is wrong.
4. The right property, at the right scope, genuinely varying: 23 to 25 distinct values per
   response. Nobody signs it. It arrives as JSON over TLS and any party that handles the
   payload can change it without leaving a trace.
5. `keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))`, inside a
   Merkle tree whose root the permitted issuer signed against this purchase. One violating
   record refunds in full.

### 5.1 Gate occupancy

The X-Ray layout depends on this distribution and it is load-bearing, not incidental.

| Gate | Lanes terminating here |
|---|---|
| 1 Subject | **lanes 1 and 2** |
| 2 Property | lane 3 |
| 3 Attestation | lane 4 |
| 4 Binding | lane 5, passing |

**Lanes 1 and 2 both terminate at gate 1.** Gate 1 is the only gate carrying two lanes, and
they carry different codes: lane 1 is refuted by reading the schema, lane 2 only by
measurement. Any layout that assumes one lane per gate is wrong. Any layout that renders
gate 1 as a single outcome erases the distinction between a defect you can read and a defect
you have to measure, which is the most valuable thing on the page.

### 5.2 Reachability of the remaining codes

Artifacts already in the repository or in the same measured dataset, so that no code in the
vocabulary is dead.

| Artifact | Claim | verdict | reason |
|---|---|---|---|
| Signed blob timestamp, `agent/src/seller.ts` | `the delivered file's records were generated within the last 60 seconds`, subject RESPONSE | UNPROTECTABLE | `PROPERTY_MISMATCH` needs GENERATION_TIME, found EXISTENCE_TIME |
| `is_anomaly`, same tickers endpoint | the freshness claim above | UNPROTECTABLE | `PROPERTY_NOT_COMPARABLE` found JUDGMENT |
| `leafCount` in the signed DeliveryCommitment | `at least 500 records`, subject RESPONSE, CARDINALITY | **ATTESTED** | binding ADJACENT, trusts `permittedIssuer` |
| DeliveryCommitment signed by a key the terms do not name | the freshness claim above | UNPROTECTABLE | `ISSUER_NOT_PERMITTED` |
| DeliveryCommitment signed by the seller | the freshness claim above | UNPROTECTABLE | `ISSUER_IS_OBLIGOR` |

`is_anomaly` is the precedence witness. It is the same shape as `is_stale`, from the same
endpoint, uniformly false across the same 400 records. It has no `refutedBy`, because no
observed record was demonstrably anomalous, so it falls to `PROPERTY_NOT_COMPARABLE` while
`is_stale` falls to `PROPERTY_REFUTED`.

The `leafCount` row is the continuity check. Today's surface already renders that condition
as "Issuer attested" with the caveat that it does not establish the tree holds that many
leaves. The model reproduces the existing product's own honesty without being told to.

---

## 6. Property maps onto the frozen ClaimType

No new opcodes. No new claim types. The opcode set is still exactly `UINT_GTE`, `UINT_EQ`,
`TIMESTAMP_GTE`, `BYTES32_EQ`.

| Property | ClaimType | settleable |
|---|---|---|
| GENERATION_TIME | `RECORD_GENERATION_TIME` | yes, by counterexample |
| CARDINALITY | `ROW_COUNT` | yes, by direct evaluation |
| EXISTENCE_TIME | `BLOB_EXISTENCE_TIME` | nameable, the contract refuses it |
| CONTENT_DIGEST | `SCHEMA_HASH` | nameable, cut, the contract refuses it |
| OBSERVATION_TIME | none | INSPECT only |
| JUDGMENT | none | INSPECT only |

INSPECT names more than ENFORCE settles. The two properties it names extra can never reach
Solidity, because they map to no `ClaimType` and therefore cannot be encoded into a
`Condition`.

---

## 7. PROTECT refusal vocabulary

A requirement that cannot be compiled produces `REFUSED` with a `missing` list. It never
produces a guess. `REFUSED` is a normal outcome, like `UNPROTECTABLE`.

| Dimension | Missing when | Example requirement |
|---|---|---|
| `SUBJECT` | the requirement does not say whether it binds each record or the delivery | `the data must be fresh` |
| `PROPERTY` | no observable is named | `high quality investment reports` |
| `THRESHOLD` | a comparison is implied but no value appears as a substring | `records should be recent` |
| `FRAME` | a relative threshold with no clock the buyer controls | `within 60 seconds of delivery` |
| `ISSUER` | no permitted attesting key, and no policy field supplies one | any claim with no `permittedIssuer` |
| `SOURCE` | no semantic origin to compare `sourceId` against | any claim with no `expectedSourceId` |

### 7.1 `FRAME: ARTIFACT_FIELD` is refused unconditionally

A relative threshold must resolve against a clock the obligor does not control: agreement
time, frozen into the signed terms at signature, or chain time. Never a field in the
delivery.

The justification is measured, not theoretical. On `/coingecko/coins/bitcoin/tickers`,
`last_fetch_at` is the only response-level clock in the payload and it drifted 10, 149, 101
and 102 seconds behind the request across four calls, every one served with
`cf-cache-status: EXPIRED`. An age computed as `last_fetch_at - last_traded_at` therefore
changed sign on 93 of 100 records in one call and 22 of 100 in another. The same underlying
data evaluates differently on two calls. A threshold resolved against a seller-supplied clock
is not a threshold.

This is why the existing compiler in `agent/src/compiler.ts` resolves `ctx.now - N` at
compile time and freezes the absolute instant into the signed `PurchaseTerms`. That was
already correct. This section records why.

---

## 8. What this model does not do

It does not rank artifacts by trustworthiness. There is no score.

It does not compose two artifacts into one stronger claim. A signed receipt plus an unsigned
timestamp is not a signed timestamp.

It has no partial credit. An artifact either reaches gate 4 or it does not.

It does not model a page. A paginated response has a level between the record and the
dataset, and a claim about "this page" behaves like `RESPONSE` while a claim about "the
dataset" does not. `Subject` is deliberately three-valued. Adding a fourth is much cheaper
before the manifest shape ships than after, and it has not been needed yet.
