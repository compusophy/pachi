// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LibPachi
/// @notice AppStorage for the Pachi diamond. Single struct accessed via
/// `LibPachi.s()` from any facet. APPEND ONLY — never reorder or remove
/// fields, only add to the end of the struct or you'll corrupt every
/// existing storage slot.
library LibPachi {
    bytes32 constant STORAGE_POSITION = keccak256("pachi.app.storage.v1");

    struct Storage {
        // ── core game state ───────────────────────────────────────────
        IERC20 token;
        uint256 stake;       // per-ball stake (raw, 6-dec)
        uint256 nonce;       // global play counter, used in entropy

        // ── multiplier table (set in init) ────────────────────────────
        uint32[13] mults;

        // ── version sync (see project_pachi_versioning memo) ──────────
        uint256 appVersion;

        // ── on-chain analytics aggregates ─────────────────────────────
        uint256 totalPlays;
        uint256 totalBalls;
        uint256 totalWagered;   // raw 6-dec
        uint256 totalPaid;      // raw 6-dec

        // ── per-player stats ──────────────────────────────────────────
        mapping(address => uint256) playerPlays;
        mapping(address => uint256) playerBalls;
        mapping(address => uint256) playerWagered;
        mapping(address => uint256) playerPaid;
        mapping(address => uint256) playerBestPayoutBps;

        // ── player enumeration (so analytics can list all wallets) ────
        address[] playersList;
        mapping(address => bool) seenPlayer;

        // ── Phase 2: registration + daily allowance (added APPEND-ONLY) ─
        mapping(address => bool) registered;
        mapping(address => uint256) registeredAt;
        mapping(address => address) inviter;             // address(0) for self-registered
        mapping(address => uint256) lastAllowanceClaim;  // unix sec
    }

    function s() internal pure returns (Storage storage st) {
        bytes32 position = STORAGE_POSITION;
        assembly { st.slot := position }
    }
}
