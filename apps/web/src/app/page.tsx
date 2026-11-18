"use client";

import Link from "next/link";
import { formatTusd8 } from "@meterpass/sdk";
import { Stat } from "@/components/Stat";
import { Pipeline } from "@/components/Pipeline";
import { Stream } from "@/components/Stream";
import { GasCompare } from "@/components/GasCompare";
import { EvidenceTable } from "@/components/EvidenceTable";
import { useChainStats, useMerchantFeed } from "@/lib/hooks";
import { MERCHANT_URL, deployment, explorerAddr, short } from "@/lib/config";

const n = (s?: string | bigint) => Number(formatTusd8(BigInt(s ?? 0), 6));

export default function LivePage() {
  const { events, stats, connected, rate } = useMerchantFeed();
  const chain = useChainStats();
  const paid = stats?.paidRequests ?? events.filter((e) => e.type === "paid").length;

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">x402 batch settlement · QDay Aevum testnet</div>
          <h1 style={{ marginTop: 14 }}>
            Pay per request.
            <br />
            <span className="grad-text">Settle once.</span>
          </h1>
          <p className="lead">
            An AI agent pays for every API call with a signed voucher instead of a transaction: no gas, a few
            milliseconds. The merchant collects hundreds of calls in <b>one</b> transaction. The owner approves a budget
            once and can stop the agent at any moment.
          </p>
          <div className="cta-row">
            <Link className="btn primary" href="/playground">
              Try it with your wallet →
            </Link>
            <Link className="btn" href="/passes">
              Inspect passes on-chain
            </Link>
            <Link className="btn" href="/how">
              How it works
            </Link>
          </div>
        </div>
        <div className="glass pad glow">
          <div className="card-title">Merchant</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 8 }}>Aevum Chain Intel</div>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.5, margin: "6px 0 0" }}>
            Sells live chain data to agents at <b className="mono">0.002 tUSD8</b> per request.
          </p>
          <dl className="kv">
            <dt>ERC-8004 agent</dt>
            <dd>#{deployment?.merchantAgentId ?? "–"}</dd>
            <dt>Scheme</dt>
            <dd>batch-settlement</dd>
            <dt>Network</dt>
            <dd>eip155:{deployment?.chainId ?? 44005}</dd>
            <dt>Settlement window</dt>
            <dd>{deployment ? `${deployment.settlementWindow}s` : "–"}</dd>
            <dt>PassVault</dt>
            <dd>
              {deployment ? (
                <a href={explorerAddr(deployment.passVault)} target="_blank" rel="noreferrer" className="grad-text">
                  {short(deployment.passVault)}
                </a>
              ) : (
                "not deployed yet"
              )}
            </dd>
            <dt>API feed</dt>
            <dd>
              <span className={`dot ${connected ? "" : "off"}`} style={{ display: "inline-block", marginRight: 6 }} />
              {connected ? "live" : "offline"}
            </dd>
          </dl>
          <p className="muted mono" style={{ fontSize: 11.5, marginTop: 12, overflowWrap: "anywhere" }}>
            {MERCHANT_URL}
          </p>
        </div>
      </section>

      <section className="stats" aria-label="Live counters">
        <Stat label="Paid requests" value={paid} glow sub="each one a voucher, zero transactions" />
        <Stat label="Requests / second" value={rate} decimals={1} sub="live, last 3 seconds" />
        <Stat label="Paid via vouchers" value={n(stats?.acceptedVolume)} decimals={3} suffix="tUSD8" sub="accepted by the merchant" />
        <Stat label="Avg verify time" value={stats?.avgVerifyMs ?? 0} decimals={2} suffix="ms" sub="signature check, no RPC call" />
        <Stat label="Settlement txs" value={chain.claims.length ? new Set(chain.claims.map((c) => c.hash)).size : 0} sub="claimBatch transactions on Aevum" />
        <Stat label="Settled on-chain" value={n(chain.settledVolume)} decimals={3} suffix="tUSD8" sub="PassVault.settledVolume(merchant)" />
        <Stat label="Passes opened" value={chain.passesOpened} sub="ERC-721 passes" />
        <Stat label="In escrow now" value={n(chain.escrowed)} decimals={3} suffix="tUSD8" sub="refundable to owners" />
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <div className="eyebrow">The flow</div>
            <h2>Many vouchers in, one transaction out</h2>
          </div>
        </div>
        <Pipeline events={events} live={connected} />
      </section>

      <section className="section two-col">
        <Stream events={events} connected={connected} />
        <GasCompare />
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <div className="eyebrow">Safety</div>
            <h2>Least privilege, at every layer</h2>
          </div>
        </div>
        <div className="flow">
          {[
            { t: "Budget the agent can't exceed", d: "The session key can only open or top up passes, for allowlisted ERC-8004 merchants, inside a total budget and a time window. Checked by the smart account on-chain.", c: "MeterPassSessionValidator" },
            { t: "No way to send money elsewhere", d: "The agent has no transfer tool. An injected “send 5 tUSD8 to …” has nothing to call, and the on-chain policy rejects it anyway.", c: "TargetNotAllowed" },
            { t: "Stop it instantly", d: "The owner revokes the pass; the merchant sees it within about a block and the very next request gets HTTP 402.", c: "402 pass_revoked" },
            { t: "Money can't leak", d: "Claims never exceed the deposit, vouchers can't be replayed across chains, vaults or passes, and refunds wait for the settlement window.", c: "fuzz + invariant tested" },
          ].map((x) => (
            <div key={x.t} className="glass step">
              <h3>{x.t}</h3>
              <p>{x.d}</p>
              <span className="chip ok">{x.c}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <div className="eyebrow">Verifiable</div>
            <h2>Every step, on the explorer</h2>
          </div>
          <span className="muted" style={{ fontSize: 14 }}>
            Transactions from the demo run on Aevum testnet
          </span>
        </div>
        <EvidenceTable />
      </section>
    </>
  );
}
