// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import { Diamond }              from "../src/Diamond.sol";
import { DiamondCutFacet }      from "../src/diamond/DiamondCutFacet.sol";
import { DiamondLoupeFacet }    from "../src/diamond/DiamondLoupeFacet.sol";
import { OwnershipFacet }       from "../src/diamond/OwnershipFacet.sol";
import { IDiamondCut }          from "../src/diamond/IDiamondCut.sol";
import { IDiamondLoupe }        from "../src/diamond/IDiamondLoupe.sol";
import { GameFacet }            from "../src/pachi/GameFacet.sol";
import { StatsFacet }           from "../src/pachi/StatsFacet.sol";
import { AdminFacet }           from "../src/pachi/AdminFacet.sol";
import { PachiInit }            from "../src/pachi/PachiInit.sol";

contract DeployPachiDiamond is Script {
    function run() external {
        uint256 pk           = vm.envUint("PRIVATE_KEY");
        address token        = vm.envAddress("STAKE_TOKEN");
        uint256 stake        = vm.envOr("STAKE", uint256(1_000_000));   // $1, 6 dec
        uint256 initVersion  = vm.envOr("APP_VERSION", uint256(1));
        address owner        = vm.addr(pk);

        vm.startBroadcast(pk);

        // 1. Deploy each facet contract.
        DiamondCutFacet  cut    = new DiamondCutFacet();
        DiamondLoupeFacet loupe = new DiamondLoupeFacet();
        OwnershipFacet   own    = new OwnershipFacet();
        GameFacet        game   = new GameFacet();
        StatsFacet       stats  = new StatsFacet();
        AdminFacet       admin  = new AdminFacet();
        PachiInit        init   = new PachiInit();

        // 2. Deploy the diamond. Constructor installs cut.diamondCut so we can
        //    do all subsequent installation via a single diamondCut call.
        Diamond diamond = new Diamond(owner, address(cut));

        // 3. Build the cut adding loupe / ownership / game / stats / admin
        //    selectors, with PachiInit.init delegated for storage setup.
        IDiamondCut.FacetCut[] memory diamondCut = new IDiamondCut.FacetCut[](5);

        // -- Loupe --
        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = IDiamondLoupe.facets.selector;
        loupeSelectors[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        loupeSelectors[2] = IDiamondLoupe.facetAddresses.selector;
        loupeSelectors[3] = IDiamondLoupe.facetAddress.selector;
        diamondCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(loupe),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });

        // -- Ownership --
        bytes4[] memory ownSelectors = new bytes4[](2);
        ownSelectors[0] = OwnershipFacet.transferOwnership.selector;
        ownSelectors[1] = OwnershipFacet.owner.selector;
        diamondCut[1] = IDiamondCut.FacetCut({
            facetAddress: address(own),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: ownSelectors
        });

        // -- Game --
        bytes4[] memory gameSelectors = new bytes4[](6);
        gameSelectors[0] = GameFacet.play.selector;
        gameSelectors[1] = GameFacet.stake.selector;
        gameSelectors[2] = GameFacet.nonce.selector;
        gameSelectors[3] = GameFacet.mults.selector;
        gameSelectors[4] = GameFacet.token.selector;
        gameSelectors[5] = GameFacet.bankroll.selector;
        diamondCut[2] = IDiamondCut.FacetCut({
            facetAddress: address(game),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: gameSelectors
        });

        // -- Stats --
        bytes4[] memory statsSelectors = new bytes4[](11);
        statsSelectors[0]  = StatsFacet.houseStats.selector;
        statsSelectors[1]  = StatsFacet.totalPlays.selector;
        statsSelectors[2]  = StatsFacet.totalBalls.selector;
        statsSelectors[3]  = StatsFacet.totalWagered.selector;
        statsSelectors[4]  = StatsFacet.totalPaid.selector;
        statsSelectors[5]  = StatsFacet.playerPlays.selector;
        statsSelectors[6]  = StatsFacet.playerBalls.selector;
        statsSelectors[7]  = StatsFacet.playerWagered.selector;
        statsSelectors[8]  = StatsFacet.playerPaid.selector;
        statsSelectors[9]  = StatsFacet.playersCount.selector;
        statsSelectors[10] = StatsFacet.playersBatch.selector;
        diamondCut[3] = IDiamondCut.FacetCut({
            facetAddress: address(stats),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: statsSelectors
        });

        // -- Admin --
        bytes4[] memory adminSelectors = new bytes4[](6);
        adminSelectors[0] = AdminFacet.setStake.selector;
        adminSelectors[1] = AdminFacet.withdraw.selector;
        adminSelectors[2] = AdminFacet.fund.selector;
        adminSelectors[3] = AdminFacet.setMults.selector;
        adminSelectors[4] = AdminFacet.bumpVersion.selector;
        adminSelectors[5] = AdminFacet.appVersion.selector;
        diamondCut[4] = IDiamondCut.FacetCut({
            facetAddress: address(admin),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: adminSelectors
        });

        bytes memory initCalldata = abi.encodeWithSelector(
            PachiInit.init.selector, token, stake, initVersion
        );

        // 4. Apply the cut + run PachiInit.init via delegatecall.
        IDiamondCut(address(diamond)).diamondCut(diamondCut, address(init), initCalldata);

        vm.stopBroadcast();

        // ── Output for env piping ────────────────────────────────────
        console.log("DIAMOND          ", address(diamond));
        console.log("OWNER            ", owner);
        console.log("APP_VERSION      ", initVersion);
        console.log("STAKE_TOKEN      ", token);
        console.log("STAKE_PER_BALL   ", stake);
        console.log("");
        console.log("DiamondCutFacet  ", address(cut));
        console.log("DiamondLoupeFacet", address(loupe));
        console.log("OwnershipFacet   ", address(own));
        console.log("GameFacet        ", address(game));
        console.log("StatsFacet       ", address(stats));
        console.log("AdminFacet       ", address(admin));
        console.log("PachiInit        ", address(init));
    }
}
