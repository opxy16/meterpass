"use client";

import { useEffect, useRef, useState } from "react";
import { explorerTx, metrics } from "@/lib/config";

const N = 250;

/**
 * The core idea, animated once when it scrolls into view: 250 per-call transactions pile up on
 * the left; on the right the same 250 calls are vouchers that collapse into ONE settlement.
 * Numbers are the measured Aevum run; reduced motion shows the end state.
 */
export function Versus() {
  const ref = useRef<HTMLDivElement>(null);
  const [filled, setFilled] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [run, setRun] = useState(0);

  const b = metrics.baseline;
  const batch = metrics.batch;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setFilled(N);
      setCollapsed(true);
      return;
    }
    // Progress comes from elapsed time, not from counting timer ticks, so a throttled or
    // background tab still lands on the right frame when it next paints.
    const FILL_MS = 1500;
    const HOLD_MS = 450;
    let raf = 0;
    const start = () => {
      const t0 = performance.now();
      setCollapsed(false);
      const frame = (t: number) => {
        const k = Math.min(1, (t - t0) / FILL_MS);
        setFilled(Math.round(k * N));
        if (t - t0 >= FILL_MS + HOLD_MS) {
          setCollapsed(true);
          return;
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          start();
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [run]);

  if (!b || !batch) {
    return <p className="muted">The measured comparison appears here after the demo has run on Aevum.</p>;
  }
  // measured total when the baseline ran exactly N transfers, else the measured average × N
  const perCall = b.n === N ? BigInt(b.totalGas) : BigInt(b.avgGas) * BigInt(N);
  const ratio = Math.round(Number(perCall) / Number(batch.gasUsed));

  return (
    <div ref={ref}>
      <div className="versus">
        <div className="ledger">
          <h3>Paying per call</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 15 }}>
            One EIP-3009 transfer per request, the way x402 usually settles.
          </p>
          <div className="figure">
            {Math.min(filled, N)}
            <small>transactions</small>
          </div>
          <div className="ticks per-call" aria-hidden>
            {Array.from({ length: N }, (_, i) => (
              <div key={i} className={`tick ${i < filled ? "on" : ""}`} />
            ))}
          </div>
          <p className="foot">
            {Number(perCall).toLocaleString()} gas in total, {Number(b.avgGas).toLocaleString()} each.{" "}
            <a href={explorerTx(b.firstHash)} target="_blank" rel="noreferrer">
              First of {b.n} on the explorer
            </a>
          </p>
        </div>

        <div className="ledger">
          <h3>Paying with MeterPass</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 15 }}>
            One signed voucher per request, then one claim for all of them.
          </p>
          <div className="figure">
            {collapsed ? 1 : 0}
            <small>{collapsed ? "transaction" : `transactions, ${Math.min(filled, N)} vouchers`}</small>
          </div>
          <div className={`ticks vouchers ${collapsed ? "collapsed" : ""}`} aria-hidden>
            {Array.from({ length: N }, (_, i) => (
              <div key={i} className={`tick ${i < filled ? "on" : ""}`} />
            ))}
          </div>
          <div className="settle-bar">claimBatch: {N} calls, {Number(batch.gasUsed).toLocaleString()} gas</div>
          <p className="foot">
            <a href={explorerTx(batch.hash)} target="_blank" rel="noreferrer">
              The settlement transaction
            </a>
          </p>
        </div>
      </div>
      <div className="ratio">
        <strong>{ratio}×</strong>
        <span>
          less gas for the same {N} calls on Aevum testnet, and no transaction while the agent works.{" "}
          <button className="btn small" onClick={() => setRun((r) => r + 1)}>
            Replay
          </button>
        </span>
      </div>
    </div>
  );
}
