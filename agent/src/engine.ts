import { decodeEventLog, pad, type Abi, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { BaseError, ContractFunctionRevertedError } from "viem";
import {
  accounts,
  advanceTime,
  chainNow,
  deploy,
  escrowArtifact,
  publicClient,
  usdcArtifact,
  walletFor,
} from "./chain.js";
import { compileListing, supportedRuleIds } from "./compiler.js";
import {
  commitmentMessage,
  deliveryCommitmentTypes,
  domainFor,
  purchaseTermsTypes,
  termsMessage,
} from "./eip712.js";
import { naiveAcceptanceChecks } from "./naive.js";
import { SOURCE_ID, assembleFile, buildDelivery, commitTo, partiallyStale, payloadRefOf } from "./seller.js";
import {
  ClaimType,
  Quantifier,
  claimTypeName,
  opcodeName,
  type Condition,
  type DeliveryCommitment,
  type EvidenceOffer,
  type PurchaseTerms,
} from "./types.js";
import {
  buildBreachProof,
  buildOpening,
  countViolations,
  evaluateScalar,
  findFirstViolation,
  proofChecksOut,
} from "./verifier.js";

// ------------------------------------------------------------------ constants

export const AMOUNT = 100_000_000n; // 100 USDC, 6 decimals
export const RECORD_COUNT = 500;
export const CHALLENGE_WINDOW = 30n;
export const CURE_PERIOD = 20n;
const FRESH_BY = 90n;
const STALE_BY = 26n * 3600n;
const STALE_ONSET = 187;
const MIXED_AGES = partiallyStale(FRESH_BY, STALE_BY, STALE_ONSET);
const DELIVERY_GRACE = 600n;
const FRESHNESS_TERM = "every record generated within the last 1 hour";
const ROW_COUNT_TERM = "at least 500 records";
const UNPROTECTABLE_TERM = "high quality investment reports";
const NAIVE_WINDOW = 3600n;

const ESCROW_ABI = escrowArtifact().abi as Abi;
const USDC_ABI = usdcArtifact().abi as Abi;

// ------------------------------------------------------------------ artifact shape

export type { Check, ConditionView, RunArtifact } from "./artifact.js";
import type { ConditionView, RunArtifact } from "./artifact.js";

// ------------------------------------------------------------------ helpers

let usdc: Address;
let escrow: Address;
let chainId: number;

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "revert";
  }
  return (e as Error)?.message?.split("\n")[0] ?? "revert";
}

async function send(address: Address, abi: Abi, fn: string, args: unknown[], account: PrivateKeyAccount) {
  const { request } = await publicClient.simulateContract({ address, abi, functionName: fn, args, account });
  const hash = await walletFor(account).writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}

async function expectRevert(
  address: Address,
  abi: Abi,
  fn: string,
  args: unknown[],
  account: PrivateKeyAccount,
): Promise<string> {
  try {
    await publicClient.simulateContract({ address, abi, functionName: fn, args, account });
  } catch (e) {
    return revertName(e);
  }
  throw new Error(`${fn} was expected to revert and did not`);
}

const read = (fn: string, args: unknown[]) =>
  publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: fn, args });

const balance = (who: Address) =>
  publicClient.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

const signTerms = (t: PurchaseTerms, a: PrivateKeyAccount) =>
  a.signTypedData({
    domain: domainFor(chainId, escrow),
    types: purchaseTermsTypes,
    primaryType: "PurchaseTerms",
    message: termsMessage(t) as never,
  });

const signCommitment = (c: DeliveryCommitment, a: PrivateKeyAccount) =>
  a.signTypedData({
    domain: domainFor(chainId, escrow),
    types: deliveryCommitmentTypes,
    primaryType: "DeliveryCommitment",
    message: commitmentMessage(c) as never,
  });

const offersFor = (cs: Condition[]): EvidenceOffer[] =>
  cs.map((c) => ({ conditionId: c.conditionId, establishes: c.requires, issuer: c.permittedIssuer }));

