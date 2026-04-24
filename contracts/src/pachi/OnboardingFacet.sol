// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi } from "./LibPachi.sol";

interface IPachiUSD {
    function mint(address to, uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

/// @title OnboardingFacet
/// @notice Phase 2 — register users and hand out daily play allowance.
/// On testnet anyone can self-register (no invite gate). Invite-binding
/// (Farcaster FID) is deferred to Phase 2.B once the mini-app ships.
/// All token mints go through s.token (which is now the PachiUSD address
/// after the Phase 2 cut).
contract OnboardingFacet {
    uint256 public constant STARTER_GRANT     = 1_000e6;   // $1000 (6 dec)
    uint256 public constant DAILY_ALLOWANCE   = 1_000e6;
    uint256 public constant ALLOWANCE_PERIOD  = 1 days;

    event Registered(address indexed user, address indexed inviter, uint256 starter);
    event AllowanceClaimed(address indexed user, uint256 amount);

    error AlreadyRegistered();
    error NotRegistered();
    error AllowanceCooldown(uint256 secondsRemaining);
    error CannotInviteSelf();

    /// @notice Self-register and receive a one-time PachiUSD starter grant.
    /// `_inviter` is recorded for analytics but doesn't gate registration on
    /// testnet. Pass `address(0)` for no inviter.
    function register(address _inviter) external {
        LibPachi.Storage storage s = LibPachi.s();
        if (s.registered[msg.sender]) revert AlreadyRegistered();
        if (_inviter == msg.sender) revert CannotInviteSelf();

        s.registered[msg.sender] = true;
        s.registeredAt[msg.sender] = block.timestamp;
        s.inviter[msg.sender] = _inviter;
        // First claim is available immediately. Set lastClaim to 0 so
        // claimDailyAllowance succeeds on first call.
        s.lastAllowanceClaim[msg.sender] = 0;

        IPachiUSD(address(s.token)).mint(msg.sender, STARTER_GRANT);
        emit Registered(msg.sender, _inviter, STARTER_GRANT);
    }

    /// @notice Claim the daily allowance — once per ALLOWANCE_PERIOD.
    /// Resets to "now" on each successful claim, so two claims must be
    /// >24h apart from each other.
    function claimDailyAllowance() external {
        LibPachi.Storage storage s = LibPachi.s();
        if (!s.registered[msg.sender]) revert NotRegistered();
        uint256 last = s.lastAllowanceClaim[msg.sender];
        if (last != 0 && block.timestamp < last + ALLOWANCE_PERIOD) {
            revert AllowanceCooldown(last + ALLOWANCE_PERIOD - block.timestamp);
        }
        s.lastAllowanceClaim[msg.sender] = block.timestamp;
        IPachiUSD(address(s.token)).mint(msg.sender, DAILY_ALLOWANCE);
        emit AllowanceClaimed(msg.sender, DAILY_ALLOWANCE);
    }

    // ── Views ──────────────────────────────────────────────────────────

    function isRegistered(address user) external view returns (bool) {
        return LibPachi.s().registered[user];
    }

    function inviterOf(address user) external view returns (address) {
        return LibPachi.s().inviter[user];
    }

    function registeredAt(address user) external view returns (uint256) {
        return LibPachi.s().registeredAt[user];
    }

    /// @notice Returns the unix timestamp when `user` can next claim. 0 if
    /// they can claim now (either never claimed, or cooldown expired).
    function nextAllowanceAt(address user) external view returns (uint256) {
        LibPachi.Storage storage s = LibPachi.s();
        uint256 last = s.lastAllowanceClaim[user];
        if (last == 0) return 0;
        uint256 next = last + ALLOWANCE_PERIOD;
        return next > block.timestamp ? next : 0;
    }
}
