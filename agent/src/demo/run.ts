import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  keccak256,
  pad,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  accounts,
  advanceTime,
  chainNow,
  deploy,
  escrowArtifact,
  publicClient,
  usdcArtifact,
  walletFor,
} from "../chain.js";
import { compileListing, supportedRuleIds } from "../compiler.js";
import { PROTECTED_PRICE_MICROS } from "../fixtures/offers.js";
import { commitmentMessage, deliveryCommitmentTypes, domainFor, purchaseTermsTypes, termsMessage } from "../eip712.js";
import { naiveAcceptanceChecks } from "../naive.js";
import { SOURCE_ID, assembleFile, buildDelivery, commitTo, partiallyStale, payloadRefOf } from "../seller.js";
import {
  ClaimType,
  claimTypeName,
  opcodeName,
  type Condition,
  type DeliveryCommitment,
  Quantifier,
  type EvidenceOffer,
  type PurchaseTerms,
} from "../types.js";
import {
  buildBreachProof,
  countViolations,
  evaluateScalar,
  findFirstViolation,
  proofChecksOut,
} from "../verifier.js";

const ESCROW_ABI = escrowArtifact().abi as Abi;
const USDC_ABI = usdcArtifact().abi as Abi;

const AMOUNT = BigInt(PROTECTED_PRICE_MICROS); // the selected offer's price; USDC has 6 decimals
const RECORD_COUNT = 500;
const CHALLENGE_WINDOW = 30n;
const CURE_PERIOD = 20n;
const FRESH_BY = 20n; // inside a 60 second window
const STALE_BY = 26n * 3600n; // yesterday's data
const STALE_ONSET = 187; // the feed goes stale partway through the collection run
/** Scenarios 1 and 2 are the same delivery, so they share one age policy. */
const MIXED_AGES = partiallyStale(FRESH_BY, STALE_BY, STALE_ONSET);
const DELIVERY_GRACE = 600n; // seconds the seller has to commit
const FRESHNESS_TERM = "every record generated within the last 60 seconds";
const ROW_COUNT_TERM = "at least 500 records";

let usdc: Address;
let escrow: Address;
let chainId: number;

// ------------------------------------------------------------------ output

const W = 74;
const rule = (ch = "-") => console.log(ch.repeat(W));
const section = (title: string) => {
  console.log("");
  rule("=");
  console.log(title);
  rule("=");
};
const step = (s: string) => console.log(`\n  ${s}`);
const item = (ok: boolean | null, s: string) =>
  console.log(`    ${ok === null ? "-" : ok ? "PASS" : "FAIL"}  ${s}`);
const note = (s: string) => console.log(`      ${s}`);
const verdict = (n: number, name: string, detail: string) => {
  console.log("");
  console.log(`SCENARIO ${n} VERDICT: ${name}  |  ${detail}`);
  rule();
};

const usd = (v: bigint) => `${(Number(v) / 1e6).toFixed(2)} USDC`;
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
const dur = (s: bigint) => `${(Number(s) / 3600).toFixed(1)}h`;
const age = (s: bigint) => (s < 3600n ? `${s}s` : dur(s));

// ------------------------------------------------------------------ chain helpers

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "revert";
  }
  return (e as Error)?.message?.split("\n")[0] ?? "revert";
}

async function send(
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  account: PrivateKeyAccount,
) {
  const { request } = await publicClient.simulateContract({
    address,
    abi,
    functionName,
    args,
    account,
  });
  const hash = await walletFor(account).writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}

async function expectRevert(
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  account: PrivateKeyAccount,
): Promise<string> {
  try {
    await publicClient.simulateContract({ address, abi, functionName, args, account });
  } catch (e) {
    return revertName(e);
  }
  throw new Error(`${functionName} was expected to revert and did not`);
}

const read = (functionName: string, args: unknown[]) =>
  publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName, args });

const balance = (who: Address) =>
  publicClient.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

// ------------------------------------------------------------------ purchase plumbing

async function signTerms(terms: PurchaseTerms, account: PrivateKeyAccount): Promise<Hex> {
  return account.signTypedData({
    domain: domainFor(chainId, escrow),
    types: purchaseTermsTypes,
    primaryType: "PurchaseTerms",
    message: termsMessage(terms) as never,
  });
}

