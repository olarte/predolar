import { useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { usePredolar } from "./hooks/usePredolar";
import { TradeModal } from "./components/TradeModal";

function humanTime(unix: number) {
  if (!unix) return "-";
  return new Date(unix * 1000).toLocaleString("en-US", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short"
  });
}

export default function App() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { market, portfolio, loading, error, trade, mintPosition, claim, refresh } = usePredolar();
  const [open, setOpen] = useState(false);

  const bias = useMemo(() => {
    if (!market) return "-";
    return market.probabilityYes > market.probabilityNo ? "YES" : "NO";
  }, [market]);

  if (!ready) {
    return <div className="screen">Loading Privy...</div>;
  }

  if (!authenticated) {
    return (
      <div className="screen hero">
        <h1>PREDOLAR</h1>
        <p>Daily USD/COP prediction market on Tempo.</p>
        <button onClick={login}>Login with Privy</button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header>
        <div>
          <h1>Predolar</h1>
          <p>{user?.email?.address || "Embedded wallet"}</p>
        </div>
        <div className="row">
          <button onClick={() => refresh()}>Refresh</button>
          <button onClick={logout}>Logout</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="cards">
        <article className="card">
          <h2>Today</h2>
          <p>Threshold: <strong>{market?.threshold ?? "-"} COP</strong></p>
          <p>Closes: {market ? humanTime(market.closeTimestamp) : "-"}</p>
          <p>Market Bias: {bias}</p>
          <button onClick={() => setOpen(true)} disabled={!market || loading}>Trade</button>
        </article>

        <article className="card">
          <h2>Implied Probability</h2>
          <div className="bar-wrap">
            <div className="bar yes" style={{ width: `${market?.probabilityYes ?? 50}%` }}>
              YES {Number(market?.probabilityYes || 50).toFixed(1)}%
            </div>
            <div className="bar no" style={{ width: `${market?.probabilityNo ?? 50}%` }}>
              NO {Number(market?.probabilityNo || 50).toFixed(1)}%
            </div>
          </div>
        </article>

        <article className="card">
          <h2>Portfolio</h2>
          <p>Stable: {portfolio?.stableBalance || "0.00"}</p>
          <p>YES: {portfolio?.yesBalance || "0.00"}</p>
          <p>NO: {portfolio?.noBalance || "0.00"}</p>
          <button onClick={() => claim()} disabled={!market?.resolved}>Claim Winnings</button>
          <p className="small">{market?.resolved ? `Resolved: ${market.yesWins ? "YES" : "NO"}` : "Pending resolution"}</p>
        </article>
      </section>

      {open && (
        <TradeModal
          onClose={() => setOpen(false)}
          onTrade={trade}
          onMint={mintPosition}
        />
      )}
    </div>
  );
}
