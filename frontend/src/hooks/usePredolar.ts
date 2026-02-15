import { useCallback, useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import {
  Address,
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseAbi,
  parseUnits
} from "viem";
import { tempoModerato } from "viem/chains";
import { APP_CONFIG } from "../config/env";

type Side = "YES" | "NO";
type TradeMode = "BUY" | "SELL";

const FACTORY_ABI = parseAbi([
  "function currentMarket() view returns (address)",
  "function stablecoin() view returns (address)"
]);

const MARKET_ABI = parseAbi([
  "function threshold() view returns (uint256)",
  "function closeTimestamp() view returns (uint256)",
  "function yesToken() view returns (address)",
  "function noToken() view returns (address)",
  "function resolved() view returns (bool)",
  "function yesWins() view returns (bool)",
  "function mintPosition(uint256 collateralAmount) external",
  "function redeem() external",
  "function quoteSellYes(uint256 yesAmountIn) view returns (uint256)",
  "function quoteSellNo(uint256 noAmountIn) view returns (uint256)",
  "function quoteBuyYes(uint256 stableAmountIn) view returns (uint256)",
  "function quoteBuyNo(uint256 stableAmountIn) view returns (uint256)",
  "function buyYes(uint256 stableAmountIn, uint256 minYesOut) external returns (uint256)",
  "function sellYes(uint256 yesAmountIn, uint256 minStableOut) external returns (uint256)",
  "function buyNo(uint256 stableAmountIn, uint256 minNoOut) external returns (uint256)",
  "function sellNo(uint256 noAmountIn, uint256 minStableOut) external returns (uint256)"
]);

const MARKET_EVENTS_ABI = parseAbi([
  "event LiquiditySeeded(uint256 stablePerSide, uint256 outcomePerSide)",
  "event Swapped(address indexed user, bool indexed isYes, bool indexed isBuy, uint256 amountIn, uint256 amountOut)"
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type MarketView = {
  threshold: number;
  closeTimestamp: number;
  probabilityYes: number;
  probabilityNo: number;
  resolved: boolean;
  yesWins: boolean;
  marketAddress: Address;
  yesToken: Address;
  noToken: Address;
  stablecoin: Address;
};

export type PortfolioView = {
  yesBalance: string;
  noBalance: string;
  stableBalance: string;
};

export type ProbabilityPoint = {
  timestamp: number;
  yes: number;
  no: number;
};

export type BetActivity = {
  id: string;
  timestamp: number;
  marketAddress: Address;
  action: "BUY" | "SELL" | "MINT" | "CLAIM";
  side?: Side;
  amount: string;
  txHash?: string;
};

function toPct(v: number) {
  if (!Number.isFinite(v) || v <= 0) return 50;
  return Math.min(99, Math.max(1, v));
}

function probsFromReserves(
  reserveStableYes: bigint,
  reserveYes: bigint,
  reserveStableNo: bigint,
  reserveNo: bigint
) {
  if (reserveStableYes <= 0n || reserveYes <= 0n || reserveStableNo <= 0n || reserveNo <= 0n) {
    return { yes: 50, no: 50 };
  }
  const priceYes = Number(reserveStableYes) / Number(reserveYes);
  const priceNo = Number(reserveStableNo) / Number(reserveNo);
  const sum = priceYes + priceNo;
  if (!Number.isFinite(sum) || sum <= 0) return { yes: 50, no: 50 };
  const yes = toPct((priceYes / sum) * 100);
  return { yes, no: toPct(100 - yes) };
}

async function buildHistoryFromEvents(publicClient: any, marketAddress: Address): Promise<ProbabilityPoint[]> {
  const chunkSize = 95_000n;

  async function getEventsChunked(eventName: "LiquiditySeeded" | "Swapped") {
    const latest = (await publicClient.getBlockNumber()) as bigint;
    const logs: any[] = [];

    let fromBlock = 0n;
    while (fromBlock <= latest) {
      const toBlock = fromBlock + chunkSize > latest ? latest : fromBlock + chunkSize;
      const part = await publicClient.getContractEvents({
        address: marketAddress,
        abi: MARKET_EVENTS_ABI,
        eventName,
        fromBlock,
        toBlock
      });
      logs.push(...part);
      fromBlock = toBlock + 1n;
    }

    return logs;
  }

  const [seedLogs, swapLogs] = await Promise.all([
    getEventsChunked("LiquiditySeeded"),
    getEventsChunked("Swapped")
  ]);

  type Row = { type: "seed" | "swap"; blockNumber: bigint; logIndex: bigint; args: any };
  const events: Row[] = [
    ...seedLogs.map((log: any) => ({
      type: "seed" as const,
      blockNumber: (log.blockNumber ?? 0n) as bigint,
      logIndex: BigInt(log.logIndex ?? 0),
      args: log.args
    })),
    ...swapLogs.map((log: any) => ({
      type: "swap" as const,
      blockNumber: (log.blockNumber ?? 0n) as bigint,
      logIndex: BigInt(log.logIndex ?? 0),
      args: log.args
    }))
  ].sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0;
    }
    return a.blockNumber < b.blockNumber ? -1 : 1;
  });

  if (events.length === 0) return [];

  const uniqueBlocks = Array.from(new Set(events.map((e) => e.blockNumber.toString()))).map((v) => BigInt(v));
  const blockPairs = await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      const block = await publicClient.getBlock({ blockNumber });
      return [blockNumber.toString(), Number(block.timestamp) * 1000] as const;
    })
  );
  const blockTime = new Map<string, number>(blockPairs);

  let reserveStableYes = 0n;
  let reserveYes = 0n;
  let reserveStableNo = 0n;
  let reserveNo = 0n;
  const points: ProbabilityPoint[] = [];

  for (const event of events) {
    if (event.type === "seed") {
      const stablePerSide = event.args?.stablePerSide as bigint;
      const outcomePerSide = event.args?.outcomePerSide as bigint;
      reserveStableYes += stablePerSide;
      reserveYes += outcomePerSide;
      reserveStableNo += stablePerSide;
      reserveNo += outcomePerSide;
    } else {
      const isYes = Boolean(event.args?.isYes);
      const isBuy = Boolean(event.args?.isBuy);
      const amountIn = event.args?.amountIn as bigint;
      const amountOut = event.args?.amountOut as bigint;

      if (isYes) {
        if (isBuy) {
          reserveStableYes += amountIn;
          reserveYes -= amountOut;
        } else {
          reserveYes += amountIn;
          reserveStableYes -= amountOut;
        }
      } else if (isBuy) {
        reserveStableNo += amountIn;
        reserveNo -= amountOut;
      } else {
        reserveNo += amountIn;
        reserveStableNo -= amountOut;
      }
    }

    const p = probsFromReserves(reserveStableYes, reserveYes, reserveStableNo, reserveNo);
    const ts = blockTime.get(event.blockNumber.toString()) ?? Date.now();
    points.push({ timestamp: ts, yes: p.yes, no: p.no });
  }

  return points.slice(-500);
}