async function signCommitment(c: DeliveryCommitment, account: PrivateKeyAccount): Promise<Hex> {
  return account.signTypedData({
    domain: domainFor(chainId, escrow),
    types: deliveryCommitmentTypes,
    primaryType: "DeliveryCommitment",
    message: commitmentMessage(c) as never,
  });
}

function makeTerms(purchaseId: Hex, conditions: Condition[], deliveryDeadline: bigint): PurchaseTerms {
  return {
    purchaseId,
    buyer: accounts.buyer.address,
    seller: accounts.seller.address,
    amount: AMOUNT,
    asset: usdc,
    conditions,
    challengeWindow: CHALLENGE_WINDOW,
    deliveryDeadline,
    curePeriod: CURE_PERIOD,
  };
}

const offersFor = (conditions: Condition[]): EvidenceOffer[] =>
  conditions.map((c) => ({ conditionId: c.conditionId, establishes: c.requires, issuer: c.permittedIssuer }));

/** Compile a listing, requiring every phrase to be protectable. */
function compileProtected(phrases: string[], now: bigint): Condition[] {
  return compileListing(phrases, {
    now,
    permittedIssuer: accounts.upstream.address,
    expectedSourceId: SOURCE_ID,
  }).map((c) => {
    if (!c.protectable) throw new Error(`expected a protectable term: ${c.phrase}`);
    return c.condition;
  });
}

async function commitAll(terms: PurchaseTerms, specHash: Hex, root: Hex, leafCount: bigint, payloadRef: Hex) {
  for (let i = 0; i < terms.conditions.length; i++) {
    const commitment: DeliveryCommitment = {
      specHash,
      conditionId: terms.conditions[i].conditionId,
      merkleRoot: root,
      leafCount,
      sourceId: SOURCE_ID,
      payloadRef,
    };
    await send(
      escrow,
      ESCROW_ABI,
      "submitDeliveryCommitment",
      [terms, BigInt(i), commitment, await signCommitment(commitment, accounts.upstream)],
      accounts.seller,
    );
  }
}

function describeCondition(c: Condition) {
  const universal = c.quantifier === Quantifier.UNIVERSAL;
  const threshold = universal
    ? `${BigInt(c.threshold)} (${iso(BigInt(c.threshold))})`
    : `${BigInt(c.threshold)}`;
  note(`condition ${c.conditionId}      "${c.sourceQuote}"`);
  note(`  requires       ${claimTypeName(c.requires)}`);
  note(
    `  quantifier     ${universal ? "UNIVERSAL, settles by counterexample" : "SCALAR, settles by direct evaluation"}`,
  );
  note(`  opcode         ${opcodeName(c.opcode)}  threshold ${threshold}`);
  note(`  permittedIssuer ${c.permittedIssuer}`);
}

// ------------------------------------------------------------------ 1. UNPROTECTED

async function scenarioUnprotected() {
  section("SCENARIO 1 of 6   UNPROTECTED PURCHASE, TODAY'S NORMAL");
  const now = await chainNow();

  step(`Seller assembles ${RECORD_COUNT} correctly shaped ETH-USD records into one file.`);
  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const delivery = await assembleFile(records, accounts.timestampAuthority, now);
  note(`file hash        ${delivery.blobHash.slice(0, 26)}...`);
  note(`blob timestamp   ${iso(delivery.blobTimestamp.timestampedAt)}`);
  note(`countersigned by ${accounts.timestampAuthority.address}`);
  note(`an independent timestamping service, signing honestly, with nothing to gain.`);
  note(`this is a signed blob timestamp, not RFC-3161, and it covers the file only.`);

  step("Buyer agent runs the checks an unprotected agent actually runs.");
  const checks = await naiveAcceptanceChecks(
    delivery,
    RECORD_COUNT,
    accounts.timestampAuthority.address,
    3600n,
    now,
  );
  for (const c of checks) item(c.passed, `${c.name}: ${c.detail}`);
  const allPass = checks.every((c) => c.passed);

  step("Every check passed, so the agent pays.");
  const before = await balance(accounts.seller.address);
  await send(usdc, USDC_ABI, "transfer", [accounts.seller.address, AMOUNT], accounts.buyer);
  const after = await balance(accounts.seller.address);
  item(true, `paid ${usd(after - before)} directly to the seller, final and irreversible`);

  step("Now look at the per-record generation timestamps nobody checked.");
  const ages = records.map((r) => now - r.generatedAt);
  const oldest = ages.reduce((a, b) => (b > a ? b : a), 0n);
  const newest = ages.reduce((a, b) => (b < a ? b : a), ages[0]);
  const staleCount = ages.filter((a) => a > 3600n).length;
  const firstStale = ages.findIndex((a) => a > 3600n);
  for (const i of [0, firstStale - 1, firstStale, RECORD_COUNT - 1]) {
    note(`record ${String(i).padStart(3)}  generatedAt ${iso(records[i].generatedAt)}  age ${age(ages[i])}`);
  }
  note(`ages range from ${age(newest)} to ${age(oldest)}`);
  note(`the first ${firstStale} records are current, so the head of the file looks clean`);
  item(false, `${staleCount} of ${RECORD_COUNT} records predate the one hour window by more than 20 hours`);
  note(`the file is new. half the data in it is yesterday's. the timestamp is honest.`);
  note(`blob existence time is not record generation time. that gap is the whole attack.`);

  verdict(
    1,
    "UNPROTECTED",
    `naive checks all ${allPass ? "passed" : "failed"}, ${usd(AMOUNT)} settled, ` +
      `${staleCount} of ${RECORD_COUNT} records up to ${dur(oldest)} stale`,
  );
}

