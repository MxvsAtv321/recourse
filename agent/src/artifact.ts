/**
 * The shape of one captured run. Deliberately dependency free: the Next.js app
 * imports this type across the workspace boundary, so it must not pull in viem.
 * Addresses and hashes are plain strings here and every numeric field is a
 * decimal string, because the artifact is JSON and JSON has no bigint.
 */

export type Check = { name: string; passed: boolean; detail: string };

export type ConditionView = {
  conditionId: number;
  sourceQuote: string;
  ruleId: string;
  claimType: string;
  quantifier: "UNIVERSAL" | "SCALAR";
  opcode: string;
  threshold: string;
  thresholdKind: "timestamp" | "count";
  permittedIssuer: string;
  expectedSourceId: string;
  settlement: string;
  protectedByRule: true;
};

export type RunArtifact = {
  meta: {
    chainId: number;
    rpc: string;
    capturedAt: string;
    chainTime: string;
    blockNumber: string;
    escrow: string;
    usdc: string;
    accounts: { buyer: string; seller: string; upstream: string; timestampAuthority: string };
    assetSymbol: string;
    assetDecimals: number;
  };
  unprotected: {
    recordCount: number;
    checks: Check[];
    allPassed: boolean;
    payment: { amount: string; to: string; txHash: string; blockNumber: string };
    blobTimestamp: { at: string; issuer: string; blobHash: string };
    reveal: {
      windowSeconds: string;
      staleCount: number;
      freshCount: number;
      firstStaleIndex: number;
      oldestAgeSeconds: string;
      newestAgeSeconds: string;
      samples: { index: number; generatedAt: string; ageSeconds: string; stale: boolean }[];
    };
  };
  protectedPurchase: {
    specHash: string;
    amount: string;
    challengeWindowSeconds: string;
    curePeriodSeconds: string;
    deliveryDeadline: string;
    conditions: ConditionView[];
    rejectedOffer: {
      conditionId: number;
      error: string;
      offeredEstablishes: string;
      conditionRequires: string;
      offeredBy: string;
      whyRejected: string;
      escrowBalanceAfter: string;
    };
    openTx: string;
    commitment: {
      merkleRoot: string;
      leafCount: string;
      sourceId: string;
      payloadRef: string;
      issuer: string;
      txHashes: string[];
      leafFormula: string;
    };
    scan: {
      totalRecords: number;
      violations: number;
      firstViolationIndex: number;
      observedAt: string;
      thresholdAt: string;
      shortBySeconds: string;
      scalar: { conditionId: number; observed: string; threshold: string; holds: boolean };
    };
    proof: { index: string; pathLength: number; verifiedLocally: boolean };
    verification: { step: number; label: string; detail: string }[];
    settlement: {
      verdict: "BREACH_PROVED";
      refundAmount: string;
      to: string;
      txHash: string;
      blockNumber: string;
      offendingIndex: string;
      escrowBalanceAfter: string;
    };
  };
  release: {
    specHash: string;
    amount: string;
    to: string;
    txHash: string;
    violations: number;
    scalarObserved: string;
    scalarThreshold: string;
    earlyReleaseError: string;
  };
  unprotectable: {
    phrase: string;
    reason: string;
    supportedRules: string[];
    opcodes: string[];
    escrowOpened: false;
  };
  withheld: {
    specHash: string;
    amount: string;
    to: string;
    txHash: string;
    payloadRef: string;
    challengedIndex: string;
    curePeriodSeconds: string;
    answered: false;
    releaseBlockedError: string;
    earlyClaimError: string;
  };
  stalled: {
    specHash: string;
    amount: string;
    to: string;
    txHash: string;
    committed: number;
    required: number;
    deadline: string;
    earlyReclaimError: string;
  };
};