function compileProtected(phrases: string[], now: bigint) {
  return compileListing(phrases, {
    now,
    permittedIssuer: accounts.upstream.address,
    expectedSourceId: SOURCE_ID,
  }).map((c) => {
    if (!c.protectable) throw new Error(`expected a protectable term: ${c.phrase}`);
    return c;
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

async function commitAll(
  terms: PurchaseTerms,
  specHash: Hex,
  root: Hex,
  leafCount: bigint,
  payloadRef: Hex,
): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (let i = 0; i < terms.conditions.length; i++) {
    const commitment: DeliveryCommitment = {
      specHash,
      conditionId: terms.conditions[i].conditionId,
      merkleRoot: root,
      leafCount,
      sourceId: SOURCE_ID,
      payloadRef,
    };
    const receipt = await send(
      escrow,
      ESCROW_ABI,
      "submitDeliveryCommitment",
      [terms, BigInt(i), commitment, await signCommitment(commitment, accounts.upstream)],
      accounts.seller,
    );
    hashes.push(receipt.transactionHash);
  }
  return hashes;
}

function viewOf(c: Condition, ruleId: string): ConditionView {
  const universal = c.quantifier === Quantifier.UNIVERSAL;
  return {
    conditionId: c.conditionId,
    sourceQuote: c.sourceQuote,
    ruleId,
    claimType: claimTypeName(c.requires),
    quantifier: universal ? "UNIVERSAL" : "SCALAR",
    opcode: opcodeName(c.opcode),
    threshold: BigInt(c.threshold).toString(),
    thresholdKind: universal ? "timestamp" : "count",
    permittedIssuer: c.permittedIssuer,
    expectedSourceId: c.expectedSourceId,
    settlement: universal ? "one counterexample" : "direct evaluation at release",
    protectedByRule: true,
  };
}

// ------------------------------------------------------------------ the run

export async function runAll(): Promise<RunArtifact> {
  chainId = await publicClient.getChainId();
  usdc = await deploy("MockUSDC");
  escrow = await deploy("RecourseEscrow");

  await send(usdc, USDC_ABI, "mint", [accounts.buyer.address, 10_000_000_000n], accounts.deployer);
  await send(usdc, USDC_ABI, "approve", [escrow, 2n ** 256n - 1n], accounts.buyer);

  const unprotected = await runUnprotected();
  const protectedPurchase = await runProtected();
  const release = await runRelease();
  const unprotectable = runUnprotectable();
  const stalled = await runStalled();
  const withheld = await runWithheld();

  const block = await publicClient.getBlock();
  return {
    meta: {
      chainId,
      rpc: publicClient.transport.url as string,
      capturedAt: new Date().toISOString(),
      chainTime: block.timestamp.toString(),
      blockNumber: block.number.toString(),
      escrow,
      usdc,
      accounts: {
        buyer: accounts.buyer.address,
        seller: accounts.seller.address,
        upstream: accounts.upstream.address,
        timestampAuthority: accounts.timestampAuthority.address,
      },
      assetSymbol: "USDC",
      assetDecimals: 6,
    },
    unprotected,
    protectedPurchase,
    release,
    unprotectable,
    stalled,
    withheld,
  };
}

async function runUnprotected(): Promise<RunArtifact["unprotected"]> {
  const now = await chainNow();
  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const delivery = await assembleFile(records, accounts.timestampAuthority, now);

  const checks = await naiveAcceptanceChecks(
    delivery,
    RECORD_COUNT,
    accounts.timestampAuthority.address,
    NAIVE_WINDOW,
    now,
  );
  const receipt = await send(usdc, USDC_ABI, "transfer", [accounts.seller.address, AMOUNT], accounts.buyer);

  const ages = records.map((r) => now - r.generatedAt);
  const staleFlags = ages.map((a) => a > NAIVE_WINDOW);
  const firstStaleIndex = staleFlags.indexOf(true);
  const staleCount = staleFlags.filter(Boolean).length;
  const sampleIndexes = [0, firstStaleIndex - 1, firstStaleIndex, firstStaleIndex + 1, RECORD_COUNT - 1];

  return {
    recordCount: RECORD_COUNT,
    checks,
    allPassed: checks.every((c) => c.passed),
    payment: {
      amount: AMOUNT.toString(),
      to: accounts.seller.address,
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
    },
    blobTimestamp: {
      at: delivery.blobTimestamp.timestampedAt.toString(),
      issuer: delivery.blobTimestamp.issuer,
      blobHash: delivery.blobTimestamp.blobHash,
    },
    reveal: {
      windowSeconds: NAIVE_WINDOW.toString(),
      staleCount,
      freshCount: RECORD_COUNT - staleCount,
      firstStaleIndex,
      oldestAgeSeconds: ages.reduce((a, b) => (b > a ? b : a), 0n).toString(),
      newestAgeSeconds: ages.reduce((a, b) => (b < a ? b : a), ages[0]).toString(),
      samples: sampleIndexes.map((i) => ({
        index: i,
        generatedAt: records[i].generatedAt.toString(),
        ageSeconds: ages[i].toString(),
        stale: staleFlags[i],
      })),
    },
  };
}

async function runProtected(): Promise<RunArtifact["protectedPurchase"]> {
  const now = await chainNow();
  const compiled = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const conditions = compiled.map((c) => (c.protectable ? c.condition : (null as never)));
  const conditionViews = compiled.map((c) =>
    viewOf(c.protectable ? c.condition : (null as never), c.protectable ? c.ruleId : ""),
  );

  const deadline = now + DELIVERY_GRACE;
  const terms = makeTerms(pad("0x01", { size: 32 }), conditions, deadline);
  const specHash = (await read("specHashOf", [terms])) as Hex;
  const buyerSig = await signTerms(terms, accounts.buyer);
  const sellerSig = await signTerms(terms, accounts.seller);

  // The seller first offers a signed blob timestamp for a condition that needs
  // record generation time. Authentic evidence, wrong claim.
  const badOffer = offersFor(conditions);
  badOffer[0] = { ...badOffer[0], establishes: ClaimType.BLOB_EXISTENCE_TIME };
  const rejectError = await expectRevert(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, badOffer, buyerSig, sellerSig],
    accounts.seller,
  );
  const escrowAfterReject = await balance(escrow);

  const openReceipt = await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), buyerSig, sellerSig],
    accounts.seller,
  );

  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const tree = commitTo(records);
  const commitTxs = await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRefOf(records));

  const scalar = evaluateScalar(conditions[1], tree.leafCount);
  const violations = countViolations(records, conditions[0]);
  const violation = findFirstViolation(records, conditions[0]);
  if (!violation) throw new Error("expected a violation");

  const proof = buildBreachProof(specHash, conditions[0], tree.levels, violation.record);
  const verifiedLocally = proofChecksOut(proof, tree.root);

  const buyerBefore = await balance(accounts.buyer.address);
  const proofReceipt = await send(escrow, ESCROW_ABI, "submitBreachProof", [terms, 0n, proof], accounts.buyer);
  const buyerAfter = await balance(accounts.buyer.address);

  let offendingIndex = "";
  for (const log of proofReceipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
      if (parsed.eventName === "BreachProved") {
        offendingIndex = (parsed.args as unknown as { offendingIndex: bigint }).offendingIndex.toString();
      }
    } catch {
      /* not ours */
    }
  }

  const threshold = BigInt(conditions[0].threshold);
  return {
    specHash,
    amount: AMOUNT.toString(),
    challengeWindowSeconds: CHALLENGE_WINDOW.toString(),
    curePeriodSeconds: CURE_PERIOD.toString(),
    deliveryDeadline: deadline.toString(),
    conditions: conditionViews,
    rejectedOffer: {
      conditionId: conditions[0].conditionId,
      error: rejectError,
      offeredEstablishes: claimTypeName(ClaimType.BLOB_EXISTENCE_TIME),
      conditionRequires: claimTypeName(conditions[0].requires),
      offeredBy: accounts.upstream.address,
      whyRejected:
        "A signed timestamp over the delivered file establishes when the file existed. It says nothing about when the records inside it were generated.",
      escrowBalanceAfter: escrowAfterReject.toString(),
    },
    openTx: openReceipt.transactionHash,
    commitment: {
      merkleRoot: tree.root,
      leafCount: tree.leafCount.toString(),
      sourceId: SOURCE_ID,
      payloadRef: payloadRefOf(records),
      issuer: accounts.upstream.address,
      txHashes: commitTxs,
      leafFormula: "keccak256(abi.encode(index, keccak256(recordBytes), generatedAt, sourceId))",
    },
    scan: {
      totalRecords: RECORD_COUNT,
      violations,
      firstViolationIndex: violation.record.index,
      observedAt: violation.record.generatedAt.toString(),
      thresholdAt: threshold.toString(),
      shortBySeconds: (threshold - violation.record.generatedAt).toString(),
      scalar: {
        conditionId: conditions[1].conditionId,
        observed: BigInt(scalar.observed).toString(),
        threshold: BigInt(conditions[1].threshold).toString(),
        holds: scalar.holds,
      },
    },
    proof: { index: proof.index.toString(), pathLength: proof.merklePath.length, verifiedLocally },
    verification: [
      { step: 1, label: "Leaf reconstructed", detail: "index, keccak256(recordBytes), generatedAt and sourceId, from the proof's own inputs" },
      { step: 2, label: "Inclusion verified", detail: `${proof.merklePath.length} sibling hashes checked against the root inside the stored signed commitment` },
      { step: 3, label: "Index within committed count", detail: `index ${proof.index} sits inside the signed leafCount of ${tree.leafCount}` },
      { step: 4, label: "Commitment binding checked", detail: "the commitment names this purchase and this obligation" },
      { step: 5, label: "Issuer recovered", detail: `recovered signer equals the permitted issuer ${accounts.upstream.address}` },
      { step: 6, label: "Source matched", detail: "the leaf's sourceId equals the condition's expected source" },
      { step: 7, label: "Claim type accepted", detail: "record generation time is a property bound leaves can establish" },
      { step: 8, label: "Predicate violated", detail: `generation time is ${threshold - violation.record.generatedAt} seconds short of the threshold` },
    ],
    settlement: {
      verdict: "BREACH_PROVED",
      refundAmount: (buyerAfter - buyerBefore).toString(),
      to: accounts.buyer.address,
      txHash: proofReceipt.transactionHash,
      blockNumber: proofReceipt.blockNumber.toString(),
      offendingIndex,
      escrowBalanceAfter: (await balance(escrow)).toString(),
    },
  };
}

