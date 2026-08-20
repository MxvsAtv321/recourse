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
    ClaimType,
    Quantifier
} from "../src/RecourseEscrow.sol";

/// @title Regression suite for the removed SCHEMA_HASH condition
///
/// @notice `agent/src/compiler.ts` used to compile the listing phrase
///           every record matches schema "pair,seq,priceE8"
///         into a UNIVERSAL SCHEMA_HASH condition whose threshold was
///         keccak256 of the SCHEMA DESCRIPTOR, while `_observed` in the escrow
///         returned keccak256 of the RECORD PAYLOAD. Under BYTES32_EQ those two
///         are never equal for a record that conforms to the schema, so every
///         conforming record was a valid counterexample and the escrow refunded
///         the buyer against an honest delivery.
///
///         The rule was cut rather than stretching the leaf preimage or the
///         opcode set to fit the phrase. This suite holds the fix in place:
///
///         1. the two digests were never comparable quantities (the evidence)
///         2. a UNIVERSAL SCHEMA_HASH condition is refused at openPurchase
///         3. a SCALAR SCHEMA_HASH condition is refused at openPurchase
///         4. even with the open-time screen bypassed, the breach path refuses it
///
///         The phrase itself is now UNPROTECTABLE. That is asserted on the
///         TypeScript side, where the compiler lives, by
///         `agent/src/demo/check-condition-views.ts`.
contract SchemaHashConditionTest is Test {
    RecourseEscrow escrow;
    MockUSDC usdc;

    uint256 constant BUYER_PK = 0xB0;
    uint256 constant SELLER_PK = 0x5E;
    uint256 constant UPSTREAM_PK = 0x11;

    address buyer;
    address seller;
    address upstream;

    uint256 constant AMOUNT = 100_000_000;
    uint64 constant WINDOW = 60;
    uint64 constant CURE = 20;
    uint8 constant CONDITION_ID = 1;
    bytes32 constant SOURCE_ID = keccak256("COINBASE_ETH_USD_FEED");
    bytes32 constant PAYLOAD_REF = keccak256("payload-blob-v1");

    string constant LISTING_PHRASE = 'every record matches schema "pair,seq,priceE8"';
    string constant SCHEMA_DESCRIPTOR = "pair,seq,priceE8";

    /// @dev What the compiler emitted for LISTING_PHRASE before the rule was cut.
    ///      Its provenance is pinned by testCompilerThresholdWasTheDescriptorDigest.
    bytes32 constant COMPILED_THRESHOLD = 0x35c85c170c9a909295b7c25a9690421057bd79b78a59fd3515472c8c80d61a2f;

    uint256 constant N = 4;
    uint256 constant STALE_INDEX = 2;

    uint64 freshFloor;
    uint64 deliveryDeadline;
    bytes[] conforming;
    uint64[] generatedAt;

    function setUp() public {
        vm.warp(1_760_000_000);
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        upstream = vm.addr(UPSTREAM_PK);

        escrow = new RecourseEscrow();
        usdc = new MockUSDC();
        usdc.mint(buyer, 1_000_000_000);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);

        freshFloor = uint64(block.timestamp - 3600);
        deliveryDeadline = uint64(block.timestamp + 3600);

        // Rows the repo's own seller emits (agent/src/seller.ts buildDelivery).
        // Every one carries pair, seq and priceE8, so every one genuinely
        // conforms to the schema the listing phrase named.
        conforming.push(bytes('{"pair":"ETH-USD","seq":0,"priceE8":300000000000,"venue":"coinbase"}'));
        conforming.push(bytes('{"pair":"ETH-USD","seq":1,"priceE8":300000000137,"venue":"coinbase"}'));
        conforming.push(bytes('{"pair":"ETH-USD","seq":2,"priceE8":300000000274,"venue":"coinbase"}'));
        conforming.push(bytes('{"pair":"ETH-USD","seq":3,"priceE8":300000000411,"venue":"coinbase"}'));
        for (uint256 i = 0; i < N; i++) {
            generatedAt.push(i == STALE_INDEX ? uint64(block.timestamp - 86_400) : uint64(block.timestamp - 60));
        }
    }

    // ==================================================================
    // 1. The evidence. Kept because it is why the rule was cut.
    // ==================================================================

    /// @notice The literal above really is the digest of the descriptor string,
    ///         so the comparison below is the one the compiler actually set up.
    function testCompilerThresholdWasTheDescriptorDigest() public pure {
        assertEq(COMPILED_THRESHOLD, keccak256(bytes(SCHEMA_DESCRIPTOR)), "threshold was the descriptor digest");
    }

    /// @notice A schema threshold and a record digest are not comparable
    ///         quantities. No record that conforms to the schema satisfies the
    ///         predicate, and the only payload that does is the descriptor
    ///         string itself, which is not a record. That is what made every
    ///         honest row a counterexample.
    function testDescriptorDigestAndRecordDigestAreNotComparable() public view {
        for (uint256 i = 0; i < N; i++) {
            bytes32 observed = keccak256(conforming[i]);
            assertTrue(observed != COMPILED_THRESHOLD, "a conforming record never equals the descriptor digest");
            assertFalse(
                PredicateEvaluator.satisfied(Opcode.BYTES32_EQ, observed, COMPILED_THRESHOLD),
                "conforming record would have counted as a breach"
            );
        }

        assertTrue(
            PredicateEvaluator.satisfied(
                Opcode.BYTES32_EQ, keccak256(bytes(SCHEMA_DESCRIPTOR)), COMPILED_THRESHOLD
            ),
            "the only satisfying payload is the descriptor string, which is not a record"
        );
    }

    // ==================================================================
    // 2. The fix, at the open-time screen.
    // ==================================================================

    /// @notice A UNIVERSAL SCHEMA_HASH condition names a claim bound leaves do
    ///         not establish, so no escrow opens and no money moves.
    function testUniversalSchemaHashConditionIsRejectedAtOpen() public {
        (PurchaseTerms memory terms, bytes32 specHash, EvidenceOffer[] memory offers) =
            _schemaTerms(bytes32(uint256(1)), Quantifier.UNIVERSAL);

        vm.expectRevert(RecourseEscrow.UnsettleableUniversalCondition.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));

        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.NONE), "never opened");
        assertEq(usdc.balanceOf(address(escrow)), 0, "nothing escrowed");
    }

    /// @notice The scalar route is closed too: only ROW_COUNT names a quantity
    ///         the signed commitment carries.
    function testScalarSchemaHashConditionIsRejectedAtOpen() public {
        (PurchaseTerms memory terms, bytes32 specHash, EvidenceOffer[] memory offers) =
            _schemaTerms(bytes32(uint256(2)), Quantifier.SCALAR);

        vm.expectRevert(RecourseEscrow.UnsettleableScalarCondition.selector);
        escrow.openPurchase(terms, offers, _sign(BUYER_PK, specHash), _sign(SELLER_PK, specHash));

        assertEq(uint8(escrow.purchaseOf(specHash).state), uint8(RecourseEscrow.State.NONE), "never opened");
        assertEq(usdc.balanceOf(address(escrow)), 0, "nothing escrowed");
    }

    // ==================================================================
    // 3. The fix, at the settlement path. Defence in depth.
    // ==================================================================

    /// @notice Force the state the open-time screen prevents, then confirm the
    ///         breach path refuses the claim on its own account. Everything
    ///         ahead of the claim type check is made to pass, so the revert is
    ///         attributable to the claim type and to nothing else.
    function testSchemaHashCounterexampleIsRejectedOnTheBreachPath() public {
        // A real, openable purchase over the same delivery, on freshness.
        PurchaseTerms memory fresh = _freshnessTerms(bytes32(uint256(3)));
        bytes32 freshSpec = escrow.specHashOf(fresh);
        escrow.openPurchase(
            fresh, _offersFor(fresh.conditions), _sign(BUYER_PK, freshSpec), _sign(SELLER_PK, freshSpec)
        );
        bytes32[] memory leaves = _leaves();
        _commit(fresh, freshSpec, _rootOf(leaves));

        // The same terms, differing only in the claim. A distinct specHash.
        PurchaseTerms memory schema = _freshnessTerms(bytes32(uint256(3)));
        schema.conditions[0].requires = ClaimType.SCHEMA_HASH;
        schema.conditions[0].opcode = Opcode.BYTES32_EQ;
        schema.conditions[0].threshold = COMPILED_THRESHOLD;
        bytes32 schemaSpec = escrow.specHashOf(schema);
        assertTrue(schemaSpec != freshSpec, "distinct terms");

        _cloneSlots(_purchaseSlot(freshSpec), _purchaseSlot(schemaSpec));
        _cloneSlots(_commitmentSlot(freshSpec, CONDITION_ID), _commitmentSlot(schemaSpec, CONDITION_ID));
        // The clone still names the purchase it was signed for. Rebind it, or
        // settlement stops at binding and never reaches the claim type.
        vm.store(address(escrow), bytes32(uint256(_commitmentSlot(schemaSpec, CONDITION_ID)) + 1), schemaSpec);

        // Assert the fixture rather than trusting the layout.
        assertEq(uint8(escrow.purchaseOf(schemaSpec).state), uint8(RecourseEscrow.State.DELIVERED), "clone DELIVERED");
        assertEq(escrow.commitmentOf(schemaSpec, CONDITION_ID).specHash, schemaSpec, "commitment rebound");
        assertEq(escrow.commitmentOf(schemaSpec, CONDITION_ID).merkleRoot, _rootOf(leaves), "root cloned");
        assertEq(escrow.commitmentOf(schemaSpec, CONDITION_ID).issuer, upstream, "issuer cloned");
        assertEq(escrow.commitmentOf(schemaSpec, CONDITION_ID).leafCount, uint64(N), "leafCount cloned");

        // Index 0 conforms to the schema. Before the fix this settled.
        vm.expectRevert(RecourseEscrow.ClaimNotEstablishedByBoundLeaves.selector);
        escrow.submitBreachProof(schema, 0, _proofFor(schemaSpec, leaves, 0));

        // The fixture was sound: the same delivery really does breach freshness
        // at STALE_INDEX, and that proof settles against the untouched purchase.
        escrow.submitBreachProof(fresh, 0, _proofFor(freshSpec, leaves, STALE_INDEX));
        assertEq(uint8(escrow.purchaseOf(freshSpec).state), uint8(RecourseEscrow.State.REFUNDED), "control settles");
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    function _baseTerms(bytes32 purchaseId, Condition[] memory cs) internal view returns (PurchaseTerms memory) {
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

    function _schemaTerms(bytes32 purchaseId, Quantifier q)
        internal
        view
        returns (PurchaseTerms memory terms, bytes32 specHash, EvidenceOffer[] memory offers)
    {
        Condition[] memory cs = new Condition[](1);
        cs[0] = Condition({
            conditionId: CONDITION_ID,
            requires: ClaimType.SCHEMA_HASH,
            quantifier: q,
            opcode: Opcode.BYTES32_EQ,
            threshold: COMPILED_THRESHOLD,
            permittedIssuer: upstream,
            expectedSourceId: SOURCE_ID,
            sourceQuote: LISTING_PHRASE
        });
        terms = _baseTerms(purchaseId, cs);
        specHash = escrow.specHashOf(terms);
        offers = _offersFor(cs);
    }

    function _freshnessTerms(bytes32 purchaseId) internal view returns (PurchaseTerms memory) {
        Condition[] memory cs = new Condition[](1);
        cs[0] = Condition({
            conditionId: CONDITION_ID,
            requires: ClaimType.RECORD_GENERATION_TIME,
            quantifier: Quantifier.UNIVERSAL,
            opcode: Opcode.TIMESTAMP_GTE,
            threshold: bytes32(uint256(freshFloor)),
            permittedIssuer: upstream,
            expectedSourceId: SOURCE_ID,
            sourceQuote: "every record generated within the last hour"
        });
        return _baseTerms(purchaseId, cs);
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

    function _commit(PurchaseTerms memory terms, bytes32 specHash, bytes32 root) internal {
        DeliveryCommitment memory c = DeliveryCommitment({
            specHash: specHash,
            conditionId: CONDITION_ID,
            merkleRoot: root,
            leafCount: uint64(N),
            sourceId: SOURCE_ID,
            payloadRef: PAYLOAD_REF
        });
        escrow.submitDeliveryCommitment(terms, 0, c, _sign(UPSTREAM_PK, escrow.commitmentDigest(c)));
    }

    function _leaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](N);
        for (uint256 i = 0; i < N; i++) {
            leaves[i] = MerkleBreachVerifier.leafOf(i, keccak256(conforming[i]), generatedAt[i], SOURCE_ID);
        }
    }

    function _proofFor(bytes32 specHash, bytes32[] memory leaves, uint256 index)
        internal
        view
        returns (BreachProof memory)
    {
        return BreachProof({
            specHash: specHash,
            conditionId: CONDITION_ID,
            index: index,
            recordBytes: conforming[index],
            generatedAt: generatedAt[index],
            sourceId: SOURCE_ID,
            merklePath: _pathFor(leaves, index)
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _purchaseSlot(bytes32 specHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(specHash, uint256(0)));
    }

    function _commitmentSlot(bytes32 specHash, uint8 conditionId) internal pure returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(specHash, uint256(1)));
        return keccak256(abi.encode(uint256(conditionId), inner));
    }

    /// @dev Copies a generous span rather than an exact struct width, so a field
    ///      reorder cannot silently invalidate the fixture. Asserted through the
    ///      public getters by the caller.
    function _cloneSlots(bytes32 fromBase, bytes32 toBase) internal {
        for (uint256 i = 0; i < 8; i++) {
            vm.store(
                address(escrow),
                bytes32(uint256(toBase) + i),
                vm.load(address(escrow), bytes32(uint256(fromBase) + i))
            );
        }
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
