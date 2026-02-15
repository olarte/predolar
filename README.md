# Predolar MVP (Tempo Moderato)

Daily USD/COP prediction market MVP using:
- Solidity contracts (factory + market + outcome tokens)
- Tempo testnet (Moderato)
- Privy embedded wallets
- `viem` for agent and frontend chain interactions
- Tempo stablecoin exchange precompile addresses from hackathon cheatsheet

## Included

- `contracts/MarketFactory.sol`
- `contracts/DailyMarket.sol`
- `contracts/OutcomeToken.sol`
- `scripts/deploy.ts` (Hardhat deploy)
- `scripts/agent.ts` (viem lifecycle automation)
- `frontend/` React + Privy + viem integration

## Tempo testnet defaults (from hackathon cheatsheet)

- Chain ID: `42431`
- RPC: `https://rpc.moderato.tempo.xyz`
- AlphaUSD: `0x20c0000000000000000000000000000000000001`
- BetaUSD: `0x20c0000000000000000000000000000000000002`
- pathUSD: `0x20c0000000000000000000000000000000000000`
- Stablecoin Exchange: `0xdec0000000000000000000000000000000000000`

## Setup

### 1) Install

```bash
npm install
cd frontend && npm install && cd ..
```

### 2) Env

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

Fill required keys:
- `.env`
  - `DEPLOYER_PRIVATE_KEY`
  - `AGENT_ADDRESS`
- `frontend/.env`
  - `VITE_PRIVY_APP_ID`

After deployment, set:
- `.env` -> `MARKET_FACTORY_ADDRESS`
- `frontend/.env` -> `VITE_MARKET_FACTORY_ADDRESS`

### 3) Deploy contracts

```bash
npm run deploy:tempo
```

### 4) Run lifecycle agent

Create market + place initial orderbook liquidity:

```bash
AGENT_MODE=create npm run agent
```

Resolve market:

```bash
AGENT_MODE=resolve RESOLVE_DATE_KEY=YYYYMMDD npm run agent
```

### 5) Run frontend

```bash
cd frontend
npm run dev
```

## Notes

- `DailyMarket.seedLiquidity(...)` now places YES/NO bid+ask limit orders using Tempo's stablecoin exchange `place(...)` API (no Uniswap-style pools).
- Frontend trading calls Tempo stablecoin exchange methods:
  - `quoteSwapExactAmountIn`
  - `swapExactAmountIn`
- Market mint/redeem uses direct `viem` contract writes.
- Agent is `viem`-based and computes daily threshold from official TRM data.
