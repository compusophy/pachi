// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PachiUSD — the in-game currency
/// @notice Mint-controlled TIP-20. The owner sets a single minter (the Pachi
/// diamond) which is the only address that can call `mint`. Holders can burn
/// their own balance. Standard transfer/approve mechanics otherwise.
/// 6 decimals to match AlphaUSD and the rest of the stack.
contract PachiUSD {
    string public constant name     = "Pachi USD";
    string public constant symbol   = "pUSD";
    uint8  public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;
    address public minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event MinterChanged(address indexed oldMinter, address indexed newMinter);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error NotMinter();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address _owner) {
        owner = _owner;
        emit OwnerChanged(address(0), _owner);
    }

    function setMinter(address _minter) external {
        if (msg.sender != owner) revert NotOwner();
        emit MinterChanged(minter, _minter);
        minter = _minter;
    }

    function transferOwnership(address _newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnerChanged(owner, _newOwner);
        owner = _newOwner;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        unchecked {
            totalSupply += amount;
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] -= amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 current = allowance[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < amount) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = current - amount; }
        }
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