// ------------------------------------------------------------------ 2. BREACH_PROVED

async function scenarioBreachProved() {
  section("SCENARIO 2 of 6   THE SAME DELIVERY THROUGH RECOURSE");
  const now = await chainNow();

  step("Compile the listing terms into machine-checkable conditions.");
  const compiledAll = compileListing([FRESHNESS_TERM, ROW_COUNT_TERM], {
    now,
    permittedIssuer: accounts.upstream.address,
    expectedSourceId: SOURCE_ID,
  });
  for (const c of compiledAll) {
    item(c.protectable, c.protectable ? `rule ${c.ruleId} matched` : `UNPROTECTABLE: ${c.phrase}`);
  }
  const conditions = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  for (const c of conditions) describeCondition(c);
  note(`row count is protected, not unprotectable: it settles by direct evaluation`);

  const deadline = now + DELIVERY_GRACE;
  const terms = makeTerms(pad("0x01", { size: 32 }), conditions, deadline);
  const specHash = (await read("specHashOf", [terms])) as Hex;
  const buyerSig = await signTerms(terms, accounts.buyer);
  const sellerSig = await signTerms(terms, accounts.seller);
  note(`specHash         ${specHash}`);
  note(`deliveryDeadline ${iso(deadline)}, bound into the signed terms`);

  step("Seller offers its evidence. Screening happens before any money moves.");
  const blobOffer = offersFor(conditions);
  blobOffer[0] = { ...blobOffer[0], establishes: ClaimType.BLOB_EXISTENCE_TIME };
  const err = await expectRevert(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, blobOffer, buyerSig, sellerSig],
    accounts.seller,
  );
  item(true, `offer of BLOB_EXISTENCE_TIME rejected with ${err}`);
  note(`authentic evidence for the wrong claim. no escrow opened, nothing paid.`);

  await send(escrow, ESCROW_ABI, "openPurchase", [terms, offersFor(conditions), buyerSig, sellerSig], accounts.seller);
  item(true, `re-offer of RECORD_GENERATION_TIME accepted, ${usd(await balance(escrow))} escrowed`);

  step("Seller delivers. The upstream issuer signs a commitment over bound leaves.");
  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const tree = commitTo(records);
  note(`merkleRoot       ${tree.root}`);
  note(`leafCount        ${tree.leafCount}, inside the signed struct`);
  note(`leaf = keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))`);
  await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRefOf(records));
  item(true, `${conditions.length} commitments stored, challenge window open`);

  step("Buyer's verifier scans the delivery locally. No model call, no chain reads.");
  const scalar = evaluateScalar(conditions[1], tree.leafCount);
  item(scalar.holds, `scalar row count: ${tree.leafCount} rows against a threshold of 500, holds`);
  const total = countViolations(records, conditions[0]);
  const violation = findFirstViolation(records, conditions[0]);
  if (!violation) throw new Error("expected a violation");
  item(false, `universal freshness: ${total} of ${RECORD_COUNT} records violate it`);
  note(`first violating record is index ${violation.record.index}, not index 0`);
  note(`records 0 to ${violation.record.index - 1} are inside the window, so a spot`);
  note(`check of the head of the file finds nothing wrong`);
  note(`generatedAt ${iso(violation.record.generatedAt)}, threshold ${iso(BigInt(conditions[0].threshold))}`);
  note(`short by ${dur(BigInt(conditions[0].threshold) - violation.record.generatedAt)}`);

  step("One counterexample is submitted. A universal claim needs no more.");
  const proof = buildBreachProof(specHash, conditions[0], tree.levels, violation.record);
  item(proofChecksOut(proof, tree.root), `merklePath has ${proof.merklePath.length} siblings, verified locally first`);

  const buyerBefore = await balance(accounts.buyer.address);
  const receipt = await send(escrow, ESCROW_ABI, "submitBreachProof", [terms, 0n, proof], accounts.buyer);
  const buyerAfter = await balance(accounts.buyer.address);

  step("The contract checked, in order:");
  for (const line of [
    "leaf reconstructed from index, keccak256(recordBytes), generatedAt, sourceId",
    "inclusion against the root inside the stored signed DeliveryCommitment",
    "the leaf index sits inside the signed leafCount",
    "that commitment binds this specHash and this conditionId",
    "recovered commitment signer equals condition.permittedIssuer",
    "leaf sourceId equals condition.expectedSourceId",
    "the claim is one a commitment over bound leaves can establish",
    "the predicate is VIOLATED, not merely evaluated",
  ]) {
    item(true, line);
  }

  let offending: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
      if (parsed.eventName === "BreachProved") {
        offending = (parsed.args as unknown as { offendingIndex: bigint }).offendingIndex;
      }
    } catch {
      /* not ours */
    }
  }
  item(true, `refunded ${usd(buyerAfter - buyerBefore)} to the buyer, escrow holds ${usd(await balance(escrow))}`);
  item(true, `emitted BreachProved with offendingIndex ${offending}, 1 of ${total} violating records`);
  note(`the other ${total - 1} counterexamples were never needed and never submitted`);

  verdict(
    2,
    "BREACH_PROVED",
    `${total} of ${RECORD_COUNT} records violate, one counterexample at index ${offending} refunded in full`,
  );
}