async function runRelease(): Promise<RunArtifact["release"]> {
  const now = await chainNow();
  const compiled = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const conditions = compiled.map((c) => (c.protectable ? c.condition : (null as never)));
  const terms = makeTerms(pad("0x02", { size: 32 }), conditions, now + DELIVERY_GRACE);
  const specHash = (await read("specHashOf", [terms])) as Hex;

  await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), await signTerms(terms, accounts.buyer), await signTerms(terms, accounts.seller)],
    accounts.seller,
  );

  const records = buildDelivery(RECORD_COUNT, now, 120n);
  const tree = commitTo(records);
  await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRefOf(records));

  const scalar = evaluateScalar(conditions[1], tree.leafCount);
  const earlyError = await expectRevert(escrow, ESCROW_ABI, "release", [terms], accounts.seller);
  await advanceTime(Number(CHALLENGE_WINDOW) + 1);
  const receipt = await send(escrow, ESCROW_ABI, "release", [terms], accounts.seller);

  return {
    specHash,
    amount: AMOUNT.toString(),
    to: accounts.seller.address,
    txHash: receipt.transactionHash,
    violations: countViolations(records, conditions[0]),
    scalarObserved: BigInt(scalar.observed).toString(),
    scalarThreshold: BigInt(conditions[1].threshold).toString(),
    earlyReleaseError: earlyError,
  };
}

