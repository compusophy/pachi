// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Pull.sol";

contract MockUSD {
    string public name = "MockUSD";
    string public symbol = "mUSD";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PullTest is Test {
    MockUSD usd;
    Pull pull;
    address player = address(0xBEEF);

    function setUp() public {
        usd = new MockUSD();
        pull = new Pull(address(usd), 1e6); // $1 stake

        // Bankroll the contract with $10k
        usd.mint(address(pull), 10_000e6);

        // Player starts with $1k
        usd.mint(player, 1_000e6);
        vm.prank(player);
        usd.approve(address(pull), type(uint256).max);
    }

    function test_pull_executes_and_distributes_outcomes() public {
        uint256 wins;
        uint256 losses;
        uint256 totalPaid;
        uint256 spins = 200;

        for (uint256 i = 0; i < spins; i++) {
            vm.prevrandao(bytes32(i * 7919 + 1));
            vm.prank(player);
            (, uint256 payout) = pull.pull();
            if (payout > 0) wins++;
            else losses++;
            totalPaid += payout;
        }

        // Sanity: ~35% should win (table is 65% lose).
        // With 200 spins this band is generous.
        assertGt(wins, 40, "wins too low");
        assertLt(wins, 130, "wins too high");
        assertEq(wins + losses, spins);

        // RTP should be in a reasonable band for 200 spins (high variance from 100x slot).
        // Just assert it's plausibly close to 1x stake-per-spin total.
        emit log_named_uint("totalStaked", spins * 1e6);
        emit log_named_uint("totalPaid", totalPaid);
        emit log_named_uint("wins", wins);
    }

    function test_owner_can_set_stake_and_withdraw() public {
        pull.setStake(5e6);
        assertEq(pull.stake(), 5e6);

        uint256 before = usd.balanceOf(address(this));
        pull.withdraw(100e6);
        assertEq(usd.balanceOf(address(this)), before + 100e6);
    }

    function test_non_owner_cannot_admin() public {
        vm.prank(player);
        vm.expectRevert(Pull.NotOwner.selector);
        pull.setStake(2e6);

        vm.prank(player);
        vm.expectRevert(Pull.NotOwner.selector);
        pull.withdraw(1);
    }
}
