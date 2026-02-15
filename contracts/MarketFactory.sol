// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DailyMarket} from "./DailyMarket.sol";

contract MarketFactory is Ownable {
    address public immutable stablecoin;
    address public immutable stablecoinExchange;

    address public agent;
    address public currentMarket;
    uint256 public currentDateKey;

    mapping(uint256 => address) public markets;

    event AgentUpdated(address indexed newAgent);
    event MarketCreated(uint256 indexed dateKey, address indexed market, uint256 threshold, uint256 closeTimestamp);

    error NotAgent();
    error MarketAlreadyExists();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address owner_, address stablecoin_, address stablecoinExchange_, address agent_) Ownable(owner_) {
        stablecoin = stablecoin_;
        stablecoinExchange = stablecoinExchange_;
        agent = agent_;
    }

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    function createMarket(uint256 dateKey, uint256 threshold, uint256 closeTimestamp) external onlyAgent returns (address market) {
        if (markets[dateKey] != address(0)) revert MarketAlreadyExists();

        market = address(new DailyMarket(stablecoin, stablecoinExchange, agent, dateKey, threshold, closeTimestamp));
        markets[dateKey] = market;
        currentDateKey = dateKey;
        currentMarket = market;

        emit MarketCreated(dateKey, market, threshold, closeTimestamp);
    }

    function getMarket(uint256 dateKey) external view returns (address) {
        return markets[dateKey];
    }
}
