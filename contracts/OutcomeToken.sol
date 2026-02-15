// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract OutcomeToken is ERC20 {
    address public immutable market;
    uint8 public immutable tokenDecimals;

    error NotMarket();

    modifier onlyMarket() {
        if (msg.sender != market) revert NotMarket();
        _;
    }

    constructor(string memory name_, string memory symbol_, address market_, uint8 decimals_) ERC20(name_, symbol_) {
        market = market_;
        tokenDecimals = decimals_;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burnFromMarket(address account, uint256 amount) external onlyMarket {
        _burn(account, amount);
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }
}
