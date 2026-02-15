import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  const stablecoinAddress = process.env.STABLECOIN_ADDRESS;
  const stablecoinExchangeAddress =
    process.env.STABLECOIN_EXCHANGE_ADDRESS || process.env.DEX_ROUTER_ADDRESS;
  const agentAddress = process.env.AGENT_ADDRESS || deployer.address;

  if (!stablecoinAddress || !stablecoinExchangeAddress) {
    throw new Error("Set STABLECOIN_ADDRESS and STABLECOIN_EXCHANGE_ADDRESS in env");
  }

  const Factory = await ethers.getContractFactory("MarketFactory");
  const factory = await Factory.deploy(deployer.address, stablecoinAddress, stablecoinExchangeAddress, agentAddress);
  await factory.waitForDeployment();

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("Factory:", await factory.getAddress());
  console.log("Stablecoin:", stablecoinAddress);
  console.log("Stablecoin Exchange:", stablecoinExchangeAddress);
  console.log("Agent:", agentAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
