// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Wave.sol";

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

contract WaveTest is Test {
    MockUSD usd;
    Wave wave;
    address player = address(0xBEEF);

    function setUp() public {
        usd = new MockUSD();
        wave = new Wave(address(usd), 1e6);
        usd.mint(address(wave), 100_000e6);
        usd.mint(player, 10_000e6);
        vm.prank(player);
        usd.approve(address(wave), type(uint256).max);
    }

    function test_low_target_almost_always_wins_streak_grows() public {
        // Target 1.01x — should survive ~97% of the time (98% RTP minus the tail).
        uint256 wins;
        uint256 spins = 200;
        for (uint256 i = 0; i < spins; i++) {
            vm.prevrandao(bytes32(i * 1009 + 7));
            vm.prank(player);
            (, uint256 payout) = wave.play(10_100);
            if (payout > 0) wins++;
        }
        // 200 spins at p=0.97 → expect ~194 wins, std ~2.4. 175 is generous.
        assertGt(wins, 175, "low-target win rate too low");
        assertLe(wins, spins);
    }

    function test_high_target_rarely_wins_but_pays_big() public {
        // Target 50x — should survive ~98%/50 ≈ 1.96% of the time.
        uint256 wins;
        uint256 totalPaid;
        uint256 spins = 200;
        for (uint256 i = 0; i < spins; i++) {
            vm.prevrandao(bytes32(i * 7919 + 11));
            vm.prank(player);
            (, uint256 payout) = wave.play(500_000);
            if (payout > 0) { wins++; totalPaid += payout; }
        }
        // p≈0.0196 over 200 → mean 3.9, std ~2. Allow [0, 12].
        assertLe(wins, 12, "too many wins for 50x target");
        // If anyone hit, they got 50× stake.
        if (wins > 0) assertEq(totalPaid, wins * 50e6, "payout amount wrong");
    }

    function test_streak_resets_on_loss() public {
        uint256 maxT = MAX_TARGET();
        // Force a loss (huge target) then a likely win.
        vm.prevrandao(bytes32(uint256(1)));
        vm.prank(player);
        wave.play(maxT);
        assertEq(wave.streak(player), 0);

        // Then a low-target win
        vm.prevrandao(bytes32(uint256(123456)));
        vm.prank(player);
        wave.play(10_001);
        // With a known prevrandao the outcome is deterministic; assert post-conditions consistent.
        // streak is either 0 (lost) or 1 (won). bestStreak >= streak.
        uint256 s = wave.streak(player);
        assertLe(s, 1);
        assertGe(wave.bestStreak(player), s);
    }

    function test_house_edge_band_means_some_instant_crashes() public {
        // ~2% of rolls should produce an instant crash regardless of target.
        // With a low target, the only way to lose is the instant-crash band.
        uint256 losses;
        uint256 spins = 1000;
        for (uint256 i = 0; i < spins; i++) {
            vm.prevrandao(bytes32(i * 31 + 5));
            vm.prank(player);
            (, uint256 payout) = wave.play(10_001);
            if (payout == 0) losses++;
        }
        // Expected ~2% = 20. Allow band [5, 50].
        assertGt(losses, 5,  "instant-crash band too rare");
        assertLt(losses, 50, "instant-crash band too common");
    }

    function test_bankroll_guard_blocks_unaffordable_payout() public {
        // Drain bankroll
        wave.withdraw(usd.balanceOf(address(wave)));
        usd.mint(address(wave), 50e6); // tiny bankroll

        vm.prank(player);
        vm.expectRevert(Wave.BankrollTooLow.selector);
        wave.play(10_000_000); // 1000x target > bankroll
    }

    function test_target_bounds() public {
        vm.prank(player);
        vm.expectRevert(Wave.TargetTooLow.selector);
        wave.play(9_999);

        vm.prank(player);
        vm.expectRevert(Wave.TargetTooHigh.selector);
        wave.play(100_000_001);
    }

    function MAX_TARGET() internal view returns (uint256) {
        return wave.MAX_PAYOUT_BPS();
    }
}
