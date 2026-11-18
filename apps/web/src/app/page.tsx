"use client";

import Link from "next/link";
import { formatTusd8 } from "@meterpass/sdk";
import { Odometer } from "@/components/Odometer";
import { Tape } from "@/components/Tape";
import { Versus } from "@/components/Versus";
import { LiveRows, ChainRows } from "@/components/Rows";
import { EvidenceTable } from "@/components/EvidenceTable";
import { useChainStats, useMerchantFeed } from "@/lib/hooks";
import { deployment, metrics } from "@/lib/config";

const tusd = (v?: string | bigint) => formatTusd8(BigInt(v ?? 0), 3);
const PRICE = 2_000n;

const RAILS = [
  {
    t: "A budget the agent can't exceed",
    d: "Its session key may only open or top up passes, for merchants you allowed, up to a total, until a date. The smart account checks this on-chain.",
    c: "MeterPassSessionValidator",
  },
  {
    t: "Nothing to send money with",
    d: "The agent has no transfer tool. A page that says “send 5 tUSD8 to …” has nothing to call, and the on-chain policy rejects it anyway.",
    c: "TargetNotAllowed",
  },
  {
    t: "A cut-off switch",
    d: `Revoke the pass and the merchant refuses the next request. Measured on Aevum: ${metrics.revokeLatency?.secondsAfterBlock?.toFixed(1) ?? "about 2"} s after the revoke's block.`,
    c: "402 pass_revoked",
  },
  {
    t: "Money that can't leak",
    d: "Claims never exceed the deposit, vouchers can't be replayed on another chain, vault or pass, and refunds wait for the merchant's settlement window.",
    c: "fuzz and invariant tested",
  },
];

export default function LivePage() {
  const { events, stats, connected } = useMerchantFeed();
  const chain = useChainStats();
  // Calls already settled on Aevum (every catalogue call costs 0.002 tUSD8), or the merchant's live count if
  // higher. Both are lower bounds of the true total, and the on-chain one survives server restarts.
  const settledCalls = Number(chain.settledVolume / PRICE);
  const paid = Math.max(settledCalls, stats?.paidRequests ?? 0);
  const settlements = new Set(chain.claims.map((c) => c.hash)).size;

  return (
    <>
      <section className="instrument" aria-labelledby="hero-title">
        <div>
          <h1 id="hero-title">
            Pay per request.
            <br />
            Settle once.
          </h1>
          <p className="lede">
            An AI agent pays for each API call with a signed voucher instead of a transaction. The merchant collects
            hundreds of calls in one transaction. You set the budget once, and can stop the agent at any time.
          </p>
          <div className="ctas">
            <Link className="btn solid" href="/playground">
              Give an agent a pass
            </Link>
            <Link className="btn on-enamel" href="/how">
              See how it works
            </Link>
          </div>
        </div>

        <div className="gauge">
          <div className="gauge-label">
            <span title="Calls settled on Aevum at 0.002 tUSD8 each, or this merchant's live count if higher">Calls paid by voucher</span>
            <span>
              <span className={`lamp ${connected ? "red" : "off"}`} style={{ display: "inline-block", marginRight: 7, verticalAlign: "middle" }} aria-hidden />
              {connected ? "meter running" : "meter offline"}
            </span>
          </div>
          <Odometer value={paid} label="Calls paid by voucher" />
          <div className="gauge-sub">
            <div>
              <b>{tusd(stats?.acceptedVolume)}</b>
              <span>tUSD8 owed to the merchant</span>
            </div>
            <div>
              <b>{chain.loaded ? settlements : "…"}</b>
              <span>settlement transactions</span>
            </div>
            <div>
              <b>{stats && stats.paidRequests > 0 ? `${stats.avgVerifyMs.toFixed(1)} ms` : "–"}</b>
              <span>average to accept a voucher</span>
            </div>
          </div>
          <Tape events={events} />
        </div>
      </section>

      <section className="block" aria-labelledby="vs-title">
        <div className="head">
          <h2 id="vs-title">250 calls, two ways</h2>
          <p>The same 250 calls at 0.002 tUSD8 each, measured on Aevum testnet.</p>
        </div>
        <Versus />
      </section>

      <section className="block split" aria-label="Live activity">
        <LiveRows events={events} connected={connected} />
        <ChainRows chain={chain} />
      </section>

      <section className="block" aria-labelledby="rails-title">
        <div className="head">
          <h2 id="rails-title">Guard rails</h2>
          <p>An agent with a wallet is a risk. These limits hold even if the agent is fooled or its key leaks.</p>
        </div>
        <div className="rails">
          {RAILS.map((r) => (
            <div key={r.t} className="rail">
              <div className="switch" aria-hidden />
              <div>
                <h3>{r.t}</h3>
                <p>{r.d}</p>
                <p>
                  <code>{r.c}</code>
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="block" aria-labelledby="ev-title">
        <div className="head">
          <h2 id="ev-title">Every step on the explorer</h2>
          <p>
            The demo run on Aevum testnet, transaction by transaction.
            {deployment && ` Merchant: ERC-8004 agent #${deployment.merchantAgentId}.`}
          </p>
        </div>
        <EvidenceTable />
        <p className="muted" style={{ marginTop: 14, fontSize: 15 }}>
          {tusd(chain.settledVolume)} tUSD8 settled on-chain so far, {chain.passesOpened} passes opened,{" "}
          {tusd(chain.escrowed)} tUSD8 still held for owners.
        </p>
      </section>
    </>
  );
}
