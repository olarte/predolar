// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStablecoinExchange {
    function place(address token, uint128 amount, bool isBid, int16 tick) external returns (uint64 orderId);

    function placeFlip(address token, uint128 amount, bool isBid, int16 tick, int16 flipTick)
        external
        returns (uint64 orderId);

    function quoteSwapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn)
        external
        view
        returns (uint128 amountOut);

    function swapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn, uint128 minAmountOut)
        external
        returns (uint128 amountOut);
}
