import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import App from "./App";
import { APP_CONFIG } from "./config/env";
import "./styles/global.css";

const tempoChain = {
  id: APP_CONFIG.tempoChainId,
  name: "Tempo Testnet (Moderato)",
  network: "tempo-moderato",
  nativeCurrency: {
    name: "USD",
    symbol: "USD",
    decimals: 6
  },
  rpcUrls: {
    default: {
      http: [APP_CONFIG.rpcUrl]
    },
    public: {
      http: [APP_CONFIG.rpcUrl]
    }
  },
  blockExplorers: {
    default: {
      name: "Tempo Explorer",
      url: "https://explore.tempo.xyz"
    }
  }
} as const;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={APP_CONFIG.privyAppId}
      config={{
        loginMethods: ["email", "wallet"],
        embeddedWallets: {
          createOnLogin: "all-users"
        },
        supportedChains: [tempoChain],
        defaultChain: tempoChain
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>
);
