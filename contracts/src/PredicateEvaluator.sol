// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The complete opcode set. It never grows to fit a term.
///         A term that cannot be expressed here is UNPROTECTABLE, which is a
///         normal outcome and not an error.
enum Opcode {
    UINT_GTE,
    UINT_EQ,
    TIMESTAMP_GTE,
    BYTES32_EQ
}

/// @title PredicateEvaluator
/// @notice Total, pure evaluation of a single observation against a single
///         threshold. No interpretation, no dynamic dispatch, no strings.
library PredicateEvaluator {
    /// @return true if the observation SATISFIES the predicate.
    ///         The caller is responsible for asserting the negation when it is
    ///         looking for a violation.
    function satisfied(Opcode op, bytes32 observed, bytes32 threshold) internal pure returns (bool) {
        if (op == Opcode.UINT_GTE) {
            return uint256(observed) >= uint256(threshold);
        }
        if (op == Opcode.UINT_EQ) {
            return uint256(observed) == uint256(threshold);
        }
        if (op == Opcode.TIMESTAMP_GTE) {
            // Distinct from UINT_GTE by the units it declares, not by its arithmetic.
            // Keeping them separate is what lets a term compiler refuse to emit a
            // time comparison for a quantity, and vice versa.
            return uint256(observed) >= uint256(threshold);
        }
        // Opcode.BYTES32_EQ
        return observed == threshold;
    }
}
