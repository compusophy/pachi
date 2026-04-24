// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi, IERC20 } from "./LibPachi.sol";

/// @title PhaseTwoInit
/// @notice One-shot init called via `delegatecall` during the Phase 2 cut.
/// Switches `s.token` from AlphaUSD to PachiUSD (so GameFacet now stakes
/// PachiUSD), and bumps `appVersion` to 2 so old v1 clients hit the
/// stale-modal pre-flight gate before they can submit a broken tx.
contract PhaseTwoInit {
    function init(address pachiUsd, uint256 newVersion) external {
        LibPachi.Storage storage s = LibPachi.s();
        s.token = IERC20(pachiUsd);
        if (newVersion > s.appVersion) s.appVersion = newVersion;
    }
}
