"use client";

import { formatTusd8 } from "@meterpass/sdk";
import type { FeedEvent } from "@/lib/hooks";
import { explorerTx, short } from "@/lib/config";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const REASONS: Record<string, string> = {
  pass_revoked: "owner revoked the agent",
  insufficient_funds: "voucher above deposit",
  stale_cumulative: "replayed / stale voucher",
  invalid_signature: "not signed by the pass agent",
  pass_expired: "pass expired",
  pass_closing: "pass closing",
  unknown_pass: "unknown pass",
};

export function Stream({ events, connected }: { events: FeedEvent[]; connected: boolean }) {
  return (
    <div className="glass stream">
      <div className="section-head" style={{ padding: "18px 20px 6px", marginBottom: 0 }}>
        <div>
          <div className="card-title">Live voucher stream</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            What the merchant sees, as it happens
          </div>
        </div>
        <span className={`chip ${connected ? "ok" : ""}`} style={{ marginTop: 0 }}>
          <span className={`dot ${connected ? "" : "off"}`} /> {connected ? "streaming" : "waiting for merchant"}
        </span>
      </div>
      <div className="stream-list" role="log" aria-live="polite">
        {events.length === 0 && <div className="empty">No traffic yet. Run the agent, or open the playground.</div>}
        {events.slice(0, 60).map((e, i) => {
          if (e.type === "paid")
            return (
              <div className="row" key={`${e.at}-${i}`}>
                <span className="t">{time(e.at)}</span>
                <span className="what">
                  <span className="chip ok" style={{ marginTop: 0, marginRight: 8 }}>voucher</span>
                  pass #{e.passId} · {e.path}
                </span>
                <span className="amt">
                  Σ {formatTusd8(BigInt(e.cumulative), 3)} <span className="muted">· {e.verifyMs}ms</span>
                </span>
              </div>
            );
          if (e.type === "rejected")
            return (
              <div className="row" key={`${e.at}-${i}`}>
                <span className="t">{time(e.at)}</span>
                <span className="what">
                  <span className="chip bad" style={{ marginTop: 0, marginRight: 8 }}>402</span>
                  {REASONS[e.error] ?? e.error}
                  {e.passId && <span className="muted"> · pass #{e.passId}</span>}
                </span>
                <span className="amt muted">{e.path}</span>
              </div>
            );
          if (e.type === "settled")
            return (
              <div className="row" key={`${e.at}-${i}`} style={{ background: "rgba(79,240,180,0.07)" }}>
                <span className="t">{time(e.at)}</span>
                <span className="what">
                  <span className="chip ok" style={{ marginTop: 0, marginRight: 8 }}>settled</span>
                  {e.requests} requests in one tx ·{" "}
                  <a className="grad-text" href={explorerTx(e.hash)} target="_blank" rel="noreferrer">
                    {short(e.hash)}
                  </a>
                </span>
                <span className="amt">
                  {formatTusd8(BigInt(e.totalPaid), 3)} <span className="muted">· {Number(e.gasUsed).toLocaleString()} gas</span>
                </span>
              </div>
            );
          if (e.type === "pass")
            return (
              <div className="row" key={`${e.at}-${i}`}>
                <span className="t">{time(e.at)}</span>
                <span className="what">
                  <span className="chip warn" style={{ marginTop: 0, marginRight: 8 }}>chain</span>
                  pass #{e.passId}: {e.event === "AuthorizerChanged" ? (e.authorizer === "0x0000000000000000000000000000000000000000" ? "agent revoked" : `agent → ${short(e.authorizer)}`) : e.event}
                </span>
                <span className="amt muted">{formatTusd8(BigInt(e.claimed), 3)} settled</span>
              </div>
            );
          return (
            <div className="row" key={`${e.at}-${i}`}>
              <span className="t">{time(e.at)}</span>
              <span className="what" style={{ color: "var(--rose)" }}>settlement failed: {e.error}</span>
              <span />
            </div>
          );
        })}
      </div>
    </div>
  );
}
