// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import { AdminFacet }     from "../src/pachi/AdminFacet.sol";
import { IDiamondCut }    from "../src/diamond/IDiamondCut.sol";

/// @title StatsReset
/// @notice Deploy a fresh AdminFacet (now containing `resetStats`), REPLACE
/// the existing admin selectors to point at it, ADD `resetStats` as a new
/// selector, then call resetStats() from the owner. Wipes all analytics in
/// one broadcast. Additive change for the client (resetStats is owner-only,
/// no client calls it) — no version bump required.
contract StatsReset is Script {
    function run() external {
        uint256 pk      = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND");

        vm.startBroadcast(pk);
        _execute(diamond);
        vm.stopBroadcast();
    }

    function _execute(address diamond) internal {
        AdminFacet next = new AdminFacet();
        IDiamondCut.FacetCut[] memory cuts = _adminCuts(address(next));
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        AdminFacet(diamond).resetStats();
        console.log("AdminFacet (new) ", address(next));
        console.log("DIAMOND          ", diamond);
        console.log("resetStats called");
    }

    function _adminCuts(address admin) internal pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](2);

        // Replace the 6 existing admin selectors with the new facet address
        bytes4[] memory replace = new bytes4[](6);
        replace[0] = AdminFacet.setStake.selector;
        replace[1] = AdminFacet.withdraw.selector;
        replace[2] = AdminFacet.fund.selector;
        replace[3] = AdminFacet.setMults.selector;
        replace[4] = AdminFacet.bumpVersion.selector;
        replace[5] = AdminFacet.appVersion.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: admin,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replace
        });

        // Add the new resetStats selector
        bytes4[] memory add = new bytes4[](1);
        add[0] = AdminFacet.resetStats.selector;
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: admin,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: add
        });
    }
}
