// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi, IERC20 } from "./LibPachi.sol";

/// @title GameFacet
/// @notice Multi-ball Plinko play loop, ported from the legacy Pachi.sol
/// to operate on AppStorage. Logic is identical (1.618% house edge,
/// popcount-of-12-bits binomial slot distribution); the difference is
/// where state lives (LibPachi.s() not contract storage).
contract GameFacet {
    uint256 public constant MAX_BALLS = 100;

    event Played(
        address indexed player,
        uint256 stakePerBall,
        uint256 nBalls,
        uint256[] paths,
        uint256[] ballMults,
        uint256 totalBps,
        uint256 payout,
        uint256 nonce
    );

    error BallsOutOfRange();
    error BankrollTooLow();

    function play(uint256 n) external returns (
        uint256[] memory paths,
        uint256[] memory ballMults,
        uint256 totalBps,
        uint256 payout
    ) {
        LibPachi.Storage storage st = LibPachi.s();
        if (n == 0 || n > MAX_BALLS) revert BallsOutOfRange();

        uint256 totalStake = st.stake * n;
        st.token.transferFrom(msg.sender, address(this), totalStake);

        uint256 maxPayout = (n * uint256(st.mults[0]) * st.stake) / 10_000;
        if (st.token.balanceOf(address(this)) < maxPayout) revert BankrollTooLow();

        unchecked { st.nonce++; }

        uint256 entropy = uint256(keccak256(abi.encode(
            msg.sender, st.nonce, block.prevrandao, block.number
        )));

        paths = new uint256[](n);
        ballMults = new uint256[](n);

        for (uint256 i; i < n; i++) {
            uint256 ballSeed = uint256(keccak256(abi.encode(entropy, i + 1)));
            uint256 path = ballSeed & 0xFFF;
            uint256 slot = _popcount12(path);
            paths[i] = path;
            ballMults[i] = st.mults[slot];
            totalBps += st.mults[slot];
        }

        payout = (st.stake * totalBps) / 10_000;
        if (payout > 0) st.token.transfer(msg.sender, payout);

        // ── on-chain analytics aggregation ─────────────────────────
        unchecked {
            st.totalPlays++;
            st.totalBalls   += n;
            st.totalWagered += totalStake;
            st.totalPaid    += payout;

            st.playerPlays[msg.sender]++;
            st.playerBalls[msg.sender]   += n;
            st.playerWagered[msg.sender] += totalStake;
            st.playerPaid[msg.sender]    += payout;
        }
        if (totalBps > st.playerBestPayoutBps[msg.sender]) {
            st.playerBestPayoutBps[msg.sender] = totalBps;
        }
        if (!st.seenPlayer[msg.sender]) {
            st.seenPlayer[msg.sender] = true;
            st.playersList.push(msg.sender);
        }

        emit Played(msg.sender, st.stake, n, paths, ballMults, totalBps, payout, st.nonce);
    }

    // Read-side helpers used by the frontend.
    function stake() external view returns (uint256)            { return LibPachi.s().stake; }
    function nonce() external view returns (uint256)            { return LibPachi.s().nonce; }
    function mults(uint256 i) external view returns (uint32)    { return LibPachi.s().mults[i]; }
    function token() external view returns (address)            { return address(LibPachi.s().token); }
    function bankroll() external view returns (uint256)         { return LibPachi.s().token.balanceOf(address(this)); }

    function _popcount12(uint256 x) internal pure returns (uint256 c) {
        unchecked {
            for (uint256 i; i < 12; i++) if ((x >> i) & 1 == 1) c++;
        }
    }
}
