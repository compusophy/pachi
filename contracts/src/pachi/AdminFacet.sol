// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi } from "./LibPachi.sol";
import { LibDiamond } from "../diamond/LibDiamond.sol";

/// @title AdminFacet
/// @notice Owner-only knobs: stake, withdraw, fund, multiplier table edits,
/// and the appVersion bump used for client/contract version sync.
contract AdminFacet {
    event StakeChanged(uint256 oldStake, uint256 newStake);
    event Funded(address indexed from, uint256 amount);
    event MultsChanged();
    event VersionBumped(uint256 oldVersion, uint256 newVersion);

    function setStake(uint256 newStake) external {
        LibDiamond.enforceIsContractOwner();
        LibPachi.Storage storage s = LibPachi.s();
        emit StakeChanged(s.stake, newStake);
        s.stake = newStake;
    }

    function withdraw(uint256 amount) external {
        LibDiamond.enforceIsContractOwner();
        LibPachi.s().token.transfer(LibDiamond.contractOwner(), amount);
    }

    function fund(uint256 amount) external {
        LibPachi.Storage storage s = LibPachi.s();
        s.token.transferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setMults(uint32[13] calldata newMults) external {
        LibDiamond.enforceIsContractOwner();
        LibPachi.Storage storage s = LibPachi.s();
        for (uint256 i; i < 13; i++) s.mults[i] = newMults[i];
        emit MultsChanged();
    }

    /// @notice Bump after any breaking facet upgrade (replace/remove of
    /// a selector the client calls, or semantics change). Old clients see
    /// version mismatch and force-refresh. Order: cut → bumpVersion → deploy
    /// new client. See project_pachi_versioning memo.
    function bumpVersion(uint256 newVersion) external {
        LibDiamond.enforceIsContractOwner();
        LibPachi.Storage storage s = LibPachi.s();
        require(newVersion > s.appVersion, "AdminFacet: must bump up");
        emit VersionBumped(s.appVersion, newVersion);
        s.appVersion = newVersion;
    }

    function appVersion() external view returns (uint256) {
        return LibPachi.s().appVersion;
    }

    /// @notice Wipe all on-chain analytics state — globals + per-player + the
    /// enumerable players list. Use sparingly (e.g., before public launch to
    /// discard pre-launch test data). Token balances, registration status,
    /// allowance cooldowns and the multiplier table are NOT touched.
    /// Single-call iterates playersList — fine for small N. If we ever need
    /// to reset thousands of players we can paginate, but the cut is cheap.
    event StatsReset(uint256 playersCleared);

    function resetStats() external {
        LibDiamond.enforceIsContractOwner();
        LibPachi.Storage storage s = LibPachi.s();

        uint256 n = s.playersList.length;
        for (uint256 i; i < n; i++) {
            address p = s.playersList[i];
            delete s.playerPlays[p];
            delete s.playerBalls[p];
            delete s.playerWagered[p];
            delete s.playerPaid[p];
            delete s.playerBestPayoutBps[p];
            delete s.seenPlayer[p];
        }
        delete s.playersList;

        s.totalPlays = 0;
        s.totalBalls = 0;
        s.totalWagered = 0;
        s.totalPaid = 0;

        emit StatsReset(n);
    }
}
