import "dotenv/config";
import {
  Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

type AgentMode = "create" | "resolve";

const FACTORY_ABI = parseAbi([
  "function createMarket(uint256 dateKey, uint256 threshold, uint256 closeTimestamp) external returns (address)",
  "function markets(uint256 dateKey) external view returns (address)",
  "function stablecoin() external view returns (address)"
]);

const MARKET_ABI = parseAbi([
  "function seedLiquidity(uint256 stableBidPerToken, uint256 outcomeAskPerToken, int16 bidTick, int16 askTick) external",
  "function resolve(uint256 finalTRM) external",
  "function closeTimestamp() external view returns (uint256)"
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)"
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getColombiaNowParts() {
  const nowUtcMs = Date.now();
  const cotMs = nowUtcMs - 5 * 60 * 60 * 1000;
  const d = new Date(cotMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

function buildDateKey(year: number, month: number, day: number) {
  return year * 10000 + month * 100 + day;
}

function closeTimestampForColombiaDay(year: number, month: number, day: number) {
  return Math.floor(Date.UTC(year, month - 1, day, 23, 59, 0) / 1000) + 5 * 60 * 60;
}

function nearestTen(value: number) {
  return Math.round(value / 10) * 10;
}

async function fetchTRM() {
  const endpoint =
    process.env.TRM_API_URL ||
    "https://www.datos.gov.co/resource/32sa-8pi3.json?$select=valor&$order=vigenciadesde%20DESC&$limit=1";

  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`TRM request failed: ${response.status}`);

  const data = (await response.json()) as Array<Record<string, string>>;
  if (!Array.isArray(data) || data.length === 0) throw new Error("TRM response is empty");

  const raw = (data[0].valor || "").replace(/\./g, "").replace(",", ".");
  const trm = Number(raw);
  if (!Number.isFinite(trm)) throw new Error(`Cannot parse TRM value: ${data[0].valor}`);

  return trm;
}

function buildClients() {
  const rpcUrl = process.env.TEMPO_RPC_URL;
  const chainId = Number(process.env.TEMPO_CHAIN_ID || 42431);
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;

  if (!rpcUrl || !privateKey) throw new Error("Set TEMPO_RPC_URL and DEPLOYER_PRIVATE_KEY in env");

  const chain = defineChain({
    id: chainId,
    name: "Tempo Testnet (Moderato)",
    nativeCurrency: { name: "USD", symbol: "USD", decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return { publicClient, walletClient, account };
}

async function createFlow(factoryAddress: Address, liquidityStablePerToken: string, outcomeAskPerToken: string, bidTick: number, askTick: number) {
  const { publicClient, walletClient, account } = buildClients();

  const { year, month, day } = getColombiaNowParts();
  const dateKey = BigInt(buildDateKey(year, month, day));
  const trm = await fetchTRM();
  const threshold = BigInt(nearestTen(trm));
  const closeTimestamp = BigInt(closeTimestampForColombiaDay(year, month, day));

  const existing = (await publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "markets",
    args: [dateKey]
  })) as Address;

  if (existing.toLowerCase() !== ZERO_ADDRESS) {
    console.log("Market already exists:", existing);
    return;
  }

  const createHash = await walletClient.writeContract({
    account,
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "createMarket",
    args: [dateKey, threshold, closeTimestamp]
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });

  const marketAddress = (await publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "markets",
    args: [dateKey]
  })) as Address;

  const stablecoin = (await publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "stablecoin"
  })) as Address;

  const skipSeed = (process.env.SKIP_SEED_LIQUIDITY || "").toLowerCase() === "true";
  if (!skipSeed) {
    const stableBidAmount = parseUnits(liquidityStablePerToken, 6);
    const outcomeAskAmount = parseUnits(outcomeAskPerToken, 6);

    const approveHash = await walletClient.writeContract({
      account,
      address: stablecoin,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [marketAddress, stableBidAmount * 2n]
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    try {
      const seedHash = await walletClient.writeContract({
        account,
        address: marketAddress,
        abi: MARKET_ABI,
        functionName: "seedLiquidity",
        args: [stableBidAmount, outcomeAskAmount, bidTick, askTick]
      });
      await publicClient.waitForTransactionReceipt({ hash: seedHash });
      console.log("Liquidity seeded");
    } catch (error) {
      console.warn("Liquidity seeding failed; continuing with market created.");
      console.warn("Set SKIP_SEED_LIQUIDITY=true to skip this step explicitly.");
      console.warn(error);
    }
  } else {
    console.log("Skipping liquidity seeding (SKIP_SEED_LIQUIDITY=true)");
  }

  console.log("Created market", marketAddress);
  console.log("TRM", trm, "threshold", Number(threshold), "dateKey", Number(dateKey));
}

async function resolveFlow(factoryAddress: Address, dateKeyRaw: number) {
  const { publicClient, walletClient, account } = buildClients();
  const dateKey = BigInt(dateKeyRaw);

  const marketAddress = (await publicClient.readContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: "markets",
    args: [dateKey]
  })) as Address;

  if (marketAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`No market found for dateKey ${dateKeyRaw}`);
  }

  const close = (await publicClient.readContract({
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "closeTimestamp"
  })) as bigint;

  if (BigInt(Math.floor(Date.now() / 1000)) < close) {
    throw new Error("Market is not closed yet");
  }

  const trm = await fetchTRM();
  const finalTRM = BigInt(Math.round(trm));

  const resolveHash = await walletClient.writeContract({
    account,
    address: marketAddress,
    abi: MARKET_ABI,
    functionName: "resolve",
    args: [finalTRM]
  });
  await publicClient.waitForTransactionReceipt({ hash: resolveHash });

  console.log("Resolved market", marketAddress, "with TRM", Number(finalTRM));
}

async function main() {
  const mode = (process.env.AGENT_MODE || "create") as AgentMode;
  const factoryAddress = process.env.MARKET_FACTORY_ADDRESS as Address | undefined;

  if (!factoryAddress) throw new Error("Set MARKET_FACTORY_ADDRESS in env");

  if (mode === "create") {
    const liquidityStablePerToken = process.env.SEED_LIQUIDITY_STABLE_BID_PER_TOKEN || "100";
    const outcomeAskPerToken = process.env.SEED_LIQUIDITY_OUTCOME_ASK_PER_TOKEN || "100";
    const bidTick = Number(process.env.SEED_BID_TICK || -250);
    const askTick = Number(process.env.SEED_ASK_TICK || 250);
    await createFlow(factoryAddress, liquidityStablePerToken, outcomeAskPerToken, bidTick, askTick);
    return;
  }

  if (!process.env.RESOLVE_DATE_KEY) throw new Error("Set RESOLVE_DATE_KEY=YYYYMMDD for resolve mode");

  await resolveFlow(factoryAddress, Number(process.env.RESOLVE_DATE_KEY));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
