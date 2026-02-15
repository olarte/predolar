import { useCallback, useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import {
  Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseUnits
} from "viem";
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
  "function redeem() external"
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

const STABLECOIN_EXCHANGE_ABI = parseAbi([
  "function quoteSwapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn) external view returns (uint128 amountOut)",
  "function swapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn, uint128 minAmountOut) external returns (uint128 amountOut)"
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

function toPct(v: number) {
  if (!Number.isFinite(v) || v <= 0) return 50;
  return Math.min(99, Math.max(1, v));
}

function buildChain() {
  return defineChain({
    id: APP_CONFIG.tempoChainId,
    name: "Tempo Testnet (Moderato)",
    nativeCurrency: { name: "USD", symbol: "USD", decimals: 6 },
    rpcUrls: { default: { http: [APP_CONFIG.rpcUrl] } }
  });
}

export function usePredolar() {
  const { wallets } = useWallets();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const activeWallet = wallets[0];

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
        publicClient
          .readContract({
            address: APP_CONFIG.stablecoinExchange as Address,
            abi: STABLECOIN_EXCHANGE_ABI,
            functionName: "quoteSwapExactAmountIn",
            args: [yesTokenAddress, stablecoin, BigInt(oneYes)]
          })
          .catch(() => 0n),
        publicClient
          .readContract({
            address: APP_CONFIG.stablecoinExchange as Address,
            abi: STABLECOIN_EXCHANGE_ABI,
            functionName: "quoteSwapExactAmountIn",
            args: [noTokenAddress, stablecoin, BigInt(oneNo)]
          })
          .catch(() => 0n)
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

      const approveHash = await walletClient.writeContract({
        account,
        address: market.stablecoin,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [market.marketAddress, amountRaw]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const mintHash = await walletClient.writeContract({
        account,
        address: market.marketAddress,
        abi: MARKET_ABI,
        functionName: "mintPosition",
        args: [amountRaw]
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });

      await refresh();
    },
    [activeWallet, getClients, market, refresh]
  );

  const trade = useCallback(
    async (mode: TradeMode, side: Side, amount: string) => {
      if (!market || !activeWallet) return;
      try {
        setError("");
        const clients = await getClients();
        if (!clients) return;

        const { publicClient, walletClient, account } = clients;
        const tokenIn = mode === "BUY" ? market.stablecoin : side === "YES" ? market.yesToken : market.noToken;
        const tokenOut = mode === "BUY" ? (side === "YES" ? market.yesToken : market.noToken) : market.stablecoin;

        const tokenInDecimals = (await publicClient.readContract({
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: "decimals"
        })) as number;

        const amountIn = parseUnits(amount, tokenInDecimals);

        const quotedOut = (await publicClient.readContract({
          address: APP_CONFIG.stablecoinExchange as Address,
          abi: STABLECOIN_EXCHANGE_ABI,
          functionName: "quoteSwapExactAmountIn",
          args: [tokenIn, tokenOut, BigInt(amountIn)]
        })) as bigint;

        const minAmountOut = (quotedOut * 995n) / 1000n;

        const approveHash = await walletClient.writeContract({
          account,
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [APP_CONFIG.stablecoinExchange as Address, amountIn]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        const swapHash = await walletClient.writeContract({
          account,
          address: APP_CONFIG.stablecoinExchange as Address,
          abi: STABLECOIN_EXCHANGE_ABI,
          functionName: "swapExactAmountIn",
          args: [tokenIn, tokenOut, BigInt(amountIn), BigInt(minAmountOut)]
        });
        await publicClient.waitForTransactionReceipt({ hash: swapHash });

        await refresh();
      } catch (e) {
        const rawMsg = e instanceof Error ? e.message : "Trade failed";
        const msg =
          rawMsg.includes("quoteSwapExactAmountIn") ||
          rawMsg.includes("swapExactAmountIn") ||
          rawMsg.includes("execution reverted")
            ? "Trade failed: Tempo exchange does not currently support this YES/NO token pair. Use Mint Pair for demo positions."
            : rawMsg;
        setError(msg);
        throw new Error(msg);
      }
    },
    [activeWallet, getClients, market, refresh]
  );

  const claim = useCallback(async () => {
    if (!market || !activeWallet) return;
    const clients = await getClients();
    if (!clients) return;

    const { publicClient, walletClient, account } = clients;

    const claimHash = await walletClient.writeContract({
      account,
      address: market.marketAddress,
      abi: MARKET_ABI,
      functionName: "redeem"
    });

    await publicClient.waitForTransactionReceipt({ hash: claimHash });
    await refresh();
  }, [activeWallet, getClients, market, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    market,
    portfolio,
    loading,
    error,
    mintPosition,
    trade,
    claim,
    refresh
  };
}
