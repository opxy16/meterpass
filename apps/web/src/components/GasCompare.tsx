"use client";

import { useEffect, useState } from "react";
import { explorerTx, metrics, short } from "@/lib/config";

/** Measured on Aevum by `pnpm demo baseline` and `pnpm demo settle`. Shows nothing it didn't measure. */
export function GasCompare() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(id);
  }, []);

  const b = metrics.baseline;
  const batch = metrics.batch;
  if (!b || !batch) {
    return (
      <div className="glass pad">
        <div className="card-title">250 calls, two ways</div>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          The side-by-side measurement appears here once the demo has run on Aevum: 250 calls paid one transaction each
          (the per-call x402 way), against the same 250 calls settled by MeterPass in a single claim.
        </p>
      </div>
    );
  }
  const n = batch.requests;
  // Baseline gas scaled to the same number of requests as the batch (measured average per transfer).
  const perCallGas = BigInt(b.avgGas) * BigInt(n);
  const batchGas = BigInt(batch.gasUsed);
  const ratio = Number(perCallGas) / Number(batchGas);
  const pct = Math.max(0.6, (Number(batchGas) / Number(perCallGas)) * 100);

  return (
    <div className="glass pad">
      <div className="card-title">{n} calls, two ways · measured on Aevum</div>
      <div className="big-claim" style={{ marginTop: 10 }}>
        <span className="grad-text">{ratio.toFixed(0)}× less gas</span>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 14 }}>
        {n} transactions → 1 transaction. Vouchers cost nothing to send.
      </p>
      <div className="compare" style={{ marginTop: 22 }}>
        <div className="bar-row">
          <div className="bar-head">
            <span>Per-call settlement ({n} × EIP-3009 transfer)</span>
            <span className="mono">{perCallGas.toLocaleString()} gas</span>
          </div>
          <div className="bar-track">
            <div className="bar-fill old" style={{ width: shown ? "100%" : "0%" }} />
          </div>
          <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
            avg {Number(b.avgGas).toLocaleString()} gas each · sample of {b.n}:{" "}
            <a href={explorerTx(b.firstHash)} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)" }}>
              {short(b.firstHash)}
            </a>
          </div>
        </div>
        <div className="bar-row">
          <div className="bar-head">
            <span>MeterPass ({n} vouchers + 1 claimBatch)</span>
            <span className="mono">{batchGas.toLocaleString()} gas</span>
          </div>
          <div className="bar-track">
            <div className="bar-fill new" style={{ width: shown ? `${pct}%` : "0%" }} />
          </div>
          <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
            settlement tx:{" "}
            <a href={explorerTx(batch.hash)} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)" }}>
              {short(batch.hash)}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
