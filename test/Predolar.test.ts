import { expect } from "chai";
import { ethers } from "hardhat";

describe("Predolar MVP", function () {
  it("runs daily market lifecycle", async function () {
    const [owner, agent, user] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20");
    const stable = await MockToken.deploy("USD Coin", "USDC", 6);
    await stable.waitForDeployment();

    const Factory = await ethers.getContractFactory("MarketFactory");
    const factory = await Factory.deploy(
      owner.address,
      await stable.getAddress(),
      ethers.ZeroAddress,
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

    await stable.mint(agent.address, ethers.parseUnits("1000", 6));
    await stable
      .connect(agent)
      .approve(marketAddress, ethers.parseUnits("200", 6));

    await market
      .connect(agent)
      .seedLiquidity(ethers.parseUnits("100", 6), ethers.parseUnits("100", 6));

    await stable.mint(user.address, ethers.parseUnits("50", 6));
    await stable.connect(user).approve(marketAddress, ethers.parseUnits("50", 6));
    await market.connect(user).mintPosition(ethers.parseUnits("50", 6));

    expect(await yes.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 6));
    expect(await no.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 6));

    await ethers.provider.send("evm_increaseTime", [70]);
    await ethers.provider.send("evm_mine", []);

    await market.connect(agent).resolve(4250);
    await market.connect(user).redeem();

    expect(await stable.balanceOf(user.address)).to.equal(ethers.parseUnits("50", 6));
  });
});
