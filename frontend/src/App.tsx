import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { BetActivity, ProbabilityPoint, usePredolar } from "./hooks/usePredolar";

type ViewMode = "new" | "current" | "old";
type FxPoint = { timestamp: number; cop: number };

function humanTime(unix: number) {
  if (!unix) return "-";
  return new Date(unix * 1000).toLocaleString("en-US", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatCop(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const normalized = value >= 100000 ? value / 100 : value;
  return normalized.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function shortAddress(address?: string) {
  if (!address) return "Wallet";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function FxChart({ points }: { points: FxPoint[] }) {
  if (points.length < 2) return <div className="chart-empty">Building USD/COP curve...</div>;

  const width = 320;
  const height = 120;
  const minX = points[0].timestamp;
  const maxX = points[points.length - 1].timestamp;
  const rangeX = Math.max(1, maxX - minX);
  const values = points.map((p) => p.cop);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const rangeY = Math.max(1, maxY - minY);

  const path = points
    .map((p, i) => {
      const x = ((p.timestamp - minX) / rangeX) * width;
      const y = height - ((p.cop - minY) / rangeY) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="USD COP intraday chart">
      <path d={path} className="chart-fx-line" />
    </svg>
  );
}

function ProbabilityChart({ points }: { points: ProbabilityPoint[] }) {
  if (points.length < 2) return <div className="chart-empty">Building intraday market curve...</div>;

  const width = 320;
  const height = 120;
  const minX = points[0].timestamp;
  const maxX = points[points.length - 1].timestamp;
  const rangeX = Math.max(1, maxX - minX);

  const path = points
    .map((p, i) => {
      const x = ((p.timestamp - minX) / rangeX) * width;
      const y = height - (p.yes / 100) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="Intraday probability chart">
      <path d={`M0,${height / 2} L${width},${height / 2}`} className="chart-mid" />
      <path d={path} className="chart-yes-line" />
    </svg>
  );
}

function ActivityList({ items }: { items: BetActivity[] }) {
  if (items.length === 0) return <p className="sub">No bets yet in this section.</p>;

  return (
    <div className="activity-list">
      {items.map((item) => (
        <div key={item.id} className="activity-item">
          <div>
            <strong>{item.action}{item.side ? ` ${item.side}` : ""}</strong>
            <p className="sub">{new Date(item.timestamp).toLocaleString("en-US")}</p>
          </div>
          <div className="right">
            <strong>{item.amount}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const {
    market,
    portfolio,
    loading,
    error,
    trade,
    mintPosition,
    claim,
    refresh,
    estimateBuy,
    history,
    activities,
    walletAddress
  } = usePredolar();

  const [view, setView] = useState<ViewMode>("new");
  const [betAmount, setBetAmount] = useState("10");
  const [mintAmount, setMintAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [quoteYes, setQuoteYes] = useState("0.00");
  const [quoteNo, setQuoteNo] = useState("0.00");
  const [payoutYes, setPayoutYes] = useState("0.00");
  const [payoutNo, setPayoutNo] = useState("0.00");
  const [fxHistory, setFxHistory] = useState<FxPoint[]>([]);
  const [lastCop, setLastCop] = useState<number | null>(null);

  const bias = useMemo(() => {
    if (!market) return "-";
    return market.probabilityYes >= market.probabilityNo ? "YES" : "NO";
  }, [market]);

  const currentActivities = useMemo(
    () => activities.filter((a) => a.marketAddress === market?.marketAddress),
    [activities, market?.marketAddress]
  );

  const oldActivities = useMemo(
    () => activities.filter((a) => a.marketAddress !== market?.marketAddress),
    [activities, market?.marketAddress]
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!market || Number(betAmount) <= 0) {
        setQuoteYes("0.00");
        setQuoteNo("0.00");
        setPayoutYes("0.00");
        setPayoutNo("0.00");
        return;
      }
      const [y, n] = await Promise.all([estimateBuy("YES", betAmount), estimateBuy("NO", betAmount)]);
      if (cancelled) return;
      setQuoteYes(y.outcomeOut);
      setQuoteNo(n.outcomeOut);
      setPayoutYes(y.payoutIfWin);
      setPayoutNo(n.payoutIfWin);
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [betAmount, estimateBuy, market]);

  useEffect(() => {
    let stop = false;

    async function fetchUsdCop() {
      try {
        const response = await fetch("https://open.er-api.com/v6/latest/USD");
        if (!response.ok) return;
        const data = (await response.json()) as { rates?: Record<string, number> };
        const cop = data?.rates?.COP;
        if (!cop || !Number.isFinite(cop)) return;
        if (stop) return;

        setLastCop(cop);
        setFxHistory((prev) => {
          const next = [...prev, { timestamp: Date.now(), cop }];
          return next.slice(-120);
        });
      } catch {
        // Ignore transient FX API errors.
      }
    }

    fetchUsdCop();
    const intervalId = window.setInterval(fetchUsdCop, 60_000);
    return () => {
      stop = true;
      window.clearInterval(intervalId);
    };
  }, []);

  async function placeBet(side: "YES" | "NO") {
    setBusy(true);
    try {
      await trade("BUY", side, betAmount);
      await refresh();
      setView("current");
    } finally {
      setBusy(false);
    }
  }

  async function mintPair() {
    setBusy(true);
    try {
      await mintPosition(mintAmount);
      await refresh();
      setView("current");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <div className="screen">Loading Privy...</div>;

  if (!authenticated) {
    return (
      <div className="screen hero">
        <h1>PREDOLAR</h1>
        <p>Daily USD/COP market on Tempo</p>
        <button onClick={login}>Connect Wallet</button>
      </div>
    );
  }

  return (
    <div className="mobile-wrap">
      <nav className="top-nav">
        <div className="brand">
          <div className="brand-dot">P</div>
          <div>
            <strong>Predolar</strong>
            <p className="sub">{user?.email?.address || "Embedded wallet"}</p>
          </div>
        </div>
        <div className="nav-actions">
          <button className={view === "new" ? "pill active" : "pill"} onClick={() => setView("new")}>New Bet</button>
          <button className={view === "current" ? "pill active" : "pill"} onClick={() => setView("current")}>Current</button>
          <button className={view === "old" ? "pill active" : "pill"} onClick={() => setView("old")}>Old</button>
          <button className="pill wallet">{shortAddress(walletAddress)}</button>
          <button className="pill" onClick={logout}>Logout</button>
        </div>
      </nav>

      {error && <p className="error global-error">{error}</p>}

      {view === "new" && (
        <div className="single-card">
          <section className="block">
            <p className="label">Today&apos;s threshold</p>
            <h2>{formatCop(market?.threshold)} COP</h2>
            <p className="sub">Closes {market ? humanTime(market.closeTimestamp) : "-"}</p>
            <p className="sub">Bias: {bias}</p>
          </section>

          <section className="block">
            <div className="row-between">
              <p className="label">Intraday market</p>
              <p className="sub">YES {Number(market?.probabilityYes || 50).toFixed(1)}%</p>
            </div>
            <ProbabilityChart points={history} />
          </section>

          <section className="block">
            <div className="row-between">
              <p className="label">USD/COP today (spot)</p>
              <p className="sub">{lastCop ? `${formatCop(lastCop)} COP` : "-"}</p>
            </div>
            <FxChart points={fxHistory} />
          </section>

          <section className="block">
            <p className="label">Place bet now</p>
            <input value={betAmount} onChange={(e) => setBetAmount(e.target.value)} className="amount-input" />
            <div className="quote-grid">
              <div>
                <p className="small">Buy YES receives</p>
                <strong>{quoteYes} YES</strong>
                <p className="small">Payout if YES wins: {payoutYes} stable</p>
              </div>
              <div>
                <p className="small">Buy NO receives</p>
                <strong>{quoteNo} NO</strong>
                <p className="small">Payout if NO wins: {payoutNo} stable</p>
              </div>
            </div>
            <div className="action-grid">
              <button onClick={() => placeBet("YES")} disabled={!market || busy}>Bet YES</button>
              <button onClick={() => placeBet("NO")} className="danger" disabled={!market || busy}>Bet NO</button>
            </div>
          </section>

          <section className="block no-top-border">
            <p className="label">Mint pair (YES + NO)</p>
            <div className="row-inline">
              <input value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} className="amount-input" />
              <button onClick={mintPair} disabled={!market || busy}>Mint</button>
            </div>
          </section>

          <section className="block no-top-border">
            <p className="label">Portfolio snapshot</p>
            <p>Stable: {portfolio?.stableBalance || "0.00"}</p>
            <p>YES: {portfolio?.yesBalance || "0.00"}</p>
            <p>NO: {portfolio?.noBalance || "0.00"}</p>
            <div className="action-grid">
              <button onClick={() => refresh()} className="ghost">Refresh</button>
              <button onClick={() => claim()} disabled={!market?.resolved}>Claim</button>
            </div>
            <p className="sub">{market?.resolved ? `Resolved: ${market.yesWins ? "YES" : "NO"}` : "Pending resolution"}</p>
          </section>
        </div>
      )}

      {view === "current" && (
        <div className="single-card secondary-card">
          <section className="block no-top-border">
            <p className="label">Current bets</p>
            <ActivityList items={currentActivities} />
          </section>
        </div>
      )}

      {view === "old" && (
        <div className="single-card secondary-card">
          <section className="block no-top-border">
            <p className="label">Old bets</p>
            <ActivityList items={oldActivities} />
          </section>
        </div>
      )}
    </div>
  );
}
