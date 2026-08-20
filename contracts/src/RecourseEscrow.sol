// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Opcode, PredicateEvaluator} from "./PredicateEvaluator.sol";
import {MerkleBreachVerifier} from "./MerkleBreachVerifier.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice What a condition demands be established.
enum ClaimType {
    ROW_COUNT,
    SCHEMA_HASH,
    RECORD_GENERATION_TIME,
    BLOB_EXISTENCE_TIME
}

/// @notice SCALAR holds once for the delivery. UNIVERSAL holds for every record,
///         and is enforced by counterexample, never by on-chain iteration.
enum Quantifier {
    SCALAR,
    UNIVERSAL
}

struct Condition {
    uint8 conditionId;
    ClaimType requires;
    Quantifier quantifier;
    Opcode opcode;
    bytes32 threshold;
    address permittedIssuer;
    bytes32 expectedSourceId;
    string sourceQuote;
}

struct PurchaseTerms {
    bytes32 purchaseId;
    address buyer;
    address seller;
    uint256 amount;
    address asset;
    Condition[] conditions;
    uint64 challengeWindow;
    /// @notice Absolute timestamp by which every condition must be committed.
    ///         Past it, an undelivered purchase is reclaimable by the buyer.
    ///         Non-delivery is the trivial breach.
    uint64 deliveryDeadline;
    /// @notice How long the seller has to answer an availability challenge.
    ///         Signed by both parties, like every other term.
    uint64 curePeriod;
}

/// @notice What the seller's evidence actually proves, as opposed to what the
///         condition needs proved. Both sides of the comparison must exist.
struct EvidenceOffer {
    uint8 conditionId;
    ClaimType establishes;
    address issuer;
}

struct DeliveryCommitment {
    bytes32 specHash;
    uint8 conditionId;
    bytes32 merkleRoot;
    /// @notice How many leaves the committed tree holds. Inside the signed
    ///         struct, so the issuer is bound to it exactly as it is bound to
    ///         the root. This is what lets a scalar row count settle directly.
    uint64 leafCount;
    bytes32 sourceId;
    /// @notice Content address of the committed payload: the digest of the
    ///         delivered file. Inside the signed struct, so the issuer binds
    ///         the bytes it is attesting to and not merely their tree.
    bytes32 payloadRef;
}

/// @notice One leaf, opened. This is what answering an availability challenge
///         costs: the same shape a counterexample takes, minus the accusation.
struct PayloadOpening {
    uint8 conditionId;
    uint256 index;
    bytes recordBytes;
    uint64 generatedAt;
    bytes32 sourceId;
    bytes32[] merklePath;
}

struct BreachProof {
    bytes32 specHash;
    uint8 conditionId;
    uint256 index;
    bytes recordBytes;
    uint64 generatedAt;
    bytes32 sourceId;
    bytes32[] merklePath;
}