// ------------------------------------------------------------------ 3. RELEASE

async function scenarioRelease() {
  section("SCENARIO 3 of 6   COMPLIANT DELIVERY, NOBODY CHALLENGES");
  const now = await chainNow();

  const conditions = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const terms = makeTerms(pad("0x02", { size: 32 }), conditions, now + DELIVERY_GRACE);
  const specHash = (await read("specHashOf", [terms])) as Hex;
  const buyerSig = await signTerms(terms, accounts.buyer);
  const sellerSig = await signTerms(terms, accounts.seller);

  step("Same two conditions, a different purchase, and this time the data is fresh.");
  await send(escrow, ESCROW_ABI, "openPurchase", [terms, offersFor(conditions), buyerSig, sellerSig], accounts.seller);
  item(true, `purchase ${specHash.slice(0, 18)}... opened, ${usd(AMOUNT)} escrowed`);

  const records = buildDelivery(RECORD_COUNT, now, 20n);
  const tree = commitTo(records);
  await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRefOf(records));
  item(true, `all ${RECORD_COUNT} records generated 2 minutes ago, leafCount ${tree.leafCount} committed`);

  step("Buyer's verifier scans every record and finds nothing to challenge.");
  item(true, `${countViolations(records, conditions[0])} freshness violations in ${RECORD_COUNT} records`);
  item(findFirstViolation(records, conditions[0]) === null, "no counterexample exists, so none is submitted");

  step("Settlement is optimistic. Silence during the window means release.");
  const early = await expectRevert(escrow, ESCROW_ABI, "release", [terms], accounts.seller);
  item(true, `release before the window expires reverts with ${early}`);
  await advanceTime(Number(CHALLENGE_WINDOW) + 1);
  const before = await balance(accounts.seller.address);
  await send(escrow, ESCROW_ABI, "release", [terms], accounts.seller);
  const after = await balance(accounts.seller.address);
  item(true, `scalar row count evaluated at release: ${tree.leafCount} >= 500, satisfied`);
  item(true, `challenge window of ${CHALLENGE_WINDOW}s expired, ${usd(after - before)} released to the seller`);

  verdict(3, "RELEASE", `no valid proof, scalar claims satisfied, funds to seller`);
}

