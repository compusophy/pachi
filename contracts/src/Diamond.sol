// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibDiamond } from "./diamond/LibDiamond.sol";
import { IDiamondCut } from "./diamond/IDiamondCut.sol";

/// @title Pachi Diamond proxy
/// @notice EIP-2535 proxy. delegatecalls to whichever facet implements the
/// called selector. The diamond contract itself is bootstrapped with just
/// `diamondCut` from DiamondCutFacet so that subsequent cuts can wire up
/// every other facet.
contract Diamond {
    constructor(address _owner, address _diamondCutFacet) payable {
        LibDiamond.setContractOwner(_owner);

        // Bootstrap: install the cut facet's `diamondCut` selector so that
        // `diamondCut` itself can be called on the diamond from this point on.
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = IDiamondCut.diamondCut.selector;
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: _diamondCutFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        LibDiamond.diamondCut(cut, address(0), "");
    }

    /// @notice Route every other call to the facet that implements its selector.
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        require(facet != address(0), "Diamond: function does not exist");
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
