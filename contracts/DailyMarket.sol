// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

contract DailyMarket {
    using SafeERC20 for IERC20;

    IERC20 public immutable stablecoin;
    address public immutable agent;

    OutcomeToken public yesToken;
    OutcomeToken public noToken;

    uint256 public immutable dateKey;
    uint256 public immutable threshold;
    uint256 public immutable closeTimestamp;

    // CPMM reserves for YES and NO books (all values are 6-decimal units).
    uint256 public reserveStableYes;
    uint256 public reserveYes;
    uint256 public reserveStableNo;
    uint256 public reserveNo;

    bool public resolved;
    bool public yesWins;
    uint256 public finalTRM;

    event PositionMinted(address indexed user, uint256 collateral);
    event LiquiditySeeded(uint256 stablePerSide, uint256 outcomePerSide);
    event Swapped(address indexed user, bool indexed isYes, bool indexed isBuy, uint256 amountIn, uint256 amountOut);
    event Resolved(uint256 finalTRM, bool yesWins);
    event Redeemed(address indexed user, uint256 amountOut);

    error NotAgent();
    error MarketClosed();
    error AlreadyResolved();
    error NotResolved();
    error ZeroAmount();
    error InsufficientLiquidity();
    error SlippageExceeded();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier marketOpen() {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= closeTimestamp) revert MarketClosed();
        _;
    }

    constructor(
        address stablecoin_,
        address,
        address agent_,
        uint256 dateKey_,
        uint256 threshold_,
        uint256 closeTimestamp_
    ) {
        stablecoin = IERC20(stablecoin_);
        agent = agent_;
        dateKey = dateKey_;
        threshold = threshold_;
        closeTimestamp = closeTimestamp_;

        yesToken = new OutcomeToken(_tokenName("PREDOLAR YES "), _symbol("Y"), address(this), 6);
        noToken = new OutcomeToken(_tokenName("PREDOLAR NO "), _symbol("N"), address(this), 6);
    }

    function mintPosition(uint256 collateralAmount) external marketOpen {
        if (collateralAmount == 0) revert ZeroAmount();

        stablecoin.safeTransferFrom(msg.sender, address(this), collateralAmount);
        yesToken.mint(msg.sender, collateralAmount);
        noToken.mint(msg.sender, collateralAmount);

        emit PositionMinted(msg.sender, collateralAmount);
    }

    function seedLiquidity(uint256 stablePerSide, uint256 outcomePerSide) external onlyAgent marketOpen {
        if (stablePerSide == 0 || outcomePerSide == 0) revert ZeroAmount();

        uint256 stableTotal = stablePerSide * 2;
        stablecoin.safeTransferFrom(msg.sender, address(this), stableTotal);

        yesToken.mint(address(this), outcomePerSide);
        noToken.mint(address(this), outcomePerSide);

        reserveStableYes += stablePerSide;
        reserveYes += outcomePerSide;
        reserveStableNo += stablePerSide;
        reserveNo += outcomePerSide;

        emit LiquiditySeeded(stablePerSide, outcomePerSide);
    }

    function buyYes(uint256 stableAmountIn, uint256 minYesOut) external marketOpen returns (uint256 yesOut) {
        if (stableAmountIn == 0) revert ZeroAmount();
        yesOut = _getAmountOut(stableAmountIn, reserveStableYes, reserveYes);
        if (yesOut == 0) revert InsufficientLiquidity();
        if (yesOut < minYesOut) revert SlippageExceeded();

        stablecoin.safeTransferFrom(msg.sender, address(this), stableAmountIn);
        yesToken.transfer(msg.sender, yesOut);

        reserveStableYes += stableAmountIn;
        reserveYes -= yesOut;

        emit Swapped(msg.sender, true, true, stableAmountIn, yesOut);
    }

    function sellYes(uint256 yesAmountIn, uint256 minStableOut) external marketOpen returns (uint256 stableOut) {
        if (yesAmountIn == 0) revert ZeroAmount();
        stableOut = _getAmountOut(yesAmountIn, reserveYes, reserveStableYes);
        if (stableOut == 0) revert InsufficientLiquidity();
        if (stableOut < minStableOut) revert SlippageExceeded();

        yesToken.transferFrom(msg.sender, address(this), yesAmountIn);
        stablecoin.safeTransfer(msg.sender, stableOut);

        reserveYes += yesAmountIn;
        reserveStableYes -= stableOut;

        emit Swapped(msg.sender, true, false, yesAmountIn, stableOut);
    }

    function buyNo(uint256 stableAmountIn, uint256 minNoOut) external marketOpen returns (uint256 noOut) {
        if (stableAmountIn == 0) revert ZeroAmount();
        noOut = _getAmountOut(stableAmountIn, reserveStableNo, reserveNo);
        if (noOut == 0) revert InsufficientLiquidity();
        if (noOut < minNoOut) revert SlippageExceeded();

        stablecoin.safeTransferFrom(msg.sender, address(this), stableAmountIn);
        noToken.transfer(msg.sender, noOut);

        reserveStableNo += stableAmountIn;
        reserveNo -= noOut;

        emit Swapped(msg.sender, false, true, stableAmountIn, noOut);
    }

    function sellNo(uint256 noAmountIn, uint256 minStableOut) external marketOpen returns (uint256 stableOut) {
        if (noAmountIn == 0) revert ZeroAmount();
        stableOut = _getAmountOut(noAmountIn, reserveNo, reserveStableNo);
        if (stableOut == 0) revert InsufficientLiquidity();
        if (stableOut < minStableOut) revert SlippageExceeded();

        noToken.transferFrom(msg.sender, address(this), noAmountIn);
        stablecoin.safeTransfer(msg.sender, stableOut);

        reserveNo += noAmountIn;
        reserveStableNo -= stableOut;

        emit Swapped(msg.sender, false, false, noAmountIn, stableOut);
    }

    function quoteBuyYes(uint256 stableAmountIn) external view returns (uint256) {
        return _getAmountOut(stableAmountIn, reserveStableYes, reserveYes);
    }

    function quoteSellYes(uint256 yesAmountIn) external view returns (uint256) {
        return _getAmountOut(yesAmountIn, reserveYes, reserveStableYes);
    }

    function quoteBuyNo(uint256 stableAmountIn) external view returns (uint256) {
        return _getAmountOut(stableAmountIn, reserveStableNo, reserveNo);
    }

    function quoteSellNo(uint256 noAmountIn) external view returns (uint256) {
        return _getAmountOut(noAmountIn, reserveNo, reserveStableNo);
    }

    function resolve(uint256 finalTRM_) external onlyAgent {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < closeTimestamp) revert MarketClosed();

        resolved = true;
        finalTRM = finalTRM_;
        yesWins = finalTRM_ >= threshold;

        emit Resolved(finalTRM_, yesWins);
    }

    function redeem() external {
        if (!resolved) revert NotResolved();

        uint256 payout;
        if (yesWins) {
            payout = yesToken.balanceOf(msg.sender);
            yesToken.burnFromMarket(msg.sender, payout);
        } else {
            payout = noToken.balanceOf(msg.sender);
            noToken.burnFromMarket(msg.sender, payout);
        }
        if (payout == 0) revert ZeroAmount();

        stablecoin.safeTransfer(msg.sender, payout);
        emit Redeemed(msg.sender, payout);
    }

    function winningToken() external view returns (address) {
        if (!resolved) return address(0);
        return yesWins ? address(yesToken) : address(noToken);
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    function _tokenName(string memory prefix) internal view returns (string memory) {
        return string(abi.encodePacked(prefix, _dateString(dateKey)));
    }

    function _symbol(string memory side) internal view returns (string memory) {
        return string(abi.encodePacked(side, _dateString(dateKey)));
    }

    function _dateString(uint256 yyyymmdd) internal pure returns (string memory) {
        return _uintToString(yyyymmdd);
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