/// @title RecourseEscrow
/// @notice Optimistic settlement for autonomous commerce. Funds release to the
///         seller after a challenge window unless somebody submits one
///         cryptographic counterexample that disproves a fulfilment claim.
///         There is no arbiter and no model call on this path.
contract RecourseEscrow {
    using PredicateEvaluator for Opcode;

    enum State {
        NONE,
        OPEN,
        DELIVERED,
        RELEASED,
        REFUNDED,
        RECLAIMED
    }

    enum Verdict {
        RELEASE,
        BREACH_PROVED,
        RECLAIM,
        WITHHELD
    }

    struct Purchase {
        address buyer;
        address seller;
        address asset;
        uint256 amount;
        uint64 challengeWindow;
        uint64 deliveryDeadline;
        uint64 deliveredAt;
        uint8 conditionCount;
        uint8 committedCount;
        uint8 availabilityRaised;
        State state;
    }

    /// @dev At most one open at a time. Committing a root is cheap; producing a
    ///      leaf on demand is not, unless you actually hold the payload.
    struct Availability {
        bool open;
        uint8 conditionId;
        uint64 raisedAt;
        uint256 index;
    }

    /// @dev The stored, signed commitment. `specHash` and `conditionId` are held
    ///      explicitly rather than only as mapping keys so that the breach path
    ///      can check binding as its own step instead of inheriting it.
    struct StoredCommitment {
        bool exists;
        uint8 conditionId;
        uint64 leafCount;
        bytes32 specHash;
        bytes32 merkleRoot;
        bytes32 sourceId;
        bytes32 payloadRef;
        address issuer; // recovered from the signature, never supplied
    }

    /// @dev Bounds buyer griefing. Each challenge costs the seller one answer
    ///      and pauses the clock, so the count cannot be open ended.
    uint8 private constant MAX_AVAILABILITY_CHALLENGES = 3;

    bytes32 private constant CONDITION_TYPEHASH = keccak256(
        "Condition(uint8 conditionId,uint8 requires,uint8 quantifier,uint8 opcode,bytes32 threshold,address permittedIssuer,bytes32 expectedSourceId,string sourceQuote)"
    );

    bytes32 private constant PURCHASE_TERMS_TYPEHASH = keccak256(
        "PurchaseTerms(bytes32 purchaseId,address buyer,address seller,uint256 amount,address asset,Condition[] conditions,uint64 challengeWindow,uint64 deliveryDeadline,uint64 curePeriod)Condition(uint8 conditionId,uint8 requires,uint8 quantifier,uint8 opcode,bytes32 threshold,address permittedIssuer,bytes32 expectedSourceId,string sourceQuote)"
    );

    bytes32 private constant DELIVERY_COMMITMENT_TYPEHASH =
        keccak256(
            "DeliveryCommitment(bytes32 specHash,uint8 conditionId,bytes32 merkleRoot,uint64 leafCount,bytes32 sourceId,bytes32 payloadRef)"
        );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private immutable _domainSeparator;

    mapping(bytes32 => Purchase) private _purchases;
    mapping(bytes32 => mapping(uint8 => StoredCommitment)) private _commitments;
    mapping(bytes32 => Availability) private _availability;

    event PurchaseOpened(bytes32 indexed specHash, address indexed buyer, address indexed seller, uint256 amount);
    event DeliveryCommitted(bytes32 indexed specHash, uint8 indexed conditionId, bytes32 merkleRoot, address issuer);
    event Settled(bytes32 indexed specHash, Verdict verdict, address indexed paidTo, uint256 amount);
    event BreachProved(bytes32 indexed specHash, uint8 indexed conditionId, uint256 offendingIndex);
    event ScalarConditionFailed(bytes32 indexed specHash, uint8 indexed conditionId, bytes32 observed, bytes32 threshold);
    event AvailabilityChallenged(bytes32 indexed specHash, uint8 indexed conditionId, uint256 index, uint64 curePeriodEnds);
    event AvailabilityAnswered(
        bytes32 indexed specHash, uint8 indexed conditionId, uint256 index, bytes recordBytes, uint64 generatedAt
    );
    event Reclaimed(bytes32 indexed specHash, address indexed buyer, uint8 committed, uint8 required);

    error PurchaseExists();
    error UnknownPurchase();
    error WrongState();
    error NoConditions();
    error OfferCountMismatch();
    error OfferConditionMismatch();
    error ClaimTypeMismatch();
    error IssuerNotPermittedForOffer();
    error BadBuyerSignature();
    error BadSellerSignature();
    error BadSignatureLength();
    error MalleableSignature();
    error CommitmentSpecMismatch();
    error CommitmentConditionMismatch();
    error CommitmentExists();
    error NoCommitment();
    error UnpermittedIssuer();
    error SourceIdMismatch();
    error SpecMismatch();
    error ConditionIdMismatch();
    error MerkleInclusionFailed();
    error NotUniversal();
    error ClaimNotEstablishedByBoundLeaves();
    error ConditionNotViolated();
    error ChallengeWindowOpen();
    error ChallengeWindowClosed();
    error TransferFailed();
    error DuplicateConditionId();
    error DeadlineInPast();
    error DeliveryDeadlineNotReached();
    error ZeroLeafCount();
    error LeafIndexBeyondCommittedCount();
    error UnsettleableScalarCondition();
    error UnsettleableUniversalCondition();
    error ZeroAddressSignature();
    error ZeroPayloadRef();
    error ZeroAmount();
    error AssetNotAContract();
    error ZeroCurePeriod();
    error NotBuyer();
    error AvailabilityChallengeOpen();
    error NoAvailabilityChallenge();
    error TooManyAvailabilityChallenges();
    error CurePeriodExpired();
    error CurePeriodRunning();
    error OpeningIndexMismatch();
    error OpeningConditionMismatch();

    constructor() {
        _domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Recourse"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ------------------------------------------------------------------
    // Hashing. specHash is derived, never a field.
    // ------------------------------------------------------------------

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function hashCondition(Condition calldata c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONDITION_TYPEHASH,
                c.conditionId,
                uint8(c.requires),
                uint8(c.quantifier),
                uint8(c.opcode),
                c.threshold,
                c.permittedIssuer,
                c.expectedSourceId,
                keccak256(bytes(c.sourceQuote))
            )
        );
    }

    /// @notice EIP-712 digest of the terms both parties signed. This is the
    ///         purchase key. Terms valid for one purchase cannot move to another.
    function specHashOf(PurchaseTerms calldata terms) public view returns (bytes32) {
        // Loop over conditions, which is the agreement. Never over records.
        bytes32[] memory conditionHashes = new bytes32[](terms.conditions.length);
        for (uint256 i = 0; i < terms.conditions.length; i++) {
            conditionHashes[i] = hashCondition(terms.conditions[i]);
        }
        bytes32 structHash = keccak256(
            abi.encode(
                PURCHASE_TERMS_TYPEHASH,
                terms.purchaseId,
                terms.buyer,
                terms.seller,
                terms.amount,
                terms.asset,
                keccak256(abi.encodePacked(conditionHashes)),
                terms.challengeWindow,
                terms.deliveryDeadline,
                terms.curePeriod
            )
        );
        return _typed(structHash);
    }

    function commitmentDigest(DeliveryCommitment calldata c) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    DELIVERY_COMMITMENT_TYPEHASH,
                    c.specHash,
                    c.conditionId,
                    c.merkleRoot,
                    c.leafCount,
                    c.sourceId,
                    c.payloadRef
                )
            )
        );
    }

    function _typed(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    // ------------------------------------------------------------------
    // 1. Open. Evidence is screened before any money moves.
    // ------------------------------------------------------------------

    /// @notice Verifies both signatures over these exact terms, screens every
    ///         evidence offer against the claim its condition requires, then
    ///         escrows the amount. Rejection here is pre-payment.
    function openPurchase(
        PurchaseTerms calldata terms,
        EvidenceOffer[] calldata offers,
        bytes calldata buyerSig,
        bytes calldata sellerSig
    ) external returns (bytes32 specHash) {
        uint256 n = terms.conditions.length;
        if (n == 0 || n > type(uint8).max) revert NoConditions();
        if (offers.length != n) revert OfferCountMismatch();

        specHash = specHashOf(terms);
        if (_purchases[specHash].state != State.NONE) revert PurchaseExists();

        // Signatures are checked against the digest of THESE terms, so a
        // signature produced for another purchase recovers to a stranger.
        if (_recover(specHash, buyerSig) != terms.buyer) revert BadBuyerSignature();
        if (_recover(specHash, sellerSig) != terms.seller) revert BadSellerSignature();

        if (terms.deliveryDeadline <= block.timestamp) revert DeadlineInPast();
        if (terms.curePeriod == 0) revert ZeroCurePeriod();
        if (terms.amount == 0) revert ZeroAmount();
        // A call to an address with no code returns success with empty returndata,
        // and empty returndata is exactly what the no-return-value branch in _pull
        // accepts. Without this the escrow would record itself as funded having
        // moved nothing.
        if (terms.asset.code.length == 0) revert AssetNotAContract();

        // Each conditionId keys one commitment slot. Duplicates would collide, the
        // second commitment would revert, and the purchase could never reach
        // DELIVERED. A 256 bit set covers the whole uint8 id space in one word.
        uint256 seenIds;

        for (uint256 i = 0; i < n; i++) {
            Condition calldata c = terms.conditions[i];
            EvidenceOffer calldata o = offers[i];
            if (o.conditionId != c.conditionId) revert OfferConditionMismatch();
            // The whole point: authentic evidence for the wrong claim is refused.
            if (o.establishes != c.requires) revert ClaimTypeMismatch();
            if (o.issuer != c.permittedIssuer) revert IssuerNotPermittedForOffer();

            uint256 bit = 1 << c.conditionId;
            if (seenIds & bit != 0) revert DuplicateConditionId();
            seenIds |= bit;

            // A scalar condition settles by direct evaluation at release, so it
            // must name something the signed commitment actually carries. Refuse
            // to escrow against a scalar promise that could never be evaluated.
            if (c.quantifier == Quantifier.SCALAR && !_scalarSettleable(c.requires, c.opcode)) {
                revert UnsettleableScalarCondition();
            }

            // A universal condition settles only by counterexample, and a
            // counterexample can speak only to what the bound leaves carry.
            // Without this, a universal claim over something the leaves cannot
            // establish would open an escrow no proof could ever settle, and it
            // would always release: an unprotectable purchase wearing a
            // protected label.
            if (c.quantifier == Quantifier.UNIVERSAL && !_establishedByBoundLeaves(c.requires)) {
                revert UnsettleableUniversalCondition();
            }
        }

        _purchases[specHash] = Purchase({
            buyer: terms.buyer,
            seller: terms.seller,
            asset: terms.asset,
            amount: terms.amount,
            challengeWindow: terms.challengeWindow,
            deliveryDeadline: terms.deliveryDeadline,
            deliveredAt: 0,
            conditionCount: uint8(n),
            committedCount: 0,
            availabilityRaised: 0,
            state: State.OPEN
        });

        _pull(terms.asset, terms.buyer, terms.amount);
        emit PurchaseOpened(specHash, terms.buyer, terms.seller, terms.amount);
    }

    // ------------------------------------------------------------------
    // 2. Deliver. The upstream issuer signs a commitment bound to this purchase.
    // ------------------------------------------------------------------

    /// @notice Stores a signed DeliveryCommitment. The signed object binds the
    ///         purchase and the obligation, so a valid signature from purchase A
    ///         cannot be replayed against purchase B.
    function submitDeliveryCommitment(
        PurchaseTerms calldata terms,
        uint256 conditionIndex,
        DeliveryCommitment calldata commitment,
        bytes calldata issuerSig
    ) external {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.OPEN) revert WrongState();

        Condition calldata c = terms.conditions[conditionIndex];
        if (commitment.specHash != specHash) revert CommitmentSpecMismatch();
        if (commitment.conditionId != c.conditionId) revert CommitmentConditionMismatch();

        address issuer = _recover(commitmentDigest(commitment), issuerSig);
        if (issuer != c.permittedIssuer) revert UnpermittedIssuer();
        if (commitment.sourceId != c.expectedSourceId) revert SourceIdMismatch();
        if (commitment.leafCount == 0) revert ZeroLeafCount();
        if (commitment.payloadRef == bytes32(0)) revert ZeroPayloadRef();

        StoredCommitment storage sc = _commitments[specHash][commitment.conditionId];
        if (sc.exists) revert CommitmentExists();

        sc.exists = true;
        sc.conditionId = commitment.conditionId;
        sc.specHash = commitment.specHash;
        sc.merkleRoot = commitment.merkleRoot;
        sc.leafCount = commitment.leafCount;
        sc.sourceId = commitment.sourceId;
        sc.payloadRef = commitment.payloadRef;
        sc.issuer = issuer;

        p.committedCount += 1;
        if (p.committedCount == p.conditionCount) {
            p.deliveredAt = uint64(block.timestamp);
            p.state = State.DELIVERED;
        }
        emit DeliveryCommitted(specHash, commitment.conditionId, commitment.merkleRoot, issuer);
    }

    // ------------------------------------------------------------------
    // 3a. Settle by non-delivery. The trivial breach.
    // ------------------------------------------------------------------

    /// @notice Refunds the buyer in full once the delivery deadline has passed
    ///         without the purchase reaching DELIVERED. This covers the seller
    ///         never committing and the seller committing some conditions but
    ///         not all, because the purchase only leaves OPEN when every
    ///         condition has a stored commitment.
    function reclaim(PurchaseTerms calldata terms) external {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.OPEN) revert WrongState();
        if (block.timestamp < p.deliveryDeadline) revert DeliveryDeadlineNotReached();

        p.state = State.RECLAIMED;
        _push(p.asset, p.buyer, p.amount);
        emit Reclaimed(specHash, p.buyer, p.committedCount, p.conditionCount);
        emit Settled(specHash, Verdict.RECLAIM, p.buyer, p.amount);
    }

    // ------------------------------------------------------------------
    // 3b. Availability. Committing a root is not delivering a payload.
    // ------------------------------------------------------------------

    /// @notice The buyer names one leaf it cannot obtain. Committing a root is
    ///         cheap and says nothing about whether the payload was ever sent,
    ///         so without this a seller could commit, send nothing, wait out the
    ///         window and collect. Release is paused until this is answered.
    function raiseAvailabilityChallenge(PurchaseTerms calldata terms, uint256 conditionIndex, uint256 index)
        external
    {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.DELIVERED) revert WrongState();
        if (msg.sender != p.buyer) revert NotBuyer();
        if (block.timestamp >= uint256(p.deliveredAt) + uint256(p.challengeWindow)) revert ChallengeWindowClosed();

        Availability storage a = _availability[specHash];
        if (a.open) revert AvailabilityChallengeOpen();
        if (p.availabilityRaised >= MAX_AVAILABILITY_CHALLENGES) revert TooManyAvailabilityChallenges();

        Condition calldata c = terms.conditions[conditionIndex];
        StoredCommitment storage sc = _commitments[specHash][c.conditionId];
        if (!sc.exists) revert NoCommitment();
        if (index >= uint256(sc.leafCount)) revert LeafIndexBeyondCommittedCount();

        a.open = true;
        a.conditionId = c.conditionId;
        a.raisedAt = uint64(block.timestamp);
        a.index = index;
        p.availabilityRaised += 1;

        emit AvailabilityChallenged(specHash, c.conditionId, index, uint64(block.timestamp) + terms.curePeriod);
    }

    /// @notice Anyone holding the payload may answer, because availability is a
    ///         property of the payload and not of who is speaking. The opening
    ///         is the same shape as a counterexample, minus the accusation, and
    ///         it is emitted in full: answering hands the buyer exactly the bytes
    ///         a breach proof needs.
    function answerAvailabilityChallenge(
        PurchaseTerms calldata terms,
        uint256 conditionIndex,
        PayloadOpening calldata opening
    ) external {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.DELIVERED) revert WrongState();

        Availability storage a = _availability[specHash];
        if (!a.open) revert NoAvailabilityChallenge();
        if (block.timestamp >= uint256(a.raisedAt) + uint256(terms.curePeriod)) revert CurePeriodExpired();

        Condition calldata c = terms.conditions[conditionIndex];
        if (c.conditionId != a.conditionId || opening.conditionId != a.conditionId) {
            revert OpeningConditionMismatch();
        }
        if (opening.index != a.index) revert OpeningIndexMismatch();
        if (opening.sourceId != c.expectedSourceId) revert SourceIdMismatch();

        StoredCommitment storage sc = _commitments[specHash][a.conditionId];
        bytes32 leaf = MerkleBreachVerifier.leafOf(
            opening.index, keccak256(opening.recordBytes), opening.generatedAt, opening.sourceId
        );
        if (!MerkleBreachVerifier.verifyInclusion(opening.merklePath, sc.merkleRoot, leaf)) {
            revert MerkleInclusionFailed();
        }

        // The clock resumes where it paused, so a frivolous challenge costs the
        // buyer gas and buys it no extra time.
        p.deliveredAt = uint64(uint256(p.deliveredAt) + (block.timestamp - uint256(a.raisedAt)));
        a.open = false;

        emit AvailabilityAnswered(specHash, a.conditionId, opening.index, opening.recordBytes, opening.generatedAt);
    }

    /// @notice The cure period lapsed with no opening produced. A seller that
    ///         cannot open one leaf of its own committed tree did not deliver.
    function claimWithheld(PurchaseTerms calldata terms) external {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.DELIVERED) revert WrongState();

        Availability storage a = _availability[specHash];
        if (!a.open) revert NoAvailabilityChallenge();
        if (block.timestamp < uint256(a.raisedAt) + uint256(terms.curePeriod)) revert CurePeriodRunning();

        a.open = false;
        p.state = State.REFUNDED;
        _push(p.asset, p.buyer, p.amount);
        emit Settled(specHash, Verdict.WITHHELD, p.buyer, p.amount);
    }

    // ------------------------------------------------------------------
    // 3b. Settle by silence, after evaluating the scalar claims.
    // ------------------------------------------------------------------

    function release(PurchaseTerms calldata terms) external {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.DELIVERED) revert WrongState();
        if (_availability[specHash].open) revert AvailabilityChallengeOpen();
        if (block.timestamp < uint256(p.deliveredAt) + uint256(p.challengeWindow)) revert ChallengeWindowOpen();

        // Scalar claims are not counterexample shaped. One row cannot disprove
        // "at least 500 rows". They are evaluated directly against the count the
        // issuer signed. This loop walks conditions, never records.
        uint256 n = terms.conditions.length;
        for (uint256 i = 0; i < n; i++) {
            Condition calldata c = terms.conditions[i];
            if (c.quantifier != Quantifier.SCALAR) continue;
            StoredCommitment storage sc = _commitments[specHash][c.conditionId];
            if (!sc.exists) revert NoCommitment();
            if (sc.issuer != c.permittedIssuer) revert UnpermittedIssuer();
            if (sc.sourceId != c.expectedSourceId) revert SourceIdMismatch();

            bytes32 observed = _scalarObserved(c.requires, sc);
            if (!PredicateEvaluator.satisfied(c.opcode, observed, c.threshold)) {
                p.state = State.REFUNDED;
                _push(p.asset, p.buyer, p.amount);
                emit ScalarConditionFailed(specHash, c.conditionId, observed, c.threshold);
                emit Settled(specHash, Verdict.BREACH_PROVED, p.buyer, p.amount);
                return;
            }
        }

        p.state = State.RELEASED;
        _push(p.asset, p.seller, p.amount);
        emit Settled(specHash, Verdict.RELEASE, p.seller, p.amount);
    }

    // ------------------------------------------------------------------
    // 3b. Settle by counterexample.
    // ------------------------------------------------------------------

    /// @notice One violating record reverses settlement. Every check below is a
    ///         revert, not a status code. There is no partial success.
    function submitBreachProof(PurchaseTerms calldata terms, uint256 conditionIndex, BreachProof calldata proof)
        external
    {
        bytes32 specHash = specHashOf(terms);
        Purchase storage p = _purchases[specHash];
        if (p.state == State.NONE) revert UnknownPurchase();
        if (p.state != State.DELIVERED) revert WrongState();
        if (block.timestamp >= uint256(p.deliveredAt) + uint256(p.challengeWindow)) revert ChallengeWindowClosed();
        if (proof.specHash != specHash) revert SpecMismatch();

        Condition calldata c = terms.conditions[conditionIndex];
        if (proof.conditionId != c.conditionId) revert ConditionIdMismatch();

        StoredCommitment storage sc = _commitments[specHash][proof.conditionId];
        if (!sc.exists) revert NoCommitment();

        // 1. Recompute the leaf from the proof's own inputs. Content hash and
        //    generation time enter the same preimage, so a fresh timestamp cannot
        //    be paired with stale content.
        bytes32 leaf =
            MerkleBreachVerifier.leafOf(proof.index, keccak256(proof.recordBytes), proof.generatedAt, proof.sourceId);

        // 2. Inclusion against the root inside the stored, signed commitment.
        //    The root is never supplied alongside the proof.
        if (!MerkleBreachVerifier.verifyInclusion(proof.merklePath, sc.merkleRoot, leaf)) {
            revert MerkleInclusionFailed();
        }

        // 2b. The counterexample must sit inside the delivery the issuer counted.
        //     A leaf at an index the commitment does not claim to hold is not
        //     part of this delivery, whatever the path says.
        if (proof.index >= uint256(sc.leafCount)) revert LeafIndexBeyondCommittedCount();

        // 3. That commitment is bound to this purchase and this obligation.
        if (sc.specHash != specHash) revert CommitmentSpecMismatch();
        if (sc.conditionId != c.conditionId) revert CommitmentConditionMismatch();

        // 4. The recovered commitment signer is the permitted issuer, as an address.
        if (sc.issuer != c.permittedIssuer) revert UnpermittedIssuer();

        // 5. The leaf's semantic origin is the expected one, as bytes32.
        if (proof.sourceId != c.expectedSourceId) revert SourceIdMismatch();

        // 6. A commitment over bound leaves establishes per-record claims only.
        //    It says nothing about when the delivered file existed, and it is not
        //    a count of the delivery.
        if (!_establishedByBoundLeaves(c.requires)) revert ClaimNotEstablishedByBoundLeaves();

        // 7. Universal claims fall to one counterexample. Confirm the predicate is
        //    VIOLATED, not merely that it evaluated.
        if (c.quantifier != Quantifier.UNIVERSAL) revert NotUniversal();
        bytes32 observed = _observed(c.requires, proof);
        if (PredicateEvaluator.satisfied(c.opcode, observed, c.threshold)) revert ConditionNotViolated();

        // 8. Refund in full and name the offending record.
        p.state = State.REFUNDED;
        _push(p.asset, p.buyer, p.amount);
        emit BreachProved(specHash, c.conditionId, proof.index);
        emit Settled(specHash, Verdict.BREACH_PROVED, p.buyer, p.amount);
    }

    // ------------------------------------------------------------------

    /// @dev A scalar claim settles by direct evaluation against the signed
    ///      commitment. The only quantity that commitment carries is the leaf
    ///      count, and only the two integer opcodes can compare it.
    function _scalarSettleable(ClaimType ct, Opcode op) private pure returns (bool) {
        return ct == ClaimType.ROW_COUNT && (op == Opcode.UINT_GTE || op == Opcode.UINT_EQ);
    }

    function _scalarObserved(ClaimType ct, StoredCommitment storage sc) private view returns (bytes32) {
        if (ct != ClaimType.ROW_COUNT) revert UnsettleableScalarCondition();
        return bytes32(uint256(sc.leafCount));
    }

    /// @dev The leaf carries a content hash and a generation time, but only the
    ///      generation time is a quantity a threshold can be compared against.
    ///
    ///      SCHEMA_HASH was removed. The leaf holds keccak256(recordBytes), the
    ///      digest of ONE RECORD, while a schema threshold is the digest of a
    ///      SHAPE. Comparing them under BYTES32_EQ made every record that
    ///      genuinely conformed to the schema a valid counterexample, so the
    ///      claim is refused at open rather than opened as protection that could
    ///      never hold. It stays in ClaimType because it remains a nameable
    ///      promise. It is simply not one this contract protects.
    function _establishedByBoundLeaves(ClaimType ct) private pure returns (bool) {
        return ct == ClaimType.RECORD_GENERATION_TIME;
    }

    /// @dev Reached only after _establishedByBoundLeaves has passed, so the
    ///      generation time is the sole observable. The guard is defence in
    ///      depth: it reverts rather than returning a value for a claim the
    ///      bound leaves do not establish.
    function _observed(ClaimType ct, BreachProof calldata proof) private pure returns (bytes32) {
        if (ct != ClaimType.RECORD_GENERATION_TIME) revert ClaimNotEstablishedByBoundLeaves();
        return bytes32(uint256(proof.generatedAt));
    }

    function purchaseOf(bytes32 specHash) external view returns (Purchase memory) {
        return _purchases[specHash];
    }

    function availabilityOf(bytes32 specHash) external view returns (Availability memory) {
        return _availability[specHash];
    }

    function commitmentOf(bytes32 specHash, uint8 conditionId) external view returns (StoredCommitment memory) {
        return _commitments[specHash][conditionId];
    }

    function _pull(address asset, address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            asset.call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignatureLength();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert MalleableSignature();
        }
        // ecrecover yields address(0) on a malformed v. Without this guard a
        // condition naming permittedIssuer = address(0) would accept any garbage
        // signature, for the buyer, the seller and the issuer alike.
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert ZeroAddressSignature();
        return signer;
    }
}
