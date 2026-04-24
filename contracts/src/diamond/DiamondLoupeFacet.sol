// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IDiamondLoupe } from "./IDiamondLoupe.sol";
import { LibDiamond } from "./LibDiamond.sol";

contract DiamondLoupeFacet is IDiamondLoupe {
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 n = ds.facetAddresses.length;
        facets_ = new Facet[](n);
        for (uint256 i; i < n; i++) {
            address f = ds.facetAddresses[i];
            facets_[i] = Facet({
                facetAddress: f,
                functionSelectors: ds.facetFunctionSelectors[f].functionSelectors
            });
        }
    }

    function facetFunctionSelectors(address _facet) external view override returns (bytes4[] memory) {
        return LibDiamond.diamondStorage().facetFunctionSelectors[_facet].functionSelectors;
    }

    function facetAddresses() external view override returns (address[] memory) {
        return LibDiamond.diamondStorage().facetAddresses;
    }

    function facetAddress(bytes4 _selector) external view override returns (address) {
        return LibDiamond.diamondStorage().selectorToFacetAndPosition[_selector].facetAddress;
    }
}
