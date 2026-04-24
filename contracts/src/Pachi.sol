// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Pachi — multi-ball Plinko (1, 10, or 100 at a time)
/// @notice play(n) drops n balls (1..100). Each ball has a 12-bit path stored
/// in the event so the frontend can replay the bounce sequence. RTP per ball
/// = ~92.5%, so the house edge is constant across n. v1 randomness uses
/// prevrandao + sender + nonce — NOT secure for mainnet.
contract Pachi {
    IERC20 public immutable token;
    address public owner;

    uint256 public stake;     // per-ball stake
    uint256 public nonce;
    uint256 public constant MAX_BALLS = 100;

    // 13-slot multiplier table (in bps, 10000 = 1.0x). Symmetric, edge-heavy.
    // Calibrated for 1.618% house edge (per-ball RTP = 98.382%) — the golden
    // ratio house edge.
    uint32[13] public mults = [
        850000, 110000, 30000, 16000, 5000, 12000, 1086,
        12000, 5000, 16000, 30000, 110000, 850000
    ];

    mapping(address => uint256) public lifetimeBalls;
    mapping(address => uint256) public bestPayoutBps;  // best totalBps in one play

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
    event Funded(address indexed from, uint256 amount);
    event StakeChanged(uint256 oldStake, uint256 newStake);

    error NotOwner();
    error BallsOutOfRange();
    error BankrollTooLow();

    constructor(address _token, uint256 _stake) {
        token = IERC20(_token);
        owner = msg.sender;
        stake = _stake;
    }

    function play(uint256 n) external returns (
        uint256[] memory paths,
        uint256[] memory ballMults,
        uint256 totalBps,
        uint256 payout
    ) {
        if (n == 0 || n > MAX_BALLS) revert BallsOutOfRange();

        uint256 totalStake = stake * n;
        token.transferFrom(msg.sender, address(this), totalStake);

        // Bankroll: must cover absolute worst case (every ball hits 80x edge slot)
        uint256 maxPayout = (n * uint256(mults[0]) * stake) / 10_000;
        if (token.balanceOf(address(this)) < maxPayout) revert BankrollTooLow();

        unchecked { nonce++; lifetimeBalls[msg.sender] += n; }

        uint256 entropy = uint256(keccak256(abi.encode(
            msg.sender, nonce, block.prevrandao, block.number
        )));

        paths = new uint256[](n);
        ballMults = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 ballSeed = uint256(keccak256(abi.encode(entropy, i + 1)));
            uint256 path = ballSeed & 0xFFF;
            uint256 slot = _popcount12(path);
            paths[i] = path;
            ballMults[i] = mults[slot];
            totalBps += mults[slot];
        }

        payout = (stake * totalBps) / 10_000;
        if (payout > 0) token.transfer(msg.sender, payout);

        if (totalBps > bestPayoutBps[msg.sender]) bestPayoutBps[msg.sender] = totalBps;

        emit Played(msg.sender, stake, n, paths, ballMults, totalBps, payout, nonce);
    }

    function _popcount12(uint256 x) internal pure returns (uint256 c) {
        unchecked {
            for (uint256 i = 0; i < 12; i++) {
                if ((x >> i) & 1 == 1) c++;
            }
        }
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
