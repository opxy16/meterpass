"use client";

import { formatTusd8 } from "@meterpass/sdk";
import type { ChainStats, FeedEvent } from "@/lib/hooks";
import { explorerTx, short } from "@/lib/config";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ZERO = "0x0000000000000000000000000000000000000000";

const REASONS: Record<string, string> = {
  pass_revoked: "owner revoked the agent",
  insufficient_funds: "voucher above the deposit",
  stale_cumulative: "old voucher sent again",
  underpaid: "voucher below the price",
  invalid_signature: "not signed by the pass's agent",
  pass_expired: "pass expired",
  pass_closing: "pass is closing",
  unknown_pass: "no such pass",
  wrong_merchant: "pass is for another merchant",
};

/** What the merchant sees, request by request. */
export function LiveRows({ events, connected }: { events: FeedEvent[]; connected: boolean }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Requests at the merchant</h3>
        <span className="state">
          <span className={`lamp ${connected ? "" : "off"}`} aria-hidden />
          {connected ? "live" : "waiting for the merchant"}
        </span>
      </div>
      <div className="rows" role="log" aria-live="polite" aria-relevant="additions">
        {events.length === 0 && <p className="empty">No requests yet. Open the playground and let an agent pay for a few calls.</p>}
        {events.slice(0, 60).map((e, i) => {
          const key = `${e.type}-${e.at}-${i}`;
          if (e.type === "paid")
            return (
              <div className={`r ${i === 0 ? "fresh" : ""}`} key={key}>
                <span className="t">{time(e.at)}</span>
                <span className="w">
                  <span className="tag paid">voucher</span>pass {e.passId}, {e.path}
                </span>
                <span className="v">{formatTusd8(BigInt(e.cumulative), 3)} total</span>
              </div>
            );
          if (e.type === "rejected")
            return (
              <div className="r" key={key}>
                <span className="t">{time(e.at)}</span>
                <span className="w">
                  <span className="tag no">402</span>
                  {REASONS[e.error] ?? e.error}
                </span>
                <span className="v muted">{e.passId ? `pass ${e.passId}` : ""}</span>
              </div>
            );
          if (e.type === "settled")
            return (
              <div className="r" key={key}>
                <span className="t">{time(e.at)}</span>
                <span className="w">
                  <span className="tag done">settled</span>
                  <a href={explorerTx(e.hash)} target="_blank" rel="noreferrer">
                    {e.requests ? `${e.requests} calls in one transaction` : "one transaction"}
                  </a>
                </span>
                <span className="v">{formatTusd8(BigInt(e.totalPaid), 3)}</span>
              </div>
            );
          if (e.type === "pass")
            return (
              <div className="r" key={key}>
                <span className="t">{time(e.at)}</span>
                <span className="w">
                  <span className="tag chain">on-chain</span>
                  pass {e.passId}:{" "}
                  {e.event === "AuthorizerChanged"
                    ? e.authorizer === ZERO
                      ? "agent revoked"
                      : `handed to ${short(e.authorizer)}`
                    : e.event === "Claimed"
                      ? "settled"
                      : e.event}
                </span>
                <span className="v muted">{formatTusd8(BigInt(e.claimed), 3)} paid</span>
              </div>
            );
          return (
            <div className="r" key={key}>
              <span className="t">{time(e.at)}</span>
              <span className="w" style={{ color: "var(--red-ink)" }}>
                Settlement failed: {e.error}
              </span>
              <span />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Settlements as PassVault recorded them on Aevum. */
export function ChainRows({ chain }: { chain: ChainStats }) {
  const byTx = new Map<string, { hash: string; paid: bigint; passes: number; block: bigint }>();
  for (const c of chain.claims) {
    const cur = byTx.get(c.hash) ?? { hash: c.hash, paid: 0n, passes: 0, block: c.block };
    cur.paid += c.paid;
    cur.passes += 1;
    byTx.set(c.hash, cur);
  }
  const list = [...byTx.values()];
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Settlements on Aevum</h3>
        <span className="muted" style={{ fontSize: 14 }}>
          {list.length} transactions
        </span>
      </div>
      <div className="rows">
        {!chain.loaded && <p className="empty">Reading PassVault…</p>}
        {chain.loaded && list.length === 0 && <p className="empty">No settlements yet.</p>}
        {list.map((s) => (
          <div className="r" key={s.hash}>
            <span className="t">#{s.block.toString()}</span>
            <span className="w">
              <span className="tag done">claim</span>
              <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer">
                {short(s.hash, 5)}
              </a>
              {s.passes > 1 ? `, ${s.passes} passes` : ""}
            </span>
            <span className="v">{formatTusd8(s.paid, 3)} tUSD8</span>
          </div>
        ))}
      </div>
    </div>
  );
}
