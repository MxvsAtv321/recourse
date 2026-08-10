// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MerkleBreachVerifier
/// @notice Leaf reconstruction and inclusion checking for a single counterexample.
///
///         There is no iteration over records anywhere in this library. The only
///         loop walks the O(log n) authentication path of ONE leaf, which is what
///         makes universal claims enforceable without on-chain iteration.
library MerkleBreachVerifier {
    /// @notice The leaf binds content to timestamp in a single preimage.
    ///
    ///         A tree built over bare timestamps proves only that some timestamp
    ///         appeared in some tree, which permits pairing a fresh timestamp with
    ///         stale content. Binding index, content hash, generation time and
    ///         source into one leaf removes that freedom.
    function leafOf(uint256 index, bytes32 recordHash, uint64 generatedAt, bytes32 sourceId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(index, recordHash, generatedAt, sourceId));
    }

    /// @notice Sorted-pair inclusion check. Position is already bound inside the
    ///         leaf preimage by `index`, so ordering bits are not needed.
    function verifyInclusion(bytes32[] calldata path, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < path.length; i++) {
            bytes32 sibling = path[i];
            node = node < sibling ? _hashPair(node, sibling) : _hashPair(sibling, node);
        }
        return node == root;
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32 out) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            out := keccak256(0x00, 0x40)
        }
    }
}
