// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import { PachiUSD }            from "../src/PachiUSD.sol";
import { OnboardingFacet }     from "../src/pachi/OnboardingFacet.sol";
import { PhaseTwoInit }        from "../src/pachi/PhaseTwoInit.sol";
import { IDiamondCut }         from "../src/diamond/IDiamondCut.sol";

/// @title Phase 2 cut — adds PachiUSD as the game token + onboarding facet
/// Run order is: deploy contracts → set diamond as PachiUSD minter → build
/// the cut → diamondCut(...) which both adds the new selectors and runs
/// PhaseTwoInit.init via delegatecall to point s.token at PachiUSD and
/// bump appVersion to 2 — all in a single broadcast.
contract Phase2Cut is Script {
    function run() external {
        uint256 pk      = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND");
        uint256 newVer  = vm.envOr("APP_VERSION", uint256(2));

        vm.startBroadcast(pk);
        _execute(pk, diamond, newVer);
        vm.stopBroadcast();
    }

    function _execute(uint256 pk, address diamond, uint256 newVer) internal {
        PachiUSD pachi = new PachiUSD(vm.addr(pk));
        pachi.setMinter(diamond);

        OnboardingFacet onboarding = new OnboardingFacet();
        PhaseTwoInit    init       = new PhaseTwoInit();

        IDiamondCut.FacetCut[] memory cuts = _onboardingCuts(address(onboarding));
        bytes memory initData = abi.encodeWithSelector(
            PhaseTwoInit.init.selector, address(pachi), newVer
        );
        IDiamondCut(diamond).diamondCut(cuts, address(init), initData);

        console.log("PACHI_USD        ", address(pachi));
        console.log("OnboardingFacet  ", address(onboarding));
        console.log("PhaseTwoInit     ", address(init));
        console.log("DIAMOND          ", diamond);
        console.log("NEW_APP_VERSION  ", newVer);
    }

    function _onboardingCuts(address onboarding) internal pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](1);
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = OnboardingFacet.register.selector;
        sel[1] = OnboardingFacet.claimDailyAllowance.selector;
        sel[2] = OnboardingFacet.isRegistered.selector;
        sel[3] = OnboardingFacet.inviterOf.selector;
        sel[4] = OnboardingFacet.registeredAt.selector;
        sel[5] = OnboardingFacet.nextAllowanceAt.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: onboarding,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
    }
}
