import { expect } from "chai";
import { ethers } from "hardhat";

describe("Predolar MVP", function () {
  it("runs daily market lifecycle", async function () {
    const [owner, agent, user] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    const stable = await MockToken.deploy("USD Coin", "USDC");
    await stable.waitForDeployment();

    const MockExchange = await ethers.getContractFactory("MockStablecoinExchange");
    const exchange = await MockExchange.deploy();
    await exchange.waitForDeployment();

    const Factory = await ethers.getContractFactory("MarketFactory");
    const factory = await Factory.deploy(
      owner.address,
      await stable.getAddress(),
      await exchange.getAddress(),
      agent.address
    );
    await factory.waitForDeployment();

    const now = await ethers.provider.getBlock("latest");
    const closeTimestamp = (now?.timestamp || 0) + 60;

    await factory.connect(agent).createMarket(20260214, 4200, closeTimestamp);
    const marketAddress = await factory.markets(20260214);

    const market = await ethers.getContractAt("DailyMarket", marketAddress);
    const yesTokenAddress = await market.yesToken();
    const noTokenAddress = await market.noToken();

    const yes = await ethers.getContractAt("OutcomeToken", yesTokenAddress);
    const no = await ethers.getContractAt("OutcomeToken", noTokenAddress);

    await exchange.setQuoteToken(yesTokenAddress, await stable.getAddress());
    await exchange.setQuoteToken(noTokenAddress, await stable.getAddress());

    await stable.mint(agent.address, ethers.parseUnits("1000", 18));
    await stable
      .connect(agent)
      .approve(marketAddress, ethers.parseUnits("200", 18));

    await market
      .connect(agent)
      .seedLiquidity(ethers.parseUnits("100", 18), ethers.parseUnits("100", 18), -250, 250);

    await stable.mint(user.address, ethers.parseUnits("50", 18));
    await stable.connect(user).approve(marketAddress, ethers.parseUnits("50", 18));
    await market.connect(user).mintPosition(ethers.parseUnits("50", 18));

    expect(await yes.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 18));
    expect(await no.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 18));

    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine", []);

    await market.connect(agent).resolve(4250);
    await market.connect(user).redeem();

    expect(await stable.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 18));
  });
});