// ------------------------------------------------------------------ 4. UNPROTECTABLE

async function scenarioUnprotectable() {
  section("SCENARIO 4 of 6   A TERM THAT MAPS TO NO SUPPORTED CONDITION");
  const now = await chainNow();

  const listing = "high quality investment reports";
  step(`Listing term: "${listing}"`);
  note(`supported rules: ${supportedRuleIds().join(", ")}`);
  note(`opcode set: UINT_GTE, UINT_EQ, TIMESTAMP_GTE, BYTES32_EQ, and it never grows`);

  const compiled = compileListing([listing], {
    now,
    permittedIssuer: accounts.upstream.address,
    expectedSourceId: SOURCE_ID,
  })[0];

  step("Compilation result.");
  item(false, `not protectable: ${compiled.protectable ? "" : compiled.reason}`);
  note(`"high quality" is not objectively falsifiable, so no counterexample can exist`);
  note(`we do not stretch an opcode to cover it and we do not call a model to judge it`);

  step("Consequence.");
  const escrowBefore = await balance(escrow);
  item(true, "no PurchaseTerms are built, so nothing is signed");
  item(true, "no protected payment opens");
  note(`escrow balance unchanged at ${usd(escrowBefore)}`);
  note(`the buyer may still transact unprotected. it just knows that it is unprotected.`);

  verdict(4, "UNPROTECTABLE", "no supported condition expresses the term, no escrow opened");
}

// ------------------------------------------------------------------ 5. STALLED

async function scenarioStalled() {
  section("SCENARIO 5 of 6   THE SELLER TAKES THE MONEY AND STALLS");
  const now = await chainNow();

  const conditions = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const deadline = now + 20n;
  const terms = makeTerms(pad("0x03", { size: 32 }), conditions, deadline);
  const specHash = (await read("specHashOf", [terms])) as Hex;

  step("A normal protected purchase opens.");
  await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), await signTerms(terms, accounts.buyer), await signTerms(terms, accounts.seller)],
    accounts.seller,
  );
  item(true, `${usd(await balance(escrow))} escrowed, deliveryDeadline ${iso(deadline)}`);

  step("The seller then does nothing at all. No delivery commitment is ever submitted.");
  const p0 = (await read("purchaseOf", [specHash])) as { state: number; committedCount: number; conditionCount: number };
  item(true, `state OPEN, ${p0.committedCount} of ${p0.conditionCount} conditions committed`);
  note(`with no commitment there is no root, so no counterexample can be built`);
  note(`and release requires DELIVERED, so silence would strand the buyer's funds`);

  const early = await expectRevert(escrow, ESCROW_ABI, "reclaim", [terms], accounts.buyer);
  item(true, `reclaim before the deadline reverts with ${early}`);

  step("Past the deadline the buyer takes its money back. Non-delivery is the trivial breach.");
  await advanceTime(21);
  const before = await balance(accounts.buyer.address);
  await send(escrow, ESCROW_ABI, "reclaim", [terms], accounts.buyer);
  const after = await balance(accounts.buyer.address);
  const p1 = (await read("purchaseOf", [specHash])) as { state: number };
  item(true, `refunded ${usd(after - before)} in full, escrow holds ${usd(await balance(escrow))}`);
  item(p1.state === 5, `state RECLAIMED, and a second reclaim would revert`);
  note(`a partial delivery reclaims the same way: the purchase only leaves OPEN`);
  note(`once every condition has a stored commitment`);

  verdict(5, "STALLED", `delivery deadline passed with 0 of 2 commitments, buyer reclaimed in full`);
}

// ------------------------------------------------------------------ 6. WITHHELD

