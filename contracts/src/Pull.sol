// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Pull — gacha card #1 of the PULL feed
/// @notice Single-tap weighted-multiplier slot. v1 randomness uses prevrandao
/// + sender + nonce. NOT secure for mainnet — replace with a VRF before
/// touching real money.
contract Pull {
    IERC20 public immutable token;
    address public owner;

    uint256 public stake;
    uint256 public nonce;

    // Outcome table, in basis points of stake. Cumulative weights sum to 10000.
    // Expected return = sum(weight * mult) / 10_000^2 = ~98% (2% house edge).
    uint16[6] public weights = [6500, 2000, 1000, 400, 90, 10];        // 65/20/10/4/0.9/0.1 %
    uint32[6] public multsBps = [0, 15000, 20000, 50000, 200000, 1000000]; // 0x, 1.5x, 2x, 5x, 20x, 100x

    event Pulled(address indexed player, uint256 stake, uint256 multBps, uint256 payout, uint256 nonce);
    event Funded(address indexed from, uint256 amount);
    event StakeChanged(uint256 oldStake, uint256 newStake);

    error NotOwner();
    error BankrollTooLow();

    constructor(address _token, uint256 _stake) {
        token = IERC20(_token);
        owner = msg.sender;
        stake = _stake;
    }

    function pull() external returns (uint256 multBps, uint256 payout) {
        token.transferFrom(msg.sender, address(this), stake);

        // Bankroll guard: refuse if we can't cover the max payout.
        uint256 maxPayout = (stake * multsBps[5]) / 10_000;
        if (token.balanceOf(address(this)) < maxPayout) revert BankrollTooLow();

        unchecked { nonce++; }

        uint256 r = uint256(
            keccak256(abi.encode(block.prevrandao, msg.sender, nonce, block.number))
        ) % 10_000;

        uint256 cum;
        for (uint256 i = 0; i < 6; i++) {
            cum += weights[i];
            if (r < cum) {
                multBps = multsBps[i];
                break;
            }
        }

        payout = (stake * multBps) / 10_000;
        if (payout > 0) token.transfer(msg.sender, payout);

        emit Pulled(msg.sender, stake, multBps, payout, nonce);
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
