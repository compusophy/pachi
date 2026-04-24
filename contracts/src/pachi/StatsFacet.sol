// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi } from "./LibPachi.sol";

/// @title StatsFacet
/// @notice Read-only views over the on-chain analytics aggregates so the
/// frontend doesn't have to event-scan. All O(1) except `playersBatch`
/// which is O(to-from) — pagination so the call doesn't blow up gas.
contract StatsFacet {
    /// Compact summary for the analytics dashboard header.
    function houseStats() external view returns (
        uint256 _totalPlays,
        uint256 _totalBalls,
        uint256 _totalWagered,
        uint256 _totalPaid,
        uint256 _uniqueWallets
    ) {
        LibPachi.Storage storage s = LibPachi.s();
        return (s.totalPlays, s.totalBalls, s.totalWagered, s.totalPaid, s.playersList.length);
    }

    function totalPlays()    external view returns (uint256) { return LibPachi.s().totalPlays; }
    function totalBalls()    external view returns (uint256) { return LibPachi.s().totalBalls; }
    function totalWagered()  external view returns (uint256) { return LibPachi.s().totalWagered; }
    function totalPaid()     external view returns (uint256) { return LibPachi.s().totalPaid; }

    function playerPlays(address a)         external view returns (uint256) { return LibPachi.s().playerPlays[a]; }
    function playerBalls(address a)         external view returns (uint256) { return LibPachi.s().playerBalls[a]; }
    function playerWagered(address a)       external view returns (uint256) { return LibPachi.s().playerWagered[a]; }
    function playerPaid(address a)          external view returns (uint256) { return LibPachi.s().playerPaid[a]; }
    function playerBestPayoutBps(address a) external view returns (uint256) { return LibPachi.s().playerBestPayoutBps[a]; }

    function playersCount() external view returns (uint256) {
        return LibPachi.s().playersList.length;
    }

    /// @notice Paged enumeration of all players with their aggregates.
    /// `to` is clamped to the list length, so a "fetch all" call can pass
    /// `(0, type(uint256).max)`.
    function playersBatch(uint256 from, uint256 to) external view returns (
        address[] memory addrs,
        uint256[] memory plays,
        uint256[] memory balls,
        uint256[] memory wagered,
        uint256[] memory paid
    ) {
        LibPachi.Storage storage s = LibPachi.s();
        uint256 listLen = s.playersList.length;
        if (to > listLen) to = listLen;
        if (from > to) from = to;
        uint256 len = to - from;
        addrs   = new address[](len);
        plays   = new uint256[](len);
        balls   = new uint256[](len);
        wagered = new uint256[](len);
        paid    = new uint256[](len);
        for (uint256 i; i < len; i++) {
            address a = s.playersList[from + i];
            addrs[i]   = a;
            plays[i]   = s.playerPlays[a];
            balls[i]   = s.playerBalls[a];
            wagered[i] = s.playerWagered[a];
            paid[i]    = s.playerPaid[a];
        }
    }
}
