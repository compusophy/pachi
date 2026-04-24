// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDiamondCut {
    enum FacetCutAction { Add, Replace, Remove }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    /// @notice Add/replace/remove facet selectors and optionally `delegatecall` an init function.
    /// @param _diamondCut Cuts to apply.
    /// @param _init Address whose function will be `delegatecall`ed for init (zero = no init).
    /// @param _calldata abi-encoded call to make on `_init` after the cut.
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external;

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);
}
