// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IDiamondCut } from "./IDiamondCut.sol";

/// @title LibDiamond
/// @notice Diamond storage + selector → facet routing + cut logic.
/// Adapted from mudgen/diamond-3 reference. Single AppStorage slot per
/// concern (here just "diamond.standard.storage" for the routing table).
/// User app data lives in a separate library (e.g., LibPachi) at its own slot.
library LibDiamond {
    bytes32 constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.storage");

    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition;   // index in facetFunctionSelectors[facet]
    }

    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition;      // index in facetAddresses
    }

    struct DiamondStorage {
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        address[] facetAddresses;
        mapping(bytes4 => bool) supportedInterfaces;
        address contractOwner;
    }

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly { ds.slot := position }
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        address previousOwner = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previousOwner, _newOwner);
    }

    function contractOwner() internal view returns (address) {
        return diamondStorage().contractOwner;
    }

    function enforceIsContractOwner() internal view {
        require(msg.sender == diamondStorage().contractOwner, "LibDiamond: not owner");
    }

    event DiamondCut(IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata);

    function diamondCut(
        IDiamondCut.FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    ) internal {
        for (uint256 i; i < _diamondCut.length; i++) {
            IDiamondCut.FacetCutAction action = _diamondCut[i].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else {
                revert("LibDiamond: bad cut action");
            }
        }
        emit DiamondCut(_diamondCut, _init, _calldata);
        initializeDiamondCut(_init, _calldata);
    }

    function addFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        require(_functionSelectors.length > 0, "LibDiamond: no selectors in cut");
        require(_facetAddress != address(0), "LibDiamond: Add facet can't be zero");
        DiamondStorage storage ds = diamondStorage();
        uint96 selectorPosition = uint96(ds.facetFunctionSelectors[_facetAddress].functionSelectors.length);
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (uint256 i; i < _functionSelectors.length; i++) {
            bytes4 selector = _functionSelectors[i];
            address oldFacet = ds.selectorToFacetAndPosition[selector].facetAddress;
            require(oldFacet == address(0), "LibDiamond: selector exists; use Replace");
            addFunction(ds, selector, selectorPosition, _facetAddress);
            selectorPosition++;
        }
    }

    function replaceFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        require(_functionSelectors.length > 0, "LibDiamond: no selectors in cut");
        require(_facetAddress != address(0), "LibDiamond: Replace facet can't be zero");
        DiamondStorage storage ds = diamondStorage();
        uint96 selectorPosition = uint96(ds.facetFunctionSelectors[_facetAddress].functionSelectors.length);
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (uint256 i; i < _functionSelectors.length; i++) {
            bytes4 selector = _functionSelectors[i];
            address oldFacet = ds.selectorToFacetAndPosition[selector].facetAddress;
            require(oldFacet != _facetAddress, "LibDiamond: same facet");
            removeFunction(ds, oldFacet, selector);
            addFunction(ds, selector, selectorPosition, _facetAddress);
            selectorPosition++;
        }
    }

    function removeFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
        require(_functionSelectors.length > 0, "LibDiamond: no selectors in cut");
        require(_facetAddress == address(0), "LibDiamond: Remove facet must be zero");
        DiamondStorage storage ds = diamondStorage();
        for (uint256 i; i < _functionSelectors.length; i++) {
            bytes4 selector = _functionSelectors[i];
            address oldFacet = ds.selectorToFacetAndPosition[selector].facetAddress;
            removeFunction(ds, oldFacet, selector);
        }
    }

    function addFacet(DiamondStorage storage ds, address _facetAddress) internal {
        require(_facetAddress.code.length > 0, "LibDiamond: facet has no code");
        ds.facetFunctionSelectors[_facetAddress].facetAddressPosition = ds.facetAddresses.length;
        ds.facetAddresses.push(_facetAddress);
    }

    function addFunction(DiamondStorage storage ds, bytes4 _selector, uint96 _position, address _facet) internal {
        ds.selectorToFacetAndPosition[_selector].functionSelectorPosition = _position;
        ds.facetFunctionSelectors[_facet].functionSelectors.push(_selector);
        ds.selectorToFacetAndPosition[_selector].facetAddress = _facet;
    }

    function removeFunction(DiamondStorage storage ds, address _facet, bytes4 _selector) internal {
        require(_facet != address(0), "LibDiamond: selector doesn't exist");
        require(_facet != address(this), "LibDiamond: can't remove diamond function");
        // Replace with last selector and pop.
        uint256 selectorPos = ds.selectorToFacetAndPosition[_selector].functionSelectorPosition;
        uint256 lastPos = ds.facetFunctionSelectors[_facet].functionSelectors.length - 1;
        if (selectorPos != lastPos) {
            bytes4 lastSelector = ds.facetFunctionSelectors[_facet].functionSelectors[lastPos];
            ds.facetFunctionSelectors[_facet].functionSelectors[selectorPos] = lastSelector;
            ds.selectorToFacetAndPosition[lastSelector].functionSelectorPosition = uint96(selectorPos);
        }
        ds.facetFunctionSelectors[_facet].functionSelectors.pop();
        delete ds.selectorToFacetAndPosition[_selector];

        // If facet has no more selectors, remove from facetAddresses.
        if (lastPos == 0) {
            uint256 facetAddressPos = ds.facetFunctionSelectors[_facet].facetAddressPosition;
            uint256 lastFacetPos = ds.facetAddresses.length - 1;
            if (facetAddressPos != lastFacetPos) {
                address lastFacet = ds.facetAddresses[lastFacetPos];
                ds.facetAddresses[facetAddressPos] = lastFacet;
                ds.facetFunctionSelectors[lastFacet].facetAddressPosition = facetAddressPos;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[_facet].facetAddressPosition;
        }
    }

    function initializeDiamondCut(address _init, bytes memory _calldata) internal {
        if (_init == address(0)) return;
        require(_init.code.length > 0, "LibDiamond: init has no code");
        (bool ok, bytes memory err) = _init.delegatecall(_calldata);
        if (!ok) {
            if (err.length > 0) {
                assembly {
                    let len := mload(err)
                    revert(add(err, 0x20), len)
                }
            } else {
                revert("LibDiamond: init reverted");
            }
        }
    }
}
