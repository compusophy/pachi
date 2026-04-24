// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { Diamond }              from "../src/Diamond.sol";
import { DiamondCutFacet }      from "../src/diamond/DiamondCutFacet.sol";
import { OwnershipFacet }       from "../src/diamond/OwnershipFacet.sol";
import { IDiamondCut }          from "../src/diamond/IDiamondCut.sol";
import { GameFacet }            from "../src/pachi/GameFacet.sol";
import { AdminFacet }           from "../src/pachi/AdminFacet.sol";
import { OnboardingFacet }      from "../src/pachi/OnboardingFacet.sol";
import { PachiInit }            from "../src/pachi/PachiInit.sol";
import { PhaseTwoInit }         from "../src/pachi/PhaseTwoInit.sol";
import { PachiUSD }             from "../src/PachiUSD.sol";

contract OnboardingTest is Test {
    PachiUSD pachi;
    address diamond;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    function setUp() public {
        // Minimal diamond bringup: cut + ownership + game + admin + onboarding
        DiamondCutFacet  cut    = new DiamondCutFacet();
        OwnershipFacet   own    = new OwnershipFacet();
        GameFacet        game   = new GameFacet();
        AdminFacet       admin  = new AdminFacet();
        OnboardingFacet  ob     = new OnboardingFacet();
        PachiInit        init1  = new PachiInit();
        PhaseTwoInit     init2  = new PhaseTwoInit();

        Diamond d = new Diamond(address(this), address(cut));
        diamond = address(d);

        // PachiUSD
        pachi = new PachiUSD(address(this));
        pachi.setMinter(diamond);

        // Cut: ownership + game + admin + onboarding
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);

        bytes4[] memory ownSel = new bytes4[](2);
        ownSel[0] = OwnershipFacet.transferOwnership.selector;
        ownSel[1] = OwnershipFacet.owner.selector;
        cuts[0] = IDiamondCut.FacetCut(address(own), IDiamondCut.FacetCutAction.Add, ownSel);

        bytes4[] memory gameSel = new bytes4[](6);
        gameSel[0] = GameFacet.play.selector;
        gameSel[1] = GameFacet.stake.selector;
        gameSel[2] = GameFacet.nonce.selector;
        gameSel[3] = GameFacet.mults.selector;
        gameSel[4] = GameFacet.token.selector;
        gameSel[5] = GameFacet.bankroll.selector;
        cuts[1] = IDiamondCut.FacetCut(address(game), IDiamondCut.FacetCutAction.Add, gameSel);

        bytes4[] memory adminSel = new bytes4[](6);
        adminSel[0] = AdminFacet.setStake.selector;
        adminSel[1] = AdminFacet.withdraw.selector;
        adminSel[2] = AdminFacet.fund.selector;
        adminSel[3] = AdminFacet.setMults.selector;
        adminSel[4] = AdminFacet.bumpVersion.selector;
        adminSel[5] = AdminFacet.appVersion.selector;
        cuts[2] = IDiamondCut.FacetCut(address(admin), IDiamondCut.FacetCutAction.Add, adminSel);

        bytes4[] memory obSel = new bytes4[](6);
        obSel[0] = OnboardingFacet.register.selector;
        obSel[1] = OnboardingFacet.claimDailyAllowance.selector;
        obSel[2] = OnboardingFacet.isRegistered.selector;
        obSel[3] = OnboardingFacet.inviterOf.selector;
        obSel[4] = OnboardingFacet.registeredAt.selector;
        obSel[5] = OnboardingFacet.nextAllowanceAt.selector;
        cuts[3] = IDiamondCut.FacetCut(address(ob), IDiamondCut.FacetCutAction.Add, obSel);

        // Initial init: token = PachiUSD directly (skipping the AlphaUSD intermediate
        // step a real testnet upgrade goes through), version 2, stake $1.
        bytes memory initData = abi.encodeWithSelector(
            PachiInit.init.selector, address(pachi), uint256(1e6), uint256(1)
        );
        IDiamondCut(diamond).diamondCut(cuts, address(init1), initData);

        // Phase 2 init: bump to v2 (token already set above)
        bytes memory phase2Data = abi.encodeWithSelector(
            PhaseTwoInit.init.selector, address(pachi), uint256(2)
        );
        IDiamondCut.FacetCut[] memory empty = new IDiamondCut.FacetCut[](0);
        IDiamondCut(diamond).diamondCut(empty, address(init2), phase2Data);
    }

    function test_register_grants_starter() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        assertTrue(OnboardingFacet(diamond).isRegistered(alice));
        assertEq(pachi.balanceOf(alice), 1_000e6);
    }

    function test_double_register_reverts() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        vm.prank(alice);
        vm.expectRevert(OnboardingFacet.AlreadyRegistered.selector);
        OnboardingFacet(diamond).register(address(0));
    }

    function test_register_records_inviter() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        vm.prank(bob);
        OnboardingFacet(diamond).register(alice);
        assertEq(OnboardingFacet(diamond).inviterOf(bob), alice);
    }

    function test_cannot_invite_self() public {
        vm.prank(alice);
        vm.expectRevert(OnboardingFacet.CannotInviteSelf.selector);
        OnboardingFacet(diamond).register(alice);
    }

    function test_claim_allowance_first_call_succeeds() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        // Already minted starter (1000); claim adds another 1000.
        vm.prank(alice);
        OnboardingFacet(diamond).claimDailyAllowance();
        assertEq(pachi.balanceOf(alice), 2_000e6);
    }

    function test_claim_allowance_cooldown() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        vm.prank(alice);
        OnboardingFacet(diamond).claimDailyAllowance();
        // Second claim immediately should revert with cooldown
        vm.prank(alice);
        vm.expectRevert();  // AllowanceCooldown with arg, just check it reverts
        OnboardingFacet(diamond).claimDailyAllowance();
    }

    function test_claim_allowance_after_cooldown() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        vm.prank(alice);
        OnboardingFacet(diamond).claimDailyAllowance();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        OnboardingFacet(diamond).claimDailyAllowance();
        assertEq(pachi.balanceOf(alice), 3_000e6);
    }

    function test_unregistered_cannot_claim() public {
        vm.prank(alice);
        vm.expectRevert(OnboardingFacet.NotRegistered.selector);
        OnboardingFacet(diamond).claimDailyAllowance();
    }

    function test_play_now_uses_pachi_usd() public {
        vm.prank(alice);
        OnboardingFacet(diamond).register(address(0));
        vm.prank(alice);
        pachi.approve(diamond, type(uint256).max);
        // Bankroll the diamond
        vm.prank(address(this));
        pachi.transferOwnership(address(this));
        // Mint bankroll directly via minter
        vm.prank(diamond);
        pachi.mint(diamond, 100_000e6);

        vm.prevrandao(bytes32(uint256(7)));
        vm.prank(alice);
        GameFacet(diamond).play(5);

        // Alice spent $5, may or may not have won — totalBalls should be 5.
        // Token used was PachiUSD.
        assertEq(GameFacet(diamond).token(), address(pachi));
    }

    function test_appVersion_is_2_after_phase2() public {
        assertEq(AdminFacet(diamond).appVersion(), 2);
    }
}
