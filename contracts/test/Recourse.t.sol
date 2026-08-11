// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Opcode, PredicateEvaluator} from "../src/PredicateEvaluator.sol";
import {MerkleBreachVerifier} from "../src/MerkleBreachVerifier.sol";
import {
    RecourseEscrow,
    PurchaseTerms,
    Condition,
    EvidenceOffer,
    DeliveryCommitment,
    BreachProof,
    PayloadOpening,
    ClaimType,
    Quantifier
} from "../src/RecourseEscrow.sol";

contract RecourseTest is Test {
    RecourseEscrow escrow;
    MockUSDC usdc;

    uint256 constant BUYER_PK = 0xB0;
    uint256 constant SELLER_PK = 0x5E;
    uint256 constant UPSTREAM_PK = 0x11;
    uint256 constant ROGUE_PK = 0xBAD;

    address buyer;
    address seller;
    address upstream;
    address rogue;

    uint256 constant AMOUNT = 100_000_000; // 100 USDC
    uint64 constant WINDOW = 60;
    uint64 constant CURE = 20;
    bytes32 constant PAYLOAD_REF = keccak256("payload-blob-v1");
    uint8 constant CONDITION_ID = 1;
    bytes32 constant SOURCE_ID = keccak256("COINBASE_ETH_USD_FEED");
    bytes32 constant OTHER_SOURCE_ID = keccak256("SOME_OTHER_FEED");

    uint256 constant N = 8;
    uint256 constant STALE_INDEX = 3;

    uint64 freshFloor; // threshold: nothing older than this is acceptable
    uint64 deliveryDeadline;
    bytes[] recordBytes;
    uint64[] generatedAt;

    function setUp() public {
        vm.warp(1_760_000_000);
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        upstream = vm.addr(UPSTREAM_PK);
        rogue = vm.addr(ROGUE_PK);

        escrow = new RecourseEscrow();
        usdc = new MockUSDC();
        usdc.mint(buyer, 1_000_000_000);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);

        freshFloor = uint64(block.timestamp - 3600);
        deliveryDeadline = uint64(block.timestamp + 3600);

        for (uint256 i = 0; i < N; i++) {
            recordBytes.push(abi.encode("ETH-USD", i, uint256(3000 + i)));
            // One record carries yesterday's data. Everything else is fresh.
            generatedAt.push(i == STALE_INDEX ? uint64(block.timestamp - 86_400) : uint64(block.timestamp - 60));
        }
    }

    // ==================================================================
    // The eight tests named in spec/SPEC.md section 8
    // ==================================================================

    function testReleaseAfterChallengeWindow() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        _commit(terms, _rootOf(_compliantLeaves()), UPSTREAM_PK);

        vm.expectRevert(RecourseEscrow.ChallengeWindowOpen.selector);
        escrow.release(terms);

        vm.warp(block.timestamp + WINDOW);
        escrow.release(terms);

        assertEq(usdc.balanceOf(seller), AMOUNT, "seller paid");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.RELEASED));
    }

    function testBreachProofRefunds() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RecourseEscrow.BreachProved(specHash, CONDITION_ID, STALE_INDEX);
        escrow.submitBreachProof(terms, 0, proof);

        assertEq(usdc.balanceOf(buyer), buyerBefore + AMOUNT, "buyer refunded in full");
        assertEq(usdc.balanceOf(seller), 0, "seller paid nothing");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.REFUNDED));
    }

    /// @notice Sacred. Without this the entire proof system is decorative.
    function testRejectProofWithUnboundContent() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        // Direction 1: take a FRESH leaf's index, timestamp and authentication
        // path, then swap in the stale record's bytes. If the tree were built over
        // bare timestamps this would succeed.
        BreachProof memory swapped = _proofFor(terms, leaves, 0);
        swapped.recordBytes = recordBytes[STALE_INDEX];
        vm.expectRevert(RecourseEscrow.MerkleInclusionFailed.selector);
        escrow.submitBreachProof(terms, 0, swapped);

        // Direction 2: keep the stale record's bytes and path, but claim a fresh
        // generation time for them.
        BreachProof memory retimed = _proofFor(terms, leaves, STALE_INDEX);
        retimed.generatedAt = uint64(block.timestamp - 60);
        vm.expectRevert(RecourseEscrow.MerkleInclusionFailed.selector);
        escrow.submitBreachProof(terms, 0, retimed);

        // The honest pairing still works, so the rejections above are about
        // binding and not about some unrelated failure.
        escrow.submitBreachProof(terms, 0, _proofFor(terms, leaves, STALE_INDEX));
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer whole again");
    }

    function testRejectProofWithBadMerklePath() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        proof.merklePath[0] = keccak256("not a sibling");
        vm.expectRevert(RecourseEscrow.MerkleInclusionFailed.selector);
        escrow.submitBreachProof(terms, 0, proof);

        BreachProof memory truncated = _proofFor(terms, leaves, STALE_INDEX);
        bytes32[] memory shortPath = new bytes32[](truncated.merklePath.length - 1);
        for (uint256 i = 0; i < shortPath.length; i++) {
            shortPath[i] = truncated.merklePath[i];
        }
        truncated.merklePath = shortPath;
        vm.expectRevert(RecourseEscrow.MerkleInclusionFailed.selector);
        escrow.submitBreachProof(terms, 0, truncated);
    }

    function testRejectProofFromUnpermittedIssuer() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        bytes32 root = _rootOf(leaves);

        // A commitment signed by a key that is not the condition's permittedIssuer
        // is refused at submission, so no such commitment can ever be stored.
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: specHash,
            conditionId: CONDITION_ID,
            merkleRoot: root,
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        bytes memory rogueSig = _sign(ROGUE_PK, escrow.commitmentDigest(c));
        vm.expectRevert(RecourseEscrow.UnpermittedIssuer.selector);
        escrow.submitDeliveryCommitment(terms, 0, c, rogueSig);

        // The spec puts the same check in submitBreachProof as step 4. Screening at
        // submission makes that branch unreachable through the public API, so poison
        // the stored issuer directly to prove the settlement path also enforces it.
        _commit(terms, root, UPSTREAM_PK);
        _poisonIssuer(specHash, CONDITION_ID, rogue);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        vm.expectRevert(RecourseEscrow.UnpermittedIssuer.selector);
        escrow.submitBreachProof(terms, 0, proof);
    }

    function testRejectClaimTypeMismatch() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = escrow.specHashOf(terms);

        // The seller offers an authentic signed timestamp over the delivered file.
        // It establishes when the FILE existed, not when the records were generated.
        EvidenceOffer[] memory offers = new EvidenceOffer[](1);
        offers[0] =
            EvidenceOffer({conditionId: CONDITION_ID, establishes: ClaimType.BLOB_EXISTENCE_TIME, issuer: upstream});

        vm.expectRevert(RecourseEscrow.ClaimTypeMismatch.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));

        // Nothing moved. Rejection is pre-payment.
        assertEq(usdc.balanceOf(address(escrow)), 0, "no escrow opened");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.NONE));

        // Re-offering an upstream-signed record commitment is accepted.
        offers[0].establishes = ClaimType.RECORD_GENERATION_TIME;
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "escrow funded on the second offer");
    }

    function testRejectCrossSpecReplay() public {
        PurchaseTerms memory termsA = _terms(bytes32(uint256(1)));
        PurchaseTerms memory termsB = _terms(bytes32(uint256(2)));
        bytes32 specA = escrow.specHashOf(termsA);
        bytes32 specB = escrow.specHashOf(termsB);
        assertTrue(specA != specB, "distinct purchases");

        bytes memory buyerSigA = _sign(BUYER_PK, specA);
        bytes memory sellerSigA = _sign(SELLER_PK, specA);

        // Signatures over purchase A carried to purchase B recover to strangers.
        vm.expectRevert(RecourseEscrow.BadBuyerSignature.selector);
        escrow.openPurchase(termsB, _offers(), buyerSigA, sellerSigA);

        vm.expectRevert(RecourseEscrow.BadSellerSignature.selector);
        escrow.openPurchase(termsB, _offers(), _sign(BUYER_PK, specB), sellerSigA);

        // A single mutated field in the terms invalidates both signatures too.
        PurchaseTerms memory tampered = _terms(bytes32(uint256(1)));
        tampered.amount = AMOUNT - 1;
        vm.expectRevert(RecourseEscrow.BadBuyerSignature.selector);
        escrow.openPurchase(tampered, _offers(), buyerSigA, sellerSigA);
    }

    function testRejectRootReplayAcrossSpec() public {
        PurchaseTerms memory termsA = _terms(bytes32(uint256(1)));
        PurchaseTerms memory termsB = _terms(bytes32(uint256(2)));
        bytes32 specA = _open(termsA);
        _open(termsB);

        bytes32 root = _rootOf(_actualLeaves());
        DeliveryCommitment memory cA = DeliveryCommitment({
            specHash: specA,
            conditionId: CONDITION_ID,
            merkleRoot: root,
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        bytes memory sigA = _sign(UPSTREAM_PK, escrow.commitmentDigest(cA));

        // Presented as-is against purchase B, the binding field gives it away.
        vm.expectRevert(RecourseEscrow.CommitmentSpecMismatch.selector);
        escrow.submitDeliveryCommitment(termsB, 0, cA, sigA);

        // Rewriting the binding field to purchase B breaks the signature, because
        // the issuer signed the commitment and not a bare root.
        DeliveryCommitment memory forged = DeliveryCommitment({
            specHash: escrow.specHashOf(termsB),
            conditionId: cA.conditionId,
            merkleRoot: cA.merkleRoot,
            leafCount: cA.leafCount,
            sourceId: cA.sourceId,
            payloadRef: cA.payloadRef
        });
        vm.expectRevert(RecourseEscrow.UnpermittedIssuer.selector);
        escrow.submitDeliveryCommitment(termsB, 0, forged, sigA);

        // It remains valid for the purchase it was issued for.
        escrow.submitDeliveryCommitment(termsA, 0, cA, sigA);
        assertEq(escrow.commitmentOf(specA, CONDITION_ID).merkleRoot, root);
    }

    // ==================================================================
    // Non-delivery. The trivial breach.
    // ==================================================================

    function testReclaimAfterDeliveryDeadline() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "funds escrowed");

        // The seller simply never delivers.
        vm.expectRevert(RecourseEscrow.DeliveryDeadlineNotReached.selector);
        escrow.reclaim(terms);

        vm.warp(uint256(deliveryDeadline));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RecourseEscrow.Reclaimed(specHash, buyer, 0, 1);
        escrow.reclaim(terms);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer whole");
        assertEq(usdc.balanceOf(seller), 0, "seller paid nothing");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.RECLAIMED));

        vm.expectRevert(RecourseEscrow.WrongState.selector);
        escrow.reclaim(terms);
    }

    function testReclaimAfterPartialCommitment() public {
        Condition[] memory cs = new Condition[](2);
        cs[0] = _freshness(1, upstream);
        cs[1] = _rowCount(2, Opcode.UINT_GTE, N);
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        bytes32 specHash = _open(terms);

        // The seller commits the first obligation and stalls on the second.
        _commitAt(terms, 0, _rootOf(_compliantLeaves()), uint64(N), UPSTREAM_PK);
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.OPEN), "still OPEN");
        assertEq(escrow.purchaseOf(specHash).committedCount, 1);
        assertEq(escrow.purchaseOf(specHash).conditionCount, 2);

        // A partial delivery must not strand the buyer any more than no delivery.
        vm.warp(uint256(deliveryDeadline));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RecourseEscrow.Reclaimed(specHash, buyer, 1, 2);
        escrow.reclaim(terms);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer whole");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.RECLAIMED));
    }

    function testReclaimBlockedWhileDelivered() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        _commit(terms, _rootOf(_compliantLeaves()), UPSTREAM_PK);

        // Delivered on time. The deadline passing afterwards changes nothing:
        // the buyer settles by counterexample or not at all.
        vm.warp(uint256(deliveryDeadline) + 1);
        vm.expectRevert(RecourseEscrow.WrongState.selector);
        escrow.reclaim(terms);

        escrow.release(terms);
        assertEq(usdc.balanceOf(seller), AMOUNT, "seller paid");
    }

    // ==================================================================
    // Scalar claims settle directly against the signed commitment.
    // ==================================================================

    function testScalarRowCountSettlesFromLeafCount() public {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _rowCount(1, Opcode.UINT_GTE, N);
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        bytes32 specHash = _open(terms);

        _commitAt(terms, 0, _rootOf(_actualLeaves()), uint64(N), UPSTREAM_PK);

        // No counterexample is possible or needed. One row cannot disprove
        // "at least 8 rows", so the count the issuer signed is read directly.
        vm.warp(block.timestamp + WINDOW);
        escrow.release(terms);

        assertEq(usdc.balanceOf(seller), AMOUNT, "seller paid on a satisfied scalar claim");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.RELEASED));
    }

    function testScalarRowCountShortfallRefunds() public {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _rowCount(1, Opcode.UINT_GTE, N);
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        bytes32 specHash = _open(terms);

        // A short delivery, committed honestly: five leaves, five counted.
        bytes32[] memory all = _actualLeaves();
        bytes32[] memory short_ = new bytes32[](5);
        for (uint256 i = 0; i < 5; i++) {
            short_[i] = all[i];
        }
        _commitAt(terms, 0, _rootOf(short_), 5, UPSTREAM_PK);

        vm.warp(block.timestamp + WINDOW);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit RecourseEscrow.ScalarConditionFailed(specHash, 1, bytes32(uint256(5)), bytes32(uint256(N)));
        escrow.release(terms);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer refunded on the shortfall");
        assertEq(usdc.balanceOf(seller), 0, "seller paid nothing");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.REFUNDED));
    }

    /// @notice A counterexample at an index outside the signed leafCount is
    ///         rejected. The contract cannot check a signed count against the
    ///         tree without iterating it, and does not try. What it enforces is
    ///         that a counterexample sits inside the delivery the issuer counted.
    function testRejectCounterexampleBeyondCommittedCount() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();

        // The issuer signs the full eight leaf root but counts only two.
        _commitAt(terms, 0, _rootOf(leaves), 2, UPSTREAM_PK);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        vm.expectRevert(RecourseEscrow.LeafIndexBeyondCommittedCount.selector);
        escrow.submitBreachProof(terms, 0, proof);

        // A leaf inside the counted range is still usable, so the rejection is
        // about the count and not about the path.
        BreachProof memory inRange = _proofFor(terms, leaves, 1);
        vm.expectRevert(RecourseEscrow.ConditionNotViolated.selector);
        escrow.submitBreachProof(terms, 0, inRange);
    }

    function testRejectZeroLeafCount() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: specHash,
            conditionId: CONDITION_ID,
            merkleRoot: _rootOf(_actualLeaves()),
            leafCount: 0,
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        bytes memory sig = _sign(UPSTREAM_PK, escrow.commitmentDigest(c));
        vm.expectRevert(RecourseEscrow.ZeroLeafCount.selector);
        escrow.submitDeliveryCommitment(terms, 0, c, sig);
    }

    // ==================================================================
    // Signature and identity hygiene
    // ==================================================================

    function testRejectZeroAddressRecovery() public {
        // A 65 byte signature with a malformed v makes ecrecover return address(0).
        bytes memory garbage = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(0));

        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: specHash,
            conditionId: CONDITION_ID,
            merkleRoot: _rootOf(_actualLeaves()),
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        vm.expectRevert(RecourseEscrow.ZeroAddressSignature.selector);
        escrow.submitDeliveryCommitment(terms, 0, c, garbage);

        // The hole this closes: a condition naming address(0) as permittedIssuer
        // would otherwise accept that same garbage as a valid issuer signature.
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, address(0));
        PurchaseTerms memory zeroTerms = _termsWith(bytes32(uint256(2)), cs);
        bytes32 zeroSpec = _open(zeroTerms);
        DeliveryCommitment memory z = DeliveryCommitment({
            specHash: zeroSpec,
            conditionId: CONDITION_ID,
            merkleRoot: _rootOf(_actualLeaves()),
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        vm.expectRevert(RecourseEscrow.ZeroAddressSignature.selector);
        escrow.submitDeliveryCommitment(zeroTerms, 0, z, garbage);

        // And it closes the same hole for the terms signatures.
        PurchaseTerms memory fresh = _terms(bytes32(uint256(3)));
        EvidenceOffer[] memory offers = _offersFor(fresh.conditions);
        vm.expectRevert(RecourseEscrow.ZeroAddressSignature.selector);
        escrow.openPurchase(fresh, offers, garbage, garbage);
    }

    function testRejectDuplicateConditionId() public {
        Condition[] memory cs = new Condition[](2);
        cs[0] = _freshness(CONDITION_ID, upstream);
        cs[1] = _rowCount(CONDITION_ID, Opcode.UINT_GTE, N); // same id, different obligation
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);

        bytes32 specHash = escrow.specHashOf(terms);
        EvidenceOffer[] memory offers = _offersFor(cs);
        vm.expectRevert(RecourseEscrow.DuplicateConditionId.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));

        assertEq(usdc.balanceOf(address(escrow)), 0, "no escrow opened");
    }

    function testRejectUnsettleableScalarCondition() public {
        // A scalar claim the signed commitment carries no quantity for.
        Condition[] memory cs = new Condition[](1);
        cs[0] = _rowCount(1, Opcode.UINT_GTE, N);
        cs[0].requires = ClaimType.RECORD_GENERATION_TIME;
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        bytes32 specHash = escrow.specHashOf(terms);
        EvidenceOffer[] memory offers = _offersFor(cs);
        vm.expectRevert(RecourseEscrow.UnsettleableScalarCondition.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));

        // And a row count compared with an opcode that is not an integer compare.
        Condition[] memory cs2 = new Condition[](1);
        cs2[0] = _rowCount(1, Opcode.BYTES32_EQ, N);
        PurchaseTerms memory terms2 = _termsWith(bytes32(uint256(2)), cs2);
        bytes32 spec2 = escrow.specHashOf(terms2);
        EvidenceOffer[] memory offers2 = _offersFor(cs2);
        vm.expectRevert(RecourseEscrow.UnsettleableScalarCondition.selector);
        escrow.openPurchase(terms2, offers2, _sign(BUYER_PK, spec2), _sign(SELLER_PK, spec2));
    }

    function testRejectDeadlineInPast() public {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, upstream);
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        terms.deliveryDeadline = uint64(block.timestamp);
        bytes32 specHash = escrow.specHashOf(terms);
        EvidenceOffer[] memory offers = _offersFor(cs);
        vm.expectRevert(RecourseEscrow.DeadlineInPast.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));
    }

    // ==================================================================
    // Availability. Committing a root is not delivering a payload.
    // ==================================================================

    /// @notice The hole this closes: commit, send nothing, wait out the window,
    ///         collect. Reclaim cannot help because the commitment left OPEN.
    function testCommitWithoutDeliveryCannotRelease() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        _commit(terms, _rootOf(_actualLeaves()), UPSTREAM_PK);

        // Reclaim is unavailable: the commitment already moved state out of OPEN.
        vm.warp(uint256(deliveryDeadline) + 1);
        vm.expectRevert(RecourseEscrow.WrongState.selector);
        escrow.reclaim(terms);

        // Rewind to inside the window and contest availability instead.
        vm.warp(1_760_000_000 + 1);
        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, STALE_INDEX);
        assertTrue(escrow.availabilityOf(specHash).open, "challenge open");

        // The seller can no longer run out the clock into a release.
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(RecourseEscrow.AvailabilityChallengeOpen.selector);
        escrow.release(terms);

        assertEq(usdc.balanceOf(seller), 0, "seller not paid");
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "funds still escrowed");
    }

    function testAvailabilityChallengeRefundsOnNoAnswer() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        _commit(terms, _rootOf(_actualLeaves()), UPSTREAM_PK);

        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, 5);

        vm.expectRevert(RecourseEscrow.CurePeriodRunning.selector);
        escrow.claimWithheld(terms);

        vm.warp(block.timestamp + CURE);
        escrow.claimWithheld(terms);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "buyer refunded in full");
        assertEq(usdc.balanceOf(seller), 0, "seller paid nothing");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.REFUNDED));
        assertFalse(escrow.availabilityOf(specHash).open, "challenge closed");
    }

    function testAvailabilityChallengeAnsweredResumesWindow() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        uint64 deliveredAt = escrow.purchaseOf(specHash).deliveredAt;

        vm.warp(block.timestamp + 5);
        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, 1);

        // A seller holding the payload opens the named leaf. Anyone may answer.
        vm.warp(block.timestamp + 6);
        escrow.answerAvailabilityChallenge(terms, 0, _opening(leaves, 1));

        assertFalse(escrow.availabilityOf(specHash).open, "challenge cleared");
        assertEq(
            escrow.purchaseOf(specHash).deliveredAt,
            deliveredAt + 6,
            "clock resumes where it paused, frivolous challenge buys no time"
        );

        // The window runs on from where it stopped, then releases normally.
        vm.expectRevert(RecourseEscrow.ChallengeWindowOpen.selector);
        escrow.release(terms);
        vm.warp(uint256(escrow.purchaseOf(specHash).deliveredAt) + WINDOW);
        escrow.release(terms);
        assertEq(usdc.balanceOf(seller), AMOUNT, "seller paid after answering");
    }

    /// @notice Answering hands the buyer the bytes a counterexample needs, so a
    ///         seller sitting on bad records incriminates itself by curing.
    function testAnsweringAStaleLeafArmsTheBuyer() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, STALE_INDEX);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit RecourseEscrow.AvailabilityAnswered(
            escrow.specHashOf(terms), CONDITION_ID, STALE_INDEX, recordBytes[STALE_INDEX], generatedAt[STALE_INDEX]
        );
        escrow.answerAvailabilityChallenge(terms, 0, _opening(leaves, STALE_INDEX));

        // Those are exactly the bytes and the timestamp a breach proof carries.
        escrow.submitBreachProof(terms, 0, _proofFor(terms, leaves, STALE_INDEX));
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "refunded using the seller's own answer");
    }

    function testAvailabilityChallengeGuards() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32[] memory leaves = _actualLeaves();
        _open(terms);

        // Not while the purchase is merely OPEN.
        vm.prank(buyer);
        vm.expectRevert(RecourseEscrow.WrongState.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, 1);

        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        // Only the buyer may contest availability.
        vm.prank(seller);
        vm.expectRevert(RecourseEscrow.NotBuyer.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, 1);

        // Not for a leaf outside the committed count.
        vm.prank(buyer);
        vm.expectRevert(RecourseEscrow.LeafIndexBeyondCommittedCount.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, N);

        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, 2);

        // One at a time.
        vm.prank(buyer);
        vm.expectRevert(RecourseEscrow.AvailabilityChallengeOpen.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, 3);

        // The answer must open the leaf that was actually named.
        PayloadOpening memory wrong = _opening(leaves, 4);
        vm.expectRevert(RecourseEscrow.OpeningIndexMismatch.selector);
        escrow.answerAvailabilityChallenge(terms, 0, wrong);

        // A fabricated opening does not verify against the committed root.
        PayloadOpening memory forged = _opening(leaves, 2);
        forged.recordBytes = bytes("not the committed record");
        vm.expectRevert(RecourseEscrow.MerkleInclusionFailed.selector);
        escrow.answerAvailabilityChallenge(terms, 0, forged);

        // Answering after the cure period lapsed is too late.
        vm.warp(block.timestamp + CURE);
        PayloadOpening memory late = _opening(leaves, 2);
        vm.expectRevert(RecourseEscrow.CurePeriodExpired.selector);
        escrow.answerAvailabilityChallenge(terms, 0, late);
    }

    function testAvailabilityChallengesAreCapped() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32[] memory leaves = _actualLeaves();
        _open(terms);
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(buyer);
            escrow.raiseAvailabilityChallenge(terms, 0, i);
            escrow.answerAvailabilityChallenge(terms, 0, _opening(leaves, i));
        }
        vm.prank(buyer);
        vm.expectRevert(RecourseEscrow.TooManyAvailabilityChallenges.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, 4);
    }

    function testRejectZeroPayloadRef() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: specHash,
            conditionId: CONDITION_ID,
            merkleRoot: _rootOf(_actualLeaves()),
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: bytes32(0)
        });
        bytes memory sig = _sign(UPSTREAM_PK, escrow.commitmentDigest(c));
        vm.expectRevert(RecourseEscrow.ZeroPayloadRef.selector);
        escrow.submitDeliveryCommitment(terms, 0, c, sig);
    }

    // ==================================================================
    // Deadline boundaries at t-1. Every other timing assertion sits at offset 0
    // or at exactly t, so an off-by-one shifting a boundary one second in the
    // permissive direction would pass the whole suite unnoticed.
    // ==================================================================

    function testReleaseRevertsOneSecondBeforeWindow() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        _commit(terms, _rootOf(_compliantLeaves()), UPSTREAM_PK);
        uint256 deliveredAt = escrow.purchaseOf(specHash).deliveredAt;

        vm.warp(deliveredAt + WINDOW - 1);
        vm.expectRevert(RecourseEscrow.ChallengeWindowOpen.selector);
        escrow.release(terms);

        // One second later it goes through, so the boundary is where it claims
        // to be rather than merely somewhere earlier.
        vm.warp(deliveredAt + WINDOW);
        escrow.release(terms);
        assertEq(usdc.balanceOf(seller), AMOUNT, "released at exactly t, not before");
    }

    function testBreachProofSucceedsOneSecondBeforeWindow() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);
        uint256 deliveredAt = escrow.purchaseOf(specHash).deliveredAt;

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        vm.warp(deliveredAt + WINDOW - 1);
        escrow.submitBreachProof(terms, 0, proof);

        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "a last second counterexample still lands");
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.REFUNDED));
    }

    function testRaiseAvailabilityChallengeSucceedsOneSecondBeforeWindow() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);
        uint256 deliveredAt = escrow.purchaseOf(specHash).deliveredAt;

        vm.warp(deliveredAt + WINDOW - 1);
        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, 1);
        assertTrue(escrow.availabilityOf(specHash).open, "contestable up to the last second");

        // Answering at the same instant leaves deliveredAt unmoved, so the window
        // still ends where it did.
        escrow.answerAvailabilityChallenge(terms, 0, _opening(leaves, 1));
        assertEq(escrow.purchaseOf(specHash).deliveredAt, deliveredAt, "no time bought");

        vm.warp(deliveredAt + WINDOW);
        vm.prank(buyer);
        vm.expectRevert(RecourseEscrow.ChallengeWindowClosed.selector);
        escrow.raiseAvailabilityChallenge(terms, 0, 2);
    }

    function testReclaimRevertsOneSecondBeforeDeadline() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);

        vm.warp(uint256(deliveryDeadline) - 1);
        vm.expectRevert(RecourseEscrow.DeliveryDeadlineNotReached.selector);
        escrow.reclaim(terms);

        vm.warp(uint256(deliveryDeadline));
        escrow.reclaim(terms);
        assertEq(usdc.balanceOf(buyer), 1_000_000_000, "reclaimable at exactly t, not before");
    }

    function testClaimWithheldRevertsOneSecondBeforeCure() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        bytes32 specHash = _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        vm.prank(buyer);
        escrow.raiseAvailabilityChallenge(terms, 0, 1);
        uint256 raisedAt = escrow.availabilityOf(specHash).raisedAt;

        vm.warp(raisedAt + CURE - 1);
        vm.expectRevert(RecourseEscrow.CurePeriodRunning.selector);
        escrow.claimWithheld(terms);

        // The other side of the same boundary: the seller can still cure at that
        // exact instant, so the two comparisons meet with no gap and no overlap.
        escrow.answerAvailabilityChallenge(terms, 0, _opening(leaves, 1));
        assertFalse(escrow.availabilityOf(specHash).open, "cured on the last second");
    }

    // ==================================================================
    // A purchase must not record itself as funded having moved nothing.
    // ==================================================================

    function testRejectAssetWithNoCode() public {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, upstream);
        EvidenceOffer[] memory offers = _offersFor(cs);

        // An EOA. asset.call returns ok with empty returndata, which the
        // no-return-value branch in _pull would otherwise accept.
        PurchaseTerms memory eoa = _termsWith(bytes32(uint256(1)), cs);
        eoa.asset = address(0xA11CE);
        bytes32 eoaSpec = escrow.specHashOf(eoa);
        vm.expectRevert(RecourseEscrow.AssetNotAContract.selector);
        escrow.openPurchase(eoa, offers, _sign(BUYER_PK, eoaSpec), _sign(SELLER_PK, eoaSpec));

        PurchaseTerms memory zero = _termsWith(bytes32(uint256(2)), cs);
        zero.asset = address(0);
        bytes32 zeroSpec = escrow.specHashOf(zero);
        vm.expectRevert(RecourseEscrow.AssetNotAContract.selector);
        escrow.openPurchase(zero, offers, _sign(BUYER_PK, zeroSpec), _sign(SELLER_PK, zeroSpec));

        assertEq(uint8(escrow.purchaseOf(eoaSpec).state), uint8(RecourseEscrow.State.NONE));
        assertEq(uint8(escrow.purchaseOf(zeroSpec).state), uint8(RecourseEscrow.State.NONE));

        // A real token still opens, so the guard rejects the right thing.
        _open(_terms(bytes32(uint256(3))));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function testRejectZeroAmount() public {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, upstream);
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        terms.amount = 0;
        bytes32 specHash = escrow.specHashOf(terms);
        EvidenceOffer[] memory offers = _offersFor(cs);

        vm.expectRevert(RecourseEscrow.ZeroAmount.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));
        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.NONE));
    }

    // ==================================================================
    // Supporting tests
    // ==================================================================

    function testRejectProofWithWrongSourceId() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);

        // Leaves bound to a different semantic origin, committed honestly.
        bytes32[] memory leaves = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            leaves[i] =
                MerkleBreachVerifier.leafOf(i, keccak256(recordBytes[i]), generatedAt[i], OTHER_SOURCE_ID);
        }
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        proof.sourceId = OTHER_SOURCE_ID;
        vm.expectRevert(RecourseEscrow.SourceIdMismatch.selector);
        escrow.submitBreachProof(terms, 0, proof);
    }

    function testRejectProofWhenConditionHolds() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _compliantLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        // Record 0 is included and authentic, but it does not violate anything.
        BreachProof memory proof = _proofFor(terms, leaves, 0);
        proof.generatedAt = uint64(block.timestamp - 60);
        vm.expectRevert(RecourseEscrow.ConditionNotViolated.selector);
        escrow.submitBreachProof(terms, 0, proof);
    }

    function testRejectProofAfterChallengeWindowCloses() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);

        BreachProof memory proof = _proofFor(terms, leaves, STALE_INDEX);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(RecourseEscrow.ChallengeWindowClosed.selector);
        escrow.submitBreachProof(terms, 0, proof);
    }

    function testRejectReleaseAfterBreachProved() public {
        PurchaseTerms memory terms = _terms(bytes32(uint256(1)));
        _open(terms);
        bytes32[] memory leaves = _actualLeaves();
        _commit(terms, _rootOf(leaves), UPSTREAM_PK);
        escrow.submitBreachProof(terms, 0, _proofFor(terms, leaves, STALE_INDEX));

        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(RecourseEscrow.WrongState.selector);
        escrow.release(terms);
    }

    /// @notice A blob timestamp says when the file existed. It is not a per-record
    ///         property, so a leaf counterexample cannot establish it.
    ///
    ///         openPurchase now refuses this condition outright, which makes the
    ///         settlement-path check unreachable through the public API. Clone a
    ///         real DELIVERED purchase onto the refused terms' specHash to prove
    ///         the settlement path enforces it too. Same pattern as the
    ///         unreachable issuer branch in testRejectProofFromUnpermittedIssuer.
    function testRejectBlobExistenceTimeByCounterexample() public {
        PurchaseTerms memory good = _terms(bytes32(uint256(1)));
        bytes32 goodSpec = _open(good);
        bytes32[] memory leaves = _actualLeaves();
        _commit(good, _rootOf(leaves), UPSTREAM_PK);

        PurchaseTerms memory blob = _terms(bytes32(uint256(1)));
        blob.conditions[0].requires = ClaimType.BLOB_EXISTENCE_TIME;
        bytes32 blobSpec = escrow.specHashOf(blob);
        assertTrue(blobSpec != goodSpec, "distinct terms");

        // The public path is closed.
        EvidenceOffer[] memory offers = _offersFor(blob.conditions);
        bytes memory bSig = _sign(BUYER_PK, blobSpec);
        bytes memory sSig = _sign(SELLER_PK, blobSpec);
        vm.expectRevert(RecourseEscrow.UnsettleableUniversalCondition.selector);
        escrow.openPurchase(blob, offers, bSig, sSig);
        assertEq(uint8(escrow.purchaseOf(blobSpec).state), uint8(RecourseEscrow.State.NONE), "never opened");

        // Force the state the screen prevents.
        _cloneSlots(_purchaseSlot(goodSpec), _purchaseSlot(blobSpec));
        _cloneSlots(_commitmentSlot(goodSpec, CONDITION_ID), _commitmentSlot(blobSpec, CONDITION_ID));
        // The clone still names the purchase it was signed for. Rebind it, or the
        // settlement path stops at binding and never reaches the claim type.
        vm.store(address(escrow), bytes32(uint256(_commitmentSlot(blobSpec, CONDITION_ID)) + 1), blobSpec);

        // Assert the fixture rather than trusting the layout. If the structs are
        // ever reordered this fails loudly instead of testing nothing.
        assertEq(
            keccak256(abi.encode(escrow.purchaseOf(blobSpec))),
            keccak256(abi.encode(escrow.purchaseOf(goodSpec))),
            "purchase cloned"
        );
        assertEq(uint8(escrow.purchaseOf(blobSpec).state), uint8(RecourseEscrow.State.DELIVERED), "clone DELIVERED");
        assertEq(escrow.commitmentOf(blobSpec, CONDITION_ID).specHash, blobSpec, "commitment rebound");
        assertEq(escrow.commitmentOf(blobSpec, CONDITION_ID).merkleRoot, _rootOf(leaves), "root cloned");
        assertEq(escrow.commitmentOf(blobSpec, CONDITION_ID).issuer, upstream, "issuer cloned");
        assertEq(escrow.commitmentOf(blobSpec, CONDITION_ID).leafCount, uint64(N), "leafCount cloned");

        // Everything ahead of the claim type check now passes, so the revert is
        // attributable to the claim type and nothing else.
        BreachProof memory proof = _proofFor(blob, leaves, STALE_INDEX);
        vm.expectRevert(RecourseEscrow.ClaimNotEstablishedByBoundLeaves.selector);
        escrow.submitBreachProof(blob, 0, proof);

        // The same proof against the untouched purchase settles, which confirms
        // the fixture was sound and the delivery genuinely does breach.
        escrow.submitBreachProof(good, 0, _proofFor(good, leaves, STALE_INDEX));
        assertEq(uint8(escrow.purchaseOf(goodSpec).state), uint8(RecourseEscrow.State.REFUNDED));
    }

    function testRejectUnsettleableUniversalConditionAtOpen() public {
        // BLOB_EXISTENCE_TIME is a property of the file, not of the records in it.
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, upstream);
        cs[0].requires = ClaimType.BLOB_EXISTENCE_TIME;
        PurchaseTerms memory terms = _termsWith(bytes32(uint256(1)), cs);
        bytes32 specHash = escrow.specHashOf(terms);
        EvidenceOffer[] memory offers = _offersFor(cs);
        vm.expectRevert(RecourseEscrow.UnsettleableUniversalCondition.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));
        assertEq(usdc.balanceOf(address(escrow)), 0, "no escrow opened");

        // ROW_COUNT under a universal quantifier: no single row disproves a count.
        Condition[] memory cs2 = new Condition[](1);
        cs2[0] = _freshness(CONDITION_ID, upstream);
        cs2[0].requires = ClaimType.ROW_COUNT;
        PurchaseTerms memory terms2 = _termsWith(bytes32(uint256(2)), cs2);
        bytes32 spec2 = escrow.specHashOf(terms2);
        EvidenceOffer[] memory offers2 = _offersFor(cs2);
        vm.expectRevert(RecourseEscrow.UnsettleableUniversalCondition.selector);
        escrow.openPurchase(terms2, offers2, _sign(BUYER_PK, spec2), _sign(SELLER_PK, spec2));

        // Both claims the bound leaves do carry still open normally.
        _open(_terms(bytes32(uint256(3))));
        Condition[] memory cs4 = new Condition[](1);
        cs4[0] = _freshness(CONDITION_ID, upstream);
        cs4[0].requires = ClaimType.SCHEMA_HASH;
        cs4[0].opcode = Opcode.BYTES32_EQ;
        _open(_termsWith(bytes32(uint256(4)), cs4));
        assertEq(usdc.balanceOf(address(escrow)), 2 * AMOUNT, "settleable universal claims open");
    }

    function testPredicateEvaluatorIsTotal() public pure {
        assertTrue(PredicateEvaluator.satisfied(Opcode.UINT_GTE, bytes32(uint256(5)), bytes32(uint256(5))));
        assertFalse(PredicateEvaluator.satisfied(Opcode.UINT_GTE, bytes32(uint256(4)), bytes32(uint256(5))));
        assertTrue(PredicateEvaluator.satisfied(Opcode.UINT_EQ, bytes32(uint256(5)), bytes32(uint256(5))));
        assertFalse(PredicateEvaluator.satisfied(Opcode.UINT_EQ, bytes32(uint256(6)), bytes32(uint256(5))));
        assertTrue(PredicateEvaluator.satisfied(Opcode.TIMESTAMP_GTE, bytes32(uint256(99)), bytes32(uint256(98))));
        assertFalse(PredicateEvaluator.satisfied(Opcode.TIMESTAMP_GTE, bytes32(uint256(97)), bytes32(uint256(98))));
        assertTrue(PredicateEvaluator.satisfied(Opcode.BYTES32_EQ, keccak256("a"), keccak256("a")));
        assertFalse(PredicateEvaluator.satisfied(Opcode.BYTES32_EQ, keccak256("a"), keccak256("b")));
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    function _freshness(uint8 id, address issuer) internal view returns (Condition memory) {
        return Condition({
            conditionId: id,
            requires: ClaimType.RECORD_GENERATION_TIME,
            quantifier: Quantifier.UNIVERSAL,
            opcode: Opcode.TIMESTAMP_GTE,
            threshold: bytes32(uint256(freshFloor)),
            permittedIssuer: issuer,
            expectedSourceId: SOURCE_ID,
            sourceQuote: "every record generated within the last hour"
        });
    }

    function _rowCount(uint8 id, Opcode op, uint256 threshold) internal view returns (Condition memory) {
        return Condition({
            conditionId: id,
            requires: ClaimType.ROW_COUNT,
            quantifier: Quantifier.SCALAR,
            opcode: op,
            threshold: bytes32(threshold),
            permittedIssuer: upstream,
            expectedSourceId: SOURCE_ID,
            sourceQuote: "at least 8 records"
        });
    }

    function _termsWith(bytes32 purchaseId, Condition[] memory cs) internal view returns (PurchaseTerms memory) {
        return PurchaseTerms({
            purchaseId: purchaseId,
            buyer: buyer,
            seller: seller,
            amount: AMOUNT,
            asset: address(usdc),
            conditions: cs,
            challengeWindow: WINDOW,
            deliveryDeadline: deliveryDeadline,
            curePeriod: CURE
        });
    }

    function _terms(bytes32 purchaseId) internal view returns (PurchaseTerms memory) {
        Condition[] memory cs = new Condition[](1);
        cs[0] = _freshness(CONDITION_ID, upstream);
        return _termsWith(purchaseId, cs);
    }

    function _offersFor(Condition[] memory cs) internal pure returns (EvidenceOffer[] memory offers) {
        offers = new EvidenceOffer[](cs.length);
        for (uint256 i = 0; i < cs.length; i++) {
            offers[i] = EvidenceOffer({
                conditionId: cs[i].conditionId,
                establishes: cs[i].requires,
                issuer: cs[i].permittedIssuer
            });
        }
    }

    function _offers() internal view returns (EvidenceOffer[] memory offers) {
        offers = new EvidenceOffer[](1);
        offers[0] =
            EvidenceOffer({conditionId: CONDITION_ID, establishes: ClaimType.RECORD_GENERATION_TIME, issuer: upstream});
    }

    function _open(PurchaseTerms memory terms) internal returns (bytes32 specHash) {
        specHash = escrow.specHashOf(terms);
        escrow.openPurchase(
            terms, _offersFor(terms.conditions), _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash)
        );
    }

    function _commit(PurchaseTerms memory terms, bytes32 root, uint256 pk) internal {
        _commitAt(terms, 0, root, uint64(N), pk);
    }

    function _commitAt(
        PurchaseTerms memory terms,
        uint256 conditionIndex,
        bytes32 root,
        uint64 leafCount,
        uint256 pk
    ) internal {
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: escrow.specHashOf(terms),
            conditionId: terms.conditions[conditionIndex].conditionId,
            merkleRoot: root,
            leafCount: leafCount,
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        escrow.submitDeliveryCommitment(terms, conditionIndex, c, _sign(pk, escrow.commitmentDigest(c)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The delivery as it actually is: one record carries yesterday's data.
    function _actualLeaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            leaves[i] = MerkleBreachVerifier.leafOf(i, keccak256(recordBytes[i]), generatedAt[i], SOURCE_ID);
        }
    }

    /// @dev A delivery where every record really is fresh.
    function _compliantLeaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            leaves[i] = MerkleBreachVerifier.leafOf(
                i, keccak256(recordBytes[i]), uint64(block.timestamp - 60), SOURCE_ID
            );
        }
    }

    function _proofFor(PurchaseTerms memory terms, bytes32[] memory leaves, uint256 index)
        internal
        view
        returns (BreachProof memory)
    {
        return BreachProof({
            specHash: escrow.specHashOf(terms),
            conditionId: CONDITION_ID,
            index: index,
            recordBytes: recordBytes[index],
            generatedAt: generatedAt[index],
            sourceId: SOURCE_ID,
            merklePath: _pathFor(leaves, index)
        });
    }

    function _purchaseSlot(bytes32 specHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(specHash, uint256(0)));
    }

    /// @dev Copies a generous span rather than an exact struct width, so the
    ///      helper does not encode a slot count that a field reorder would
    ///      silently invalidate. Callers assert the result through the getters.
    function _cloneSlots(bytes32 fromBase, bytes32 toBase) internal {
        for (uint256 i = 0; i < 8; i++) {
            vm.store(
                address(escrow),
                bytes32(uint256(toBase) + i),
                vm.load(address(escrow), bytes32(uint256(fromBase) + i))
            );
        }
    }

    /// @dev Rewrites the stored issuer without hard coding its slot offset, so
    ///      reordering StoredCommitment cannot silently turn this into a no-op.
    ///      Locates the word currently holding the known issuer, then asserts
    ///      the rewrite through the public getter.
    function _poisonIssuer(bytes32 specHash, uint8 conditionId, address to) internal {
        address from = escrow.commitmentOf(specHash, conditionId).issuer;
        bytes32 base = _commitmentSlot(specHash, conditionId);
        bool found;
        for (uint256 i = 0; i < 8; i++) {
            bytes32 slot = bytes32(uint256(base) + i);
            if (vm.load(address(escrow), slot) == bytes32(uint256(uint160(from)))) {
                vm.store(address(escrow), slot, bytes32(uint256(uint160(to))));
                found = true;
                break;
            }
        }
        assertTrue(found, "issuer slot not located");
        assertEq(escrow.commitmentOf(specHash, conditionId).issuer, to, "poisoned");
    }

    function _opening(bytes32[] memory leaves, uint256 index) internal view returns (PayloadOpening memory) {
        return PayloadOpening({
            conditionId: CONDITION_ID,
            index: index,
            recordBytes: recordBytes[index],
            generatedAt: generatedAt[index],
            sourceId: SOURCE_ID,
            merklePath: _pathFor(leaves, index)
        });
    }

    function _commitmentSlot(bytes32 specHash, uint8 conditionId) internal pure returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(specHash, uint256(1)));
        return keccak256(abi.encode(uint256(conditionId), inner));
    }

    // Merkle construction, test side only. Sorted pairs, odd node promoted.
    function _rootOf(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    function _pathFor(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory path) {
        bytes32[] memory buf = new bytes32[](64);
        uint256 len = 0;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) {
                buf[len++] = level[sib];
            }
            level = _nextLevel(level);
            idx /= 2;
        }
        path = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            path[i] = buf[i];
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory up) {
        uint256 n = (level.length + 1) / 2;
        up = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            if (2 * i + 1 < level.length) {
                bytes32 a = level[2 * i];
                bytes32 b = level[2 * i + 1];
                up[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
            } else {
                up[i] = level[2 * i];
            }
        }
    }
}
