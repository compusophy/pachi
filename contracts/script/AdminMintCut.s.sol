// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import { AdminFacet }     from "../src/pachi/AdminFacet.sol";
import { IDiamondCut }    from "../src/diamond/IDiamondCut.sol";

/// @title AdminMintCut
/// @notice Deploy a fresh AdminFacet (now containing `adminMint`), REPLACE the
/// existing admin selectors to point at it, ADD `adminMint` as a new selector.
/// Owner-only; additive for the client → no appVersion bump required.
/// Run with PRIVATE_KEY (owner) + DIAMOND (proxy address) in env.
contract AdminMintCut is Script {
    function run() external {
        uint256 pk      = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND");

        vm.startBroadcast(pk);
        AdminFacet next = new AdminFacet();
        IDiamondCut.FacetCut[] memory cuts = _adminCuts(address(next));
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        console.log("AdminFacet (new) ", address(next));
        console.log("DIAMOND          ", diamond);
        console.log("adminMint added  ");
    }

    function _adminCuts(address admin) internal pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](2);

        // Replace the 7 existing admin selectors with the new facet address.
        bytes4[] memory replace = new bytes4[](7);
        replace[0] = AdminFacet.setStake.selector;
        replace[1] = AdminFacet.withdraw.selector;
        replace[2] = AdminFacet.fund.selector;
        replace[3] = AdminFacet.setMults.selector;
        replace[4] = AdminFacet.bumpVersion.selector;
        replace[5] = AdminFacet.appVersion.selector;
        replace[6] = AdminFacet.resetStats.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: admin,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replace
        });

        // Add the new adminMint selector.
        bytes4[] memory add = new bytes4[](1);
        add[0] = AdminFacet.adminMint.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: admin,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: add
        });
    }
}