async function scenarioWithheld() {
  section("SCENARIO 6 of 6   THE SELLER COMMITS A ROOT AND SENDS NOTHING");
  const now = await chainNow();

  const conditions = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const terms = makeTerms(pad("0x04", { size: 32 }), conditions, now + DELIVERY_GRACE);
  const specHash = (await read("specHashOf", [terms])) as Hex;

  step("A normal protected purchase opens and the seller commits on chain.");
  await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), await signTerms(terms, accounts.buyer), await signTerms(terms, accounts.seller)],
    accounts.seller,
  );
  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const tree = commitTo(records);
  const payloadRef = payloadRefOf(records);
  await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRef);
  item(true, `commitments stored, purchase is DELIVERED, challenge window running`);
  note(`merkleRoot  ${tree.root.slice(0, 26)}...`);
  note(`payloadRef  ${payloadRef.slice(0, 26)}...  the content address the issuer signed`);

  step("The payload itself is never sent. The buyer has a root and nothing to open it with.");
  note(`a breach proof needs index, recordBytes, generatedAt and a merklePath`);
  note(`none of which are on chain. before this fix the seller simply waited.`);
  const reclaimErr = await expectRevert(escrow, ESCROW_ABI, "reclaim", [terms], accounts.buyer);
  item(true, `reclaim cannot help: it reverts with ${reclaimErr}, the commitment left OPEN`);

  step("The buyer contests availability, naming one leaf it cannot obtain.");
  const challengedIndex = 42n;
  await send(escrow, ESCROW_ABI, "raiseAvailabilityChallenge", [terms, 0n, challengedIndex], accounts.buyer);
  item(true, `challenge raised on leaf ${challengedIndex}, cure period ${CURE_PERIOD}s`);
  const releaseErr = await expectRevert(escrow, ESCROW_ABI, "release", [terms], accounts.seller);
  item(true, `release is now blocked: ${releaseErr}`);
  const earlyErr = await expectRevert(escrow, ESCROW_ABI, "claimWithheld", [terms], accounts.buyer);
  item(true, `claiming before the cure period reverts with ${earlyErr}`);

  step("The seller does not answer. It cannot open a leaf it never delivered.");
  await advanceTime(Number(CURE_PERIOD) + 1);
  const before = await balance(accounts.buyer.address);
  await send(escrow, ESCROW_ABI, "claimWithheld", [terms], accounts.buyer);
  const after = await balance(accounts.buyer.address);
  item(true, `refunded ${usd(after - before)} in full, escrow holds ${usd(await balance(escrow))}`);
  note(`answering would have handed the buyer the very bytes a counterexample needs,`);
  note(`so a seller holding bad records is caught either way.`);

  verdict(6, "WITHHELD", `commitment without delivery, cure period lapsed unanswered, buyer refunded`);
}

// ------------------------------------------------------------------ main

async function main() {
  chainId = await publicClient.getChainId();
  rule("=");
  console.log("RECOURSE  end to end demo against local anvil");
  rule("=");
  console.log(`  rpc        ${publicClient.transport.url}   chainId ${chainId}`);

  usdc = await deploy("MockUSDC");
  escrow = await deploy("RecourseEscrow");
  console.log(`  MockUSDC   ${usdc}`);
  console.log(`  Escrow     ${escrow}`);
  console.log(`  buyer      ${accounts.buyer.address}`);
  console.log(`  seller     ${accounts.seller.address}`);
  console.log(`  upstream   ${accounts.upstream.address}  (the source of record, still trusted)`);
  console.log(
    `  timestamp authority  ${accounts.timestampAuthority.address}  (blob timestamps, honest and irrelevant)`,
  );

  await send(usdc, USDC_ABI, "mint", [accounts.buyer.address, 10_000_000_000n], accounts.deployer);
  await send(usdc, USDC_ABI, "approve", [escrow, 2n ** 256n - 1n], accounts.buyer);

  await scenarioUnprotected();
  await scenarioBreachProved();
  await scenarioRelease();
  await scenarioUnprotectable();
  await scenarioStalled();
  await scenarioWithheld();

  section("SUMMARY");
  console.log("SCENARIO 1 VERDICT: UNPROTECTED");
  console.log("SCENARIO 2 VERDICT: BREACH_PROVED");
  console.log("SCENARIO 3 VERDICT: RELEASE");
  console.log("SCENARIO 4 VERDICT: UNPROTECTABLE");
  console.log("SCENARIO 5 VERDICT: STALLED");
  console.log("SCENARIO 6 VERDICT: WITHHELD");
  rule("=");
}

main().catch((e) => {
  console.error("\nDEMO FAILED");
  console.error(e);
  process.exit(1);
});
