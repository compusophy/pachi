// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { PachiUSD } from "../src/PachiUSD.sol";

contract PachiUSDTest is Test {
    PachiUSD usd;
    address owner   = address(this);
    address minter  = address(0xC0FFEE);
    address alice   = address(0xA11CE);
    address bob     = address(0xB0B);

    function setUp() public {
        usd = new PachiUSD(owner);
        usd.setMinter(minter);
    }

    function test_metadata() public {
        assertEq(usd.decimals(), 6);
        assertEq(usd.symbol(), "pUSD");
        assertEq(usd.totalSupply(), 0);
    }

    function test_only_minter_can_mint() public {
        vm.expectRevert(PachiUSD.NotMinter.selector);
        usd.mint(alice, 100e6);

        vm.prank(minter);
        usd.mint(alice, 100e6);
        assertEq(usd.balanceOf(alice), 100e6);
        assertEq(usd.totalSupply(), 100e6);
    }

    function test_transfer_and_transferFrom() public {
        vm.prank(minter);
        usd.mint(alice, 100e6);

        vm.prank(alice);
        usd.transfer(bob, 30e6);
        assertEq(usd.balanceOf(alice), 70e6);
        assertEq(usd.balanceOf(bob), 30e6);

        vm.prank(bob);
        usd.approve(alice, 10e6);
        vm.prank(alice);
        usd.transferFrom(bob, alice, 10e6);
        assertEq(usd.balanceOf(bob), 20e6);
        assertEq(usd.balanceOf(alice), 80e6);
    }

    function test_max_allowance_does_not_decrement() public {
        vm.prank(minter);
        usd.mint(alice, 100e6);
        vm.prank(alice);
        usd.approve(bob, type(uint256).max);
        vm.prank(bob);
        usd.transferFrom(alice, bob, 50e6);
        assertEq(usd.allowance(alice, bob), type(uint256).max);
    }

    function test_burn() public {
        vm.prank(minter);
        usd.mint(alice, 100e6);
        vm.prank(alice);
        usd.burn(40e6);
        assertEq(usd.balanceOf(alice), 60e6);
        assertEq(usd.totalSupply(), 60e6);
    }

    function test_minter_can_be_changed() public {
        usd.setMinter(alice);
        assertEq(usd.minter(), alice);
        vm.prank(alice);
        usd.mint(bob, 7e6);
        assertEq(usd.balanceOf(bob), 7e6);
    }

    function test_only_owner_can_set_minter() public {
        vm.prank(alice);
        vm.expectRevert(PachiUSD.NotOwner.selector);
        usd.setMinter(alice);
    }

    function test_insufficient_balance_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PachiUSD.InsufficientBalance.selector);
        usd.transfer(bob, 1);
    }
}