async function getFeeParams(publicClient: any) {
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas && fees.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas
      };
    }
  } catch {}

  return {
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n
  };
}

async function getGasLimit(publicClient: any, request: any) {
  try {
    const gas = await publicClient.estimateContractGas(request);
    return (gas * 12n) / 10n;
  } catch {
    return 600_000n;
  }
}

function buildChain() {
  return {
    ...tempoModerato,
    rpcUrls: {
      ...tempoModerato.rpcUrls,
      default: {
        ...tempoModerato.rpcUrls.default,
        http: [APP_CONFIG.rpcUrl]
      }
    },
    feeToken: APP_CONFIG.feeTokenAddress as Address
  };
}

export function usePredolar() {
  const { wallets } = useWallets();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [history, setHistory] = useState<ProbabilityPoint[]>([]);
  const [activities, setActivities] = useState<BetActivity[]>([]);

  const activeWallet = wallets[0];
  const walletAddress = (activeWallet?.address || "") as Address;

  const storageKey = walletAddress ? `predolar:activities:${walletAddress.toLowerCase()}` : "";

  const persistActivities = useCallback(
    (next: BetActivity[]) => {
      if (!storageKey) return;
      localStorage.setItem(storageKey, JSON.stringify(next.slice(-200)));
    },
    [storageKey]
  );

  const appendActivity = useCallback(
    (activity: Omit<BetActivity, "id" | "timestamp">) => {
      const nextItem: BetActivity = {
        ...activity,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now()
      };
      setActivities((prev) => {
        const next = [...prev, nextItem];
        persistActivities(next);
        return next.slice(-200);
      });
    },
    [persistActivities]
  );

  useEffect(() => {
    if (!storageKey) return;
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      setActivities([]);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as BetActivity[];
      setActivities(Array.isArray(parsed) ? parsed : []);
    } catch {
      setActivities([]);
    }
  }, [storageKey]);

  const getClients = useCallback(async () => {
    if (!activeWallet || !APP_CONFIG.rpcUrl) return null;

    const eip1193 = await activeWallet.getEthereumProvider();
    const chain = buildChain();

    const publicClient = createPublicClient({
      chain,
      transport: http(APP_CONFIG.rpcUrl)
    });

    const walletClient = createWalletClient({
      account: activeWallet.address as Address,
      chain,
      transport: custom(eip1193)
    });

    return { publicClient, walletClient, account: activeWallet.address as Address };
  }, [activeWallet]);

  const refresh = useCallback(async () => {
    if (!APP_CONFIG.marketFactory || !activeWallet) return;

    setLoading(true);
    setError("");

    try {
      const clients = await getClients();
      if (!clients) return;

      const { publicClient, account } = clients;

      const marketAddress = (await publicClient.readContract({
        address: APP_CONFIG.marketFactory as Address,
        abi: FACTORY_ABI,
        functionName: "currentMarket"
      })) as Address;

      const stablecoin = (await publicClient.readContract({
        address: APP_CONFIG.marketFactory as Address,
        abi: FACTORY_ABI,
        functionName: "stablecoin"
      })) as Address;

      if (marketAddress.toLowerCase() === ZERO_ADDRESS) {
        setMarket(null);
        setPortfolio(null);
        return;
      }

      const [threshold, closeTimestamp, yesToken, noToken, resolved, yesWins] = await Promise.all([
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "threshold" }),
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "closeTimestamp" }),
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "yesToken" }),
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "noToken" }),
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "resolved" }),
        publicClient.readContract({ address: marketAddress, abi: MARKET_ABI, functionName: "yesWins" })
      ]);

      const yesTokenAddress = yesToken as Address;
      const noTokenAddress = noToken as Address;

      const [stableBalRaw, yesBalRaw, noBalRaw, stableDecimals, yesDecimals, noDecimals] = await Promise.all([
        publicClient.readContract({ address: stablecoin, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: yesTokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: noTokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: stablecoin, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: yesTokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: noTokenAddress, abi: ERC20_ABI, functionName: "decimals" })
      ]);

      const oneYes = parseUnits("1", Number(yesDecimals));
      const oneNo = parseUnits("1", Number(noDecimals));

      const [yesQuote, noQuote] = await Promise.all([
        publicClient.readContract({
          address: marketAddress,
          abi: MARKET_ABI,
          functionName: "quoteSellYes",
          args: [oneYes]
        }).catch(() => 0n),
        publicClient.readContract({
          address: marketAddress,
          abi: MARKET_ABI,
          functionName: "quoteSellNo",
          args: [oneNo]
        }).catch(() => 0n)
      ]);

      const quoteSum = Number((yesQuote as bigint) + (noQuote as bigint));
      const probabilityYes = quoteSum > 0 ? toPct((Number(yesQuote) / quoteSum) * 100) : 50;
      const probabilityNo = quoteSum > 0 ? toPct((Number(noQuote) / quoteSum) * 100) : 50;

      setMarket({
        threshold: Number(threshold),
        closeTimestamp: Number(closeTimestamp),
        probabilityYes,
        probabilityNo,
        resolved: Boolean(resolved),
        yesWins: Boolean(yesWins),
        marketAddress,
        yesToken: yesTokenAddress,
        noToken: noTokenAddress,
        stablecoin
      });

      const eventHistory = await buildHistoryFromEvents(publicClient, marketAddress);
      if (eventHistory.length > 0) {
        setHistory(eventHistory);
      } else {
        setHistory([
          {
            timestamp: Date.now(),
            yes: probabilityYes,
            no: probabilityNo
          }
        ]);
      }

      setPortfolio({
        stableBalance: Number(formatUnits(stableBalRaw as bigint, Number(stableDecimals))).toFixed(2),
        yesBalance: Number(formatUnits(yesBalRaw as bigint, Number(yesDecimals))).toFixed(2),
        noBalance: Number(formatUnits(noBalRaw as bigint, Number(noDecimals))).toFixed(2)
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [activeWallet, getClients]);

  const mintPosition = useCallback(
    async (amount: string) => {
      if (!market || !activeWallet) return;
      const clients = await getClients();
      if (!clients) return;

      const { publicClient, walletClient, account } = clients;

      const stableDecimals = (await publicClient.readContract({
        address: market.stablecoin,
        abi: ERC20_ABI,
        functionName: "decimals"
      })) as number;

      const amountRaw = parseUnits(amount, stableDecimals);
      const feeParams = await getFeeParams(publicClient);
      const approveGas = await getGasLimit(publicClient, {
        account,
        address: market.stablecoin,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [market.marketAddress, amountRaw]
      });

      const approveHash = await walletClient.writeContract({
        account,
        address: market.stablecoin,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [market.marketAddress, amountRaw],
        gas: approveGas,
        ...feeParams
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const mintGas = await getGasLimit(publicClient, {
        account,
        address: market.marketAddress,
        abi: MARKET_ABI,
        functionName: "mintPosition",
        args: [amountRaw]
      });

      const mintHash = await walletClient.writeContract({
        account,
        address: market.marketAddress,
        abi: MARKET_ABI,
        functionName: "mintPosition",
        args: [amountRaw],
        gas: mintGas,
        ...feeParams
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
      appendActivity({
        marketAddress: market.marketAddress,
        action: "MINT",
        amount
      });

      await refresh();
    },
    [activeWallet, appendActivity, getClients, market, refresh]
  );

  const trade = useCallback(
    async (mode: TradeMode, side: Side, amount: string) => {
      if (!market || !activeWallet) return;
      try {
        setError("");
        const clients = await getClients();
        if (!clients) return;

        const { publicClient, walletClient, account } = clients;
        const stableDecimals = (await publicClient.readContract({
          address: market.stablecoin,
          abi: ERC20_ABI,
          functionName: "decimals"
        })) as number;

        const tokenAddress = side === "YES" ? market.yesToken : market.noToken;
        const tokenDecimals = (await publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "decimals"
        })) as number;

        const amountIn = parseUnits(amount, mode === "BUY" ? stableDecimals : tokenDecimals);

        const quote = (await publicClient.readContract({
          address: market.marketAddress,
          abi: MARKET_ABI,
          functionName:
            mode === "BUY"
              ? side === "YES"
                ? "quoteBuyYes"
                : "quoteBuyNo"
              : side === "YES"
                ? "quoteSellYes"
                : "quoteSellNo",
          args: [amountIn]
        })) as bigint;

        const minOut = (quote * 995n) / 1000n;
        const feeParams = await getFeeParams(publicClient);

        if (mode === "BUY") {
          const approveGas = await getGasLimit(publicClient, {
            account,
            address: market.stablecoin,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [market.marketAddress, amountIn]
          });

          const approveHash = await walletClient.writeContract({
            account,
            address: market.stablecoin,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [market.marketAddress, amountIn],
            gas: approveGas,
            ...feeParams
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });

          const buyGas = await getGasLimit(publicClient, {
            account,
            address: market.marketAddress,
            abi: MARKET_ABI,
            functionName: side === "YES" ? "buyYes" : "buyNo",
            args: [amountIn, minOut]
          });

          const buyHash = await walletClient.writeContract({
            account,
            address: market.marketAddress,
            abi: MARKET_ABI,
            functionName: side === "YES" ? "buyYes" : "buyNo",
            args: [amountIn, minOut],
            gas: buyGas,
            ...feeParams
          });
          await publicClient.waitForTransactionReceipt({ hash: buyHash });
          appendActivity({
            marketAddress: market.marketAddress,
            action: "BUY",
            side,
            amount,
            txHash: buyHash
          });
        } else {
          const approveGas = await getGasLimit(publicClient, {
            account,
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [market.marketAddress, amountIn]
          });

          const approveHash = await walletClient.writeContract({
            account,
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [market.marketAddress, amountIn],
            gas: approveGas,
            ...feeParams
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });

          const sellGas = await getGasLimit(publicClient, {
            account,
            address: market.marketAddress,
            abi: MARKET_ABI,
            functionName: side === "YES" ? "sellYes" : "sellNo",
            args: [amountIn, minOut]
          });

          const sellHash = await walletClient.writeContract({
            account,
            address: market.marketAddress,
            abi: MARKET_ABI,
            functionName: side === "YES" ? "sellYes" : "sellNo",
            args: [amountIn, minOut],
            gas: sellGas,
            ...feeParams
          });
          await publicClient.waitForTransactionReceipt({ hash: sellHash });
          appendActivity({
            marketAddress: market.marketAddress,
            action: "SELL",
            side,
            amount,
            txHash: sellHash
          });
        }

        await refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Trade failed";
        setError(msg);
        throw new Error(msg);
      }
    },
    [activeWallet, appendActivity, getClients, market, refresh]
  );

  const claim = useCallback(async () => {
    if (!market || !activeWallet) return;
    const clients = await getClients();
    if (!clients) return;

    const { publicClient, walletClient, account } = clients;
    const feeParams = await getFeeParams(publicClient);
    const claimGas = await getGasLimit(publicClient, {
      account,
      address: market.marketAddress,
      abi: MARKET_ABI,
      functionName: "redeem"
    });

    const claimHash = await walletClient.writeContract({
      account,
      address: market.marketAddress,
      abi: MARKET_ABI,
      functionName: "redeem",
      gas: claimGas,
      ...feeParams
    });

    await publicClient.waitForTransactionReceipt({ hash: claimHash });
    appendActivity({
      marketAddress: market.marketAddress,
      action: "CLAIM",
      amount: "0",
      txHash: claimHash
    });
    await refresh();
  }, [activeWallet, appendActivity, getClients, market, refresh]);

  const estimateBuy = useCallback(
    async (side: Side, stableAmount: string) => {
      if (!market || !activeWallet || !stableAmount || Number(stableAmount) <= 0) {
        return { outcomeOut: "0.00", payoutIfWin: "0.00" };
      }
      const clients = await getClients();
      if (!clients) return { outcomeOut: "0.00", payoutIfWin: "0.00" };
      const { publicClient } = clients;

      const stableDecimals = (await publicClient.readContract({
        address: market.stablecoin,
        abi: ERC20_ABI,
        functionName: "decimals"
      })) as number;

      const tokenAddress = side === "YES" ? market.yesToken : market.noToken;
      const tokenDecimals = (await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals"
      })) as number;

      const amountIn = parseUnits(stableAmount, stableDecimals);
      const quoted = (await publicClient.readContract({
        address: market.marketAddress,
        abi: MARKET_ABI,
        functionName: side === "YES" ? "quoteBuyYes" : "quoteBuyNo",
        args: [amountIn]
      })) as bigint;

      return {
        outcomeOut: Number(formatUnits(quoted, tokenDecimals)).toFixed(2),
        payoutIfWin: Number(formatUnits(quoted, stableDecimals)).toFixed(2)
      };
    },
    [activeWallet, getClients, market]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => {
      refresh();
    }, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  return {
    market,
    portfolio,
    loading,
    error,
    mintPosition,
    trade,
    claim,
    refresh,
    estimateBuy,
    history,
    activities,
    walletAddress
  };
}
