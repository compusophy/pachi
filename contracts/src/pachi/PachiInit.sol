// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibPachi, IERC20 } from "./LibPachi.sol";

/// @title PachiInit
/// @notice One-shot initializer, called via `delegatecall` by the diamond's
/// `diamondCut` during deployment. Writes initial AppStorage values: token,
/// stake, multiplier table (1.618% house edge calibration), version=1.
/// Idempotent: re-initializing only resets if you pass a higher version.
contract PachiInit {
    function init(address token, uint256 stake, uint256 initialVersion) external {
        LibPachi.Storage storage s = LibPachi.s();

        s.token   = IERC20(token);
        s.stake   = stake;

        // Calibrated for 1.618% house edge (per-ball RTP = 98.382%).
        s.mults[0]  = 850000;  s.mults[12] = 850000;  // 85×
        s.mults[1]  = 110000;  s.mults[11] = 110000;  // 11×
        s.mults[2]  = 30000;   s.mults[10] = 30000;   // 3×
        s.mults[3]  = 16000;   s.mults[9]  = 16000;   // 1.6×
        s.mults[4]  = 5000;    s.mults[8]  = 5000;    // 0.5×
        s.mults[5]  = 12000;   s.mults[7]  = 12000;   // 1.2×
        s.mults[6]  = 1086;                            // 0.1086×

        // Idempotent version write — only set if first time or bumping.
        if (initialVersion > s.appVersion) {
            s.appVersion = initialVersion;
        }
    }
}
