// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockStablecoinExchange {
    using SafeERC20 for IERC20;

    uint64 public nextOrderId = 1;
    mapping(address => address) public quoteTokenOf;

    event MockOrderPlaced(uint64 indexed orderId, address indexed maker, address indexed token, uint128 amount, bool isBid, int16 tick);

    function setQuoteToken(address baseToken, address quoteToken) external {
        quoteTokenOf[baseToken] = quoteToken;
    }

    function place(address token, uint128 amount, bool isBid, int16 tick) external returns (uint64 orderId) {
        return _place(token, amount, isBid, tick);
    }

    function _place(address token, uint128 amount, bool isBid, int16 tick) internal returns (uint64 orderId) {
        address spendToken = isBid ? quoteTokenOf[token] : token;
        require(spendToken != address(0), "quote token missing");

        IERC20(spendToken).safeTransferFrom(msg.sender, address(this), amount);

        orderId = nextOrderId++;
        emit MockOrderPlaced(orderId, msg.sender, token, amount, isBid, tick);
    }

    function placeFlip(address token, uint128 amount, bool isBid, int16 tick, int16)
        external
        returns (uint64 orderId)
    {
        return _place(token, amount, isBid, tick);
    }

    function quoteSwapExactAmountIn(address, address, uint128 amountIn) external pure returns (uint128 amountOut) {
        return amountIn;
    }

    function swapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn, uint128)
        external
        returns (uint128 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountIn);
        return amountIn;
    }
}