function runUnprotectable(): RunArtifact["unprotectable"] {
  const compiled = compileListing([UNPROTECTABLE_TERM], {
    now: 0n,
    permittedIssuer: accounts.upstream.address,
    expectedSourceId: SOURCE_ID,
  })[0];
  if (compiled.protectable) throw new Error("expected an unprotectable term");
  return {
    phrase: compiled.phrase,
    reason: compiled.reason,
    supportedRules: supportedRuleIds(),
    opcodes: ["UINT_GTE", "UINT_EQ", "TIMESTAMP_GTE", "BYTES32_EQ"],
    escrowOpened: false,
  };
}

async function runStalled(): Promise<RunArtifact["stalled"]> {
  const now = await chainNow();
  const compiled = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const conditions = compiled.map((c) => (c.protectable ? c.condition : (null as never)));
  const deadline = now + 20n;
  const terms = makeTerms(pad("0x03", { size: 32 }), conditions, deadline);
  const specHash = (await read("specHashOf", [terms])) as Hex;

  await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), await signTerms(terms, accounts.buyer), await signTerms(terms, accounts.seller)],
    accounts.seller,
  );

  const p = (await read("purchaseOf", [specHash])) as { committedCount: number; conditionCount: number };
  const earlyError = await expectRevert(escrow, ESCROW_ABI, "reclaim", [terms], accounts.buyer);

  await advanceTime(21);
  const before = await balance(accounts.buyer.address);
  const receipt = await send(escrow, ESCROW_ABI, "reclaim", [terms], accounts.buyer);
  const after = await balance(accounts.buyer.address);

  return {
    specHash,
    amount: (after - before).toString(),
    to: accounts.buyer.address,
    txHash: receipt.transactionHash,
    committed: p.committedCount,
    required: p.conditionCount,
    deadline: deadline.toString(),
    earlyReclaimError: earlyError,
  };
}

