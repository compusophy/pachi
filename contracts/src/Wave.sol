// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Wave — perpetual altitude card
/// @notice Player picks a target multiplier; contract rolls a Pareto-distributed
/// crash multiplier (2% house edge, RTP 98% at every target). Survive → payout.
/// v1 randomness uses prevrandao + sender + nonce. NOT secure for mainnet —
/// replace with a VRF before touching real money.
contract Wave {
    IERC20 public immutable token;
    address public owner;

    uint256 public stake;        // base stake per play
    uint256 public nonce;        // global, used in entropy
    uint256 public constant MIN_TARGET = 10_000;        // 1.00x
    uint256 public constant MAX_PAYOUT_BPS = 100_000_000; // 10_000x cap
    uint256 public constant HOUSE_EDGE_BPS = 200;       // 2% instant-crash band
    uint256 public constant RTP_NUM = 9_800;            // (1 - house_edge) * 10_000

    mapping(address => uint256) public streak;
    mapping(address => uint256) public bestStreak;
    mapping(address => uint256) public lifetimePulls;

    event Played(
        address indexed player,
        uint256 stake,
        uint256 targetBps,
        uint256 crashBps,
        uint256 payout,
        uint256 streakAfter,
        uint256 nonce
    );
    event Funded(address indexed from, uint256 amount);
    event StakeChanged(uint256 oldStake, uint256 newStake);

    error NotOwner();
    error TargetTooLow();
    error TargetTooHigh();
    error BankrollTooLow();

    constructor(address _token, uint256 _stake) {
        token = IERC20(_token);
        owner = msg.sender;
        stake = _stake;
    }

    /// @notice Play one round. Survive iff targetBps <= rolled crashBps.
    function play(uint256 targetBps) external returns (uint256 crashBps, uint256 payout) {
        if (targetBps < MIN_TARGET) revert TargetTooLow();
        if (targetBps > MAX_PAYOUT_BPS) revert TargetTooHigh();

        token.transferFrom(msg.sender, address(this), stake);

        // Bankroll guard: must be able to cover the player's claimed payout.
        uint256 claimed = (stake * targetBps) / 10_000;
        if (token.balanceOf(address(this)) < claimed) revert BankrollTooLow();

        unchecked { nonce++; lifetimePulls[msg.sender]++; }

        crashBps = _crash(uint256(keccak256(abi.encode(
            msg.sender, nonce, block.prevrandao, block.number
        ))));

        if (targetBps <= crashBps) {
            payout = claimed;
            token.transfer(msg.sender, payout);
            unchecked { streak[msg.sender]++; }
            if (streak[msg.sender] > bestStreak[msg.sender]) {
                bestStreak[msg.sender] = streak[msg.sender];
            }
        } else {
            streak[msg.sender] = 0;
        }

        emit Played(msg.sender, stake, targetBps, crashBps, payout, streak[msg.sender], nonce);
    }

    /// @notice Aviator-style Pareto distribution with 2% house edge.
    /// P(crash >= T) = 0.98 / T  for T >= 1.0x; 2% of rolls are instant crash (crashBps = 0).
    /// Expected payout = T * P(crash >= T) * stake = 0.98 * stake. RTP is 98% at every target.
    function _crash(uint256 entropy) internal pure returns (uint256) {
        uint256 r = entropy % 10_000;
        if (r < HOUSE_EDGE_BPS) return 0; // instant crash
        uint256 result = (RTP_NUM * 10_000) / (10_000 - r);
        if (result > MAX_PAYOUT_BPS) result = MAX_PAYOUT_BPS;
        return result;
    }

    function fund(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setStake(uint256 newStake) external {
        if (msg.sender != owner) revert NotOwner();
        emit StakeChanged(stake, newStake);
        stake = newStake;
    }

    function withdraw(uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        token.transfer(owner, amount);
    }

    function bankroll() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
