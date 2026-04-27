// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import { GameFacet }    from "../src/pachi/GameFacet.sol";
import { IDiamondCut }  from "../src/diamond/IDiamondCut.sol";

interface IAdminBumper {
    function bumpVersion(uint256 newVersion) external;
}

/// @title MaxBallsUpgrade
/// @notice Deploys a fresh GameFacet (MAX_BALLS = 1000), REPLACEs all 6
/// game selectors on the diamond with the new facet address, then
/// bumps appVersion 2 → 3 in the same broadcast.
///
/// Why all-in-one: the play() semantics change (n can now exceed 100),
/// so per project_pachi_versioning policy this is a version bump
/// trigger. Atomic deploy + cut + bump means no window where the
/// client (already at APP_VERSION=3) talks to a contract still on 2.
///
/// Run with PRIVATE_KEY (owner) + DIAMOND in env, plus the standard
/// Tempo flags:
///   forge script script/MaxBallsUpgrade.s.sol \
///     --rpc-url https://rpc.moderato.tempo.xyz \
///     --tempo.fee-token 0x20c0000000000000000000000000000000000001 \
///     --broadcast
contract MaxBallsUpgrade is Script {
    function run() external {
        uint256 pk      = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND");
        uint256 newVer  = vm.envOr("NEW_APP_VERSION", uint256(3));

        vm.startBroadcast(pk);
        GameFacet next = new GameFacet();
        IDiamondCut.FacetCut[] memory cuts = _gameCuts(address(next));
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        IAdminBumper(diamond).bumpVersion(newVer);
        vm.stopBroadcast();

        console.log("GameFacet (new) ", address(next));
        console.log("DIAMOND         ", diamond);
        console.log("appVersion now  ", newVer);
        console.log("MAX_BALLS now   ", next.MAX_BALLS());
    }

    /// REPLACE all 6 GameFacet selectors with the new facet address.
    /// All exist already (initial deploy + Phase 2 cut), so REPLACE not ADD.
    function _gameCuts(address game) internal pure returns (IDiamondCut.FacetCut[] memory cuts) {
        cuts = new IDiamondCut.FacetCut[](1);
        bytes4[] memory replace = new bytes4[](6);
        replace[0] = GameFacet.play.selector;
        replace[1] = GameFacet.stake.selector;
        replace[2] = GameFacet.nonce.selector;
        replace[3] = GameFacet.mults.selector;
        replace[4] = GameFacet.token.selector;
        replace[5] = GameFacet.bankroll.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: game,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: replace
        });
    }
}
