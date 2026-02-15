export const APP_CONFIG = {
  privyAppId: import.meta.env.VITE_PRIVY_APP_ID || "",
  tempoChainId: Number(import.meta.env.VITE_TEMPO_CHAIN_ID || 42431),
  rpcUrl: import.meta.env.VITE_TEMPO_RPC_URL || "https://rpc.moderato.tempo.xyz",
  marketFactory: import.meta.env.VITE_MARKET_FACTORY_ADDRESS || "",
  stablecoinExchange:
    import.meta.env.VITE_STABLECOIN_EXCHANGE_ADDRESS ||
    "0xdec0000000000000000000000000000000000000"
};
