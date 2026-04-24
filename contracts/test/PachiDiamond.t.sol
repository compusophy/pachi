// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
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

contract MockUSD {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract PachiDiamondTest is Test {
    MockUSD usd;
    address diamondAddr;
    address player = address(0xBEEF);

    function setUp() public {
        usd = new MockUSD();

        DiamondCutFacet  cut    = new DiamondCutFacet();
        DiamondLoupeFacet loupe = new DiamondLoupeFacet();
        OwnershipFacet   own    = new OwnershipFacet();
        GameFacet        game   = new GameFacet();
        StatsFacet       stats  = new StatsFacet();
        AdminFacet       admin  = new AdminFacet();
        PachiInit        init   = new PachiInit();

        Diamond diamond = new Diamond(address(this), address(cut));
        diamondAddr = address(diamond);

        IDiamondCut.FacetCut[] memory diamondCut = new IDiamondCut.FacetCut[](5);

        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = IDiamondLoupe.facets.selector;
        loupeSelectors[1] = IDiamondLoupe.facetFunctionSelectors.selector;
        loupeSelectors[2] = IDiamondLoupe.facetAddresses.selector;
        loupeSelectors[3] = IDiamondLoupe.facetAddress.selector;
        diamondCut[0] = IDiamondCut.FacetCut(address(loupe), IDiamondCut.FacetCutAction.Add, loupeSelectors);

        bytes4[] memory ownSelectors = new bytes4[](2);
        ownSelectors[0] = OwnershipFacet.transferOwnership.selector;
        ownSelectors[1] = OwnershipFacet.owner.selector;
        diamondCut[1] = IDiamondCut.FacetCut(address(own), IDiamondCut.FacetCutAction.Add, ownSelectors);

        bytes4[] memory gameSelectors = new bytes4[](6);
        gameSelectors[0] = GameFacet.play.selector;
        gameSelectors[1] = GameFacet.stake.selector;
        gameSelectors[2] = GameFacet.nonce.selector;
        gameSelectors[3] = GameFacet.mults.selector;
        gameSelectors[4] = GameFacet.token.selector;
        gameSelectors[5] = GameFacet.bankroll.selector;
        diamondCut[2] = IDiamondCut.FacetCut(address(game), IDiamondCut.FacetCutAction.Add, gameSelectors);

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
        diamondCut[3] = IDiamondCut.FacetCut(address(stats), IDiamondCut.FacetCutAction.Add, statsSelectors);

        bytes4[] memory adminSelectors = new bytes4[](6);
        adminSelectors[0] = AdminFacet.setStake.selector;
        adminSelectors[1] = AdminFacet.withdraw.selector;
        adminSelectors[2] = AdminFacet.fund.selector;
        adminSelectors[3] = AdminFacet.setMults.selector;
        adminSelectors[4] = AdminFacet.bumpVersion.selector;
        adminSelectors[5] = AdminFacet.appVersion.selector;
        diamondCut[4] = IDiamondCut.FacetCut(address(admin), IDiamondCut.FacetCutAction.Add, adminSelectors);

        bytes memory initCalldata = abi.encodeWithSelector(
            PachiInit.init.selector, address(usd), uint256(1e6), uint256(1)
        );
        IDiamondCut(diamondAddr).diamondCut(diamondCut, address(init), initCalldata);

        // Bankroll + player
        usd.mint(diamondAddr, 1_000_000e6);
        usd.mint(player, 1_000_000e6);
        vm.prank(player);
        usd.approve(diamondAddr, type(uint256).max);
    }

    function test_init_sets_correct_state() public {
        assertEq(GameFacet(diamondAddr).stake(), 1e6);
        assertEq(GameFacet(diamondAddr).token(), address(usd));
        assertEq(AdminFacet(diamondAddr).appVersion(), 1);
        assertEq(GameFacet(diamondAddr).mults(0), 850000);
        assertEq(GameFacet(diamondAddr).mults(6), 1086);
        assertEq(GameFacet(diamondAddr).mults(12), 850000);
    }

    function test_play_through_diamond() public {
        vm.prevrandao(bytes32(uint256(42)));
        vm.prank(player);
        (uint256[] memory paths, uint256[] memory ballMults, uint256 totalBps, uint256 payout) =
            GameFacet(diamondAddr).play(10);
        assertEq(paths.length, 10);
        assertEq(ballMults.length, 10);
        uint256 sum;
        for (uint256 i; i < ballMults.length; i++) sum += ballMults[i];
        assertEq(sum, totalBps);
        assertEq(payout, (1e6 * totalBps) / 10_000);
    }

    function test_stats_aggregate() public {
        for (uint256 i; i < 30; i++) {
            vm.prevrandao(bytes32(i * 31 + 7));
            vm.prank(player);
            GameFacet(diamondAddr).play(10);
        }
        (uint256 plays, uint256 balls, uint256 wag, uint256 paid, uint256 wallets) =
            StatsFacet(diamondAddr).houseStats();
        assertEq(plays, 30);
        assertEq(balls, 300);
        assertEq(wag, 300e6);
        assertEq(wallets, 1);
        // RTP within wide band over 300 balls
        uint256 rtpBps = (paid * 10_000) / wag;
        assertGt(rtpBps, 5_000, "RTP unreasonably low");
        assertLt(rtpBps, 15_000, "RTP unreasonably high");
    }

    function test_players_batch_pagination() public {
        for (uint256 i; i < 3; i++) {
            address p = address(uint160(0x1000 + i));
            usd.mint(p, 100e6);
            vm.prank(p);
            usd.approve(diamondAddr, type(uint256).max);
            vm.prevrandao(bytes32(i + 1));
            vm.prank(p);
            GameFacet(diamondAddr).play(1);
        }
        assertEq(StatsFacet(diamondAddr).playersCount(), 3);
        (address[] memory addrs,,,,) = StatsFacet(diamondAddr).playersBatch(0, type(uint256).max);
        assertEq(addrs.length, 3);
    }

    function test_admin_only_setStake() public {
        vm.prank(player);
        vm.expectRevert("LibDiamond: not owner");
        AdminFacet(diamondAddr).setStake(2e6);

        AdminFacet(diamondAddr).setStake(2e6);
        assertEq(GameFacet(diamondAddr).stake(), 2e6);
    }

    function test_bumpVersion_only_owner_and_only_up() public {
        vm.prank(player);
        vm.expectRevert("LibDiamond: not owner");
        AdminFacet(diamondAddr).bumpVersion(2);

        AdminFacet(diamondAddr).bumpVersion(2);
        assertEq(AdminFacet(diamondAddr).appVersion(), 2);

        vm.expectRevert("AdminFacet: must bump up");
        AdminFacet(diamondAddr).bumpVersion(2);
    }

    function test_loupe_lists_all_facets() public {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamondAddr).facets();
        // cut + loupe + ownership + game + stats + admin = 6
        assertEq(all.length, 6);
    }

    function test_unknown_selector_reverts() public {
        (bool ok, ) = diamondAddr.call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok, "unknown selector should revert");
    }
}
