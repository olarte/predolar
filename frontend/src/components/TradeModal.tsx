import { FormEvent, useState } from "react";

type Props = {
  onClose: () => void;
  onTrade: (mode: "BUY" | "SELL", side: "YES" | "NO", amount: string) => Promise<void>;
  onMint: (amount: string) => Promise<void>;
};

export function TradeModal({ onClose, onTrade, onMint }: Props) {
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [mode, setMode] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState("25");
  const [mintAmount, setMintAmount] = useState("25");
  const [busy, setBusy] = useState(false);
  const [tradeError, setTradeError] = useState("");

  const submitTrade = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setTradeError("");
    try {
      await onTrade(mode, side, amount);
      onClose();
    } catch (err) {
      setTradeError(err instanceof Error ? err.message : "Trade failed");
    } finally {
      setBusy(false);
    }
  };

  const submitMint = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onMint(mintAmount);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h3>Trade Predolar</h3>
          <button onClick={onClose}>x</button>
        </div>

        <form onSubmit={submitTrade} className="panel-form">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as "BUY" | "SELL")}> 
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>

          <label>Side</label>
          <div className="side-toggle">
            <button type="button" className={side === "YES" ? "active yes" : "yes"} onClick={() => setSide("YES")}>
              YES
            </button>
            <button type="button" className={side === "NO" ? "active no" : "no"} onClick={() => setSide("NO")}>
              NO
            </button>
          </div>

          <label>Input Amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          <small>{mode === "BUY" ? "Amount in AlphaUSD/pathUSD units." : "Amount in outcome token units."}</small>

          <button type="submit" disabled={busy}>
            {busy ? "Working..." : `${mode} ${side}`}
          </button>
          {tradeError && <small className="error">{tradeError}</small>}
        </form>

        <form onSubmit={submitMint} className="panel-form">
          <label>Mint YES + NO from AlphaUSD</label>
          <input value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} />
          <button type="submit" disabled={busy}>
            {busy ? "Working..." : "Mint Pair"}
          </button>
        </form>
      </div>
    </div>
  );
}