/**
 * The seller commits a root and sends nothing. Before availability challenges
 * existed this was strictly better for a dishonest seller than stalling,
 * because the commitment moved the purchase out of OPEN and reclaim could no
 * longer reach it.
 */
async function runWithheld(): Promise<RunArtifact["withheld"]> {
  const now = await chainNow();
  const compiled = compileProtected([FRESHNESS_TERM, ROW_COUNT_TERM], now);
  const conditions = compiled.map((c) => (c.protectable ? c.condition : (null as never)));
  const terms = makeTerms(pad("0x04", { size: 32 }), conditions, now + DELIVERY_GRACE);
  const specHash = (await read("specHashOf", [terms])) as Hex;

  await send(
    escrow,
    ESCROW_ABI,
    "openPurchase",
    [terms, offersFor(conditions), await signTerms(terms, accounts.buyer), await signTerms(terms, accounts.seller)],
    accounts.seller,
  );

  // A real tree over real records, committed on chain. The payload itself is
  // never sent to the buyer.
  const records = buildDelivery(RECORD_COUNT, now, MIXED_AGES);
  const tree = commitTo(records);
  const payloadRef = payloadRefOf(records);
  await commitAll(terms, specHash, tree.root, tree.leafCount, payloadRef);

  const challengedIndex = 42n;
  await send(escrow, ESCROW_ABI, "raiseAvailabilityChallenge", [terms, 0n, challengedIndex], accounts.buyer);

  const releaseBlocked = await expectRevert(escrow, ESCROW_ABI, "release", [terms], accounts.seller);
  const earlyClaim = await expectRevert(escrow, ESCROW_ABI, "claimWithheld", [terms], accounts.buyer);

  await advanceTime(Number(CURE_PERIOD) + 1);
  const before = await balance(accounts.buyer.address);
  const receipt = await send(escrow, ESCROW_ABI, "claimWithheld", [terms], accounts.buyer);
  const after = await balance(accounts.buyer.address);

  return {
    specHash,
    amount: (after - before).toString(),
    to: accounts.buyer.address,
    txHash: receipt.transactionHash,
    payloadRef,
    challengedIndex: challengedIndex.toString(),
    curePeriodSeconds: CURE_PERIOD.toString(),
    answered: false,
    releaseBlockedError: releaseBlocked,
    earlyClaimError: earlyClaim,
  };
}
