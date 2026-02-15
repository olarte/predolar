// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {IStablecoinExchange} from "./interfaces/IStablecoinExchange.sol";

contract DailyMarket {
    using SafeERC20 for IERC20;

    IERC20 public immutable stablecoin;
    IStablecoinExchange public immutable stablecoinExchange;
    address public immutable agent;

    OutcomeToken public yesToken;
    OutcomeToken public noToken;

    uint256 public immutable dateKey;
    uint256 public immutable threshold;
    uint256 public immutable closeTimestamp;

    bool public resolved;
    bool public yesWins;
    uint256 public finalTRM;

    event PositionMinted(address indexed user, uint256 collateral);
    event LiquiditySeeded(
        uint256 stableBidPerToken,
        uint256 outcomeAskPerToken,
        int16 bidTick,
        int16 askTick,
        uint64 yesBidOrderId,
        uint64 yesAskOrderId,
        uint64 noBidOrderId,
        uint64 noAskOrderId
    );
    event Resolved(uint256 finalTRM, bool yesWins);
    event Redeemed(address indexed user, uint256 amountOut);

    error NotAgent();
    error MarketClosed();
    error AlreadyResolved();
    error NotResolved();
    error ZeroAmount();
    error AmountTooLarge();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(
        address stablecoin_,
        address stablecoinExchange_,
        address agent_,
        uint256 dateKey_,
        uint256 threshold_,
        uint256 closeTimestamp_
    ) {
        stablecoin = IERC20(stablecoin_);
        stablecoinExchange = IStablecoinExchange(stablecoinExchange_);
        agent = agent_;
        dateKey = dateKey_;
        threshold = threshold_;
        closeTimestamp = closeTimestamp_;

        yesToken = new OutcomeToken(_tokenName("PREDOLAR YES "), _symbol("Y"), address(this));
        noToken = new OutcomeToken(_tokenName("PREDOLAR NO "), _symbol("N"), address(this));
    }

    function mintPosition(uint256 collateralAmount) external {
        if (block.timestamp >= closeTimestamp) revert MarketClosed();
        if (resolved) revert AlreadyResolved();
        if (collateralAmount == 0) revert ZeroAmount();

        stablecoin.safeTransferFrom(msg.sender, address(this), collateralAmount);
        yesToken.mint(msg.sender, collateralAmount);
        noToken.mint(msg.sender, collateralAmount);

        emit PositionMinted(msg.sender, collateralAmount);
    }

    function seedLiquidity(uint256 stableBidPerToken, uint256 outcomeAskPerToken, int16 bidTick, int16 askTick)
        external
        onlyAgent
    {
        if (resolved) revert AlreadyResolved();
        if (stableBidPerToken == 0 || outcomeAskPerToken == 0) revert ZeroAmount();
        if (stableBidPerToken > type(uint128).max || outcomeAskPerToken > type(uint128).max) revert AmountTooLarge();

        uint256 stableTotal = stableBidPerToken * 2;
        stablecoin.safeTransferFrom(msg.sender, address(this), stableTotal);

        yesToken.mint(address(this), outcomeAskPerToken);
        noToken.mint(address(this), outcomeAskPerToken);

        stablecoin.forceApprove(address(stablecoinExchange), stableTotal);
        yesToken.approve(address(stablecoinExchange), outcomeAskPerToken);
        noToken.approve(address(stablecoinExchange), outcomeAskPerToken);

        uint64 yesBidOrderId = stablecoinExchange.place(address(yesToken), uint128(stableBidPerToken), true, bidTick);
        uint64 yesAskOrderId = stablecoinExchange.place(address(yesToken), uint128(outcomeAskPerToken), false, askTick);
        uint64 noBidOrderId = stablecoinExchange.place(address(noToken), uint128(stableBidPerToken), true, bidTick);
        uint64 noAskOrderId = stablecoinExchange.place(address(noToken), uint128(outcomeAskPerToken), false, askTick);

        emit LiquiditySeeded(
            stableBidPerToken,
            outcomeAskPerToken,
            bidTick,
            askTick,
            yesBidOrderId,
            yesAskOrderId,
            noBidOrderId,
            noAskOrderId
        );
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
