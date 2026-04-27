// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Pachi.sol";

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

contract PachiTest is Test {
    MockUSD usd;
    Pachi pachi;
    address player = address(0xBEEF);

    function setUp() public {
        usd = new MockUSD();
        pachi = new Pachi(address(usd), 1e6);
        usd.mint(address(pachi), 1_000_000e6);
        usd.mint(player, 1_000_000e6);
        vm.prank(player);
        usd.approve(address(pachi), type(uint256).max);
    }

    function test_play_n_returns_n_balls() public {
        uint256[] memory ns = new uint256[](3);
        ns[0] = 1; ns[1] = 10; ns[2] = 100;
        for (uint256 k = 0; k < 3; k++) {
            vm.prevrandao(bytes32(k * 1009 + 7));
            vm.prank(player);
            (uint256[] memory paths, uint256[] memory bm, uint256 tBps, uint256 pay) = pachi.play(ns[k]);
            assertEq(paths.length, ns[k]);
            assertEq(bm.length, ns[k]);
            uint256 sum;
            for (uint256 i = 0; i < bm.length; i++) sum += bm[i];
            assertEq(sum, tBps);
            assertEq(pay, (1e6 * tBps) / 10_000);
        }
    }

    function test_zero_balls_reverts() public {
        vm.prank(player);
        vm.expectRevert(Pachi.BallsOutOfRange.selector);
        pachi.play(0);
    }

    function test_too_many_balls_reverts() public {
        // MAX_BALLS bumped from 100 to 1000 alongside the ×1000 client
        // option — this probes one above the new ceiling.
        vm.prank(player);
        vm.expectRevert(Pachi.BallsOutOfRange.selector);
        pachi.play(1001);
    }

    function test_slot_distribution_is_binomial_at_scale() public {
        uint256[13] memory counts;
        // 50 plays × 100 balls = 5000 ball samples in just 50 txs
        for (uint256 i = 0; i < 50; i++) {
            vm.prevrandao(bytes32(i * 7919 + 11));
            vm.prank(player);
            (uint256[] memory paths,,,) = pachi.play(100);
            for (uint256 j = 0; j < paths.length; j++) {
                uint256 slot = 0; uint256 p = paths[j];
                for (uint256 r = 0; r < 12; r++) if ((p >> r) & 1 == 1) slot++;
                counts[slot]++;
            }
        }
        assertGt(counts[6], counts[0]);
        assertGt(counts[6], counts[12]);
        assertGt(counts[5], counts[1]);
        assertGt(counts[7], counts[11]);
    }

    function test_rtp_in_band_at_scale() public {
        uint256 totalStaked;
        uint256 totalPaid;
        // 100 plays × 100 balls = 10_000 ball samples
        for (uint256 i = 0; i < 100; i++) {
            vm.prevrandao(bytes32(i * 31 + 3));
            uint256 before = usd.balanceOf(player);
            vm.prank(player);
            pachi.play(100);
            uint256 after_ = usd.balanceOf(player);
            totalStaked += 100e6;
            // payout = after - before + stake (stake was deducted then payout returned)
            if (after_ + 100e6 > before) totalPaid += (after_ + 100e6 - before);
        }
        // Expected per-ball RTP ~0.925. With 10K balls, variance is moderate.
        uint256 rtpBps = (totalPaid * 10_000) / totalStaked;
        assertGt(rtpBps, 7_500,  "RTP too low");
        assertLt(rtpBps, 11_000, "RTP too high");
    }

    function test_bankroll_guard() public {
        pachi.withdraw(usd.balanceOf(address(pachi)));
        usd.mint(address(pachi), 50e6);
        vm.prank(player);
        vm.expectRevert(Pachi.BankrollTooLow.selector);
        pachi.play(1);
    }
}
