import Link from "next/link";
import { REPO_URL, deployment, explorerAddr, short } from "@/lib/config";

export const metadata = { title: "How MeterPass works" };

const steps = [
  {
    t: "The owner approves once",
    d: "One signature creates a Kernel v3.1 smart account and installs a session key for the agent: which merchants (by ERC-8004 id), how much in total, until when. Or, without a smart account, one EIP-3009 signature opens a single pass.",
    chip: "1 signature",
  },
  {
    t: "The agent opens a pass",
    d: "Using only its session key, through the Aevum bundler, the agent moves part of the budget into a pass: an ERC-721 that escrows tUSD8 for one merchant. The pass NFT belongs to the owner, not the agent.",
    chip: "ERC-721 · escrow",
  },
  {
    t: "Every request: a voucher",
    d: "The API answers 402 with an x402 `batch-settlement` offer. The agent signs “pass #7, 0.502 tUSD8 used so far” (EIP-712) and retries. The merchant checks the signature in about a millisecond. No transaction.",
    chip: "0 gas · ~ms",
  },
  {
    t: "The merchant settles in bulk",
    d: "Whenever it likes, the merchant submits the latest voucher of each pass in one claimBatch transaction and receives the difference since its last claim. 250 requests, 1 transaction.",
    chip: "1 tx for N calls",
  },
];

const guarantees = [
  ["Vouchers are cumulative", "Each voucher states the running total, so replaying an old one or sending them out of order pays nothing extra."],
  ["Bound to chain + vault + pass", "The EIP-712 domain includes the chain id and the vault address, and the message includes the pass id."],
  ["Claims never exceed the deposit", "PassVault refuses any voucher above what was deposited; an invariant test checks this over thousands of random runs."],
  ["Refunds wait for the merchant", "Unused credit goes back to the owner only after expiry (or a close request) plus the settlement window, which is longer than the merchant's claim interval."],
  ["Revocation is instant", "The owner clears the pass's agent key. The merchant's cache sees it within about one block; the next request gets 402. Vouchers signed before the revoke stay claimable for the window, so honest merchants are paid for work done."],
  ["The agent can't be talked into paying", "Its only payment tool signs vouchers for its pass, its merchant, at its price limit. Its session key can't call the token. A prompt-injected “send 5 tUSD8” has nowhere to go."],
];

export default function HowPage() {
  return (
    <>
      <section className="section">
        <div className="eyebrow">How it works</div>
        <h2>A prepaid meter for AI agents</h2>
        <p className="lead" style={{ marginTop: 10 }}>
          Paying per API call on-chain means one transaction, and one fee, per call. MeterPass works like a payment
          channel: money is locked once, every call is paid by an off-chain signature, and the merchant collects the
          total whenever it wants. It speaks x402, the HTTP 402 payment standard, with a new scheme:{" "}
          <span className="mono">batch-settlement</span>.
        </p>
      </section>

      <section className="section flow">
        {steps.map((s, i) => (
          <div key={s.t} className="glass step">
            <div className="num">{i + 1}</div>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
            <span className="chip ok">{s.chip}</span>
          </div>
        ))}
      </section>

      <section className="section two-col">
        <div className="glass pad">
          <div className="card-title">The 402 offer (PAYMENT-REQUIRED, decoded)</div>
          <pre className="mono" style={{ fontSize: 12.5, lineHeight: 1.55, overflowX: "auto", marginTop: 12, color: "var(--ink-2)" }}>{`{
  "x402Version": 2,
  "accepts": [{
    "scheme": "batch-settlement",
    "network": "eip155:44005",
    "amount": "2000",            // 0.002 tUSD8
    "asset": "0x4565…3483",      // tUSD8
    "payTo": "<merchant wallet>",
    "extra": {
      "vault": "<PassVault>",
      "merchantAgentId": "1",    // ERC-8004
      "settlementWindow": 300
    }
  }]
}`}</pre>
        </div>
        <div className="glass pad">
          <div className="card-title">The payment (PAYMENT-SIGNATURE, decoded)</div>
          <pre className="mono" style={{ fontSize: 12.5, lineHeight: 1.55, overflowX: "auto", marginTop: 12, color: "var(--ink-2)" }}>{`{
  "x402Version": 2,
  "accepted": { …the offer above… },
  "payload": {
    "passId": "7",
    "cumulativeAmount": "502000",
    "signature": "0x…"   // EIP-712 Voucher
  }
}

Voucher(uint256 passId, uint128 cumulativeAmount)
domain: MeterPass v1, chainId 44005, PassVault`}</pre>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <div className="eyebrow">Guarantees</div>
            <h2>What the contracts enforce</h2>
          </div>
        </div>
        <div className="glass table-wrap">
          <table className="table">
            <tbody>
              {guarantees.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ fontWeight: 600, width: "28%" }}>{k}</td>
                  <td className="muted" style={{ lineHeight: 1.55 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section two-col">
        <div className="glass pad">
          <div className="card-title">Contracts on Aevum testnet</div>
          {deployment ? (
            <dl className="kv">
              {(
                [
                  ["PassVault", deployment.passVault],
                  ["Session validator", deployment.sessionValidator],
                  ["ERC-8004 Identity", deployment.identityRegistry],
                  ["ERC-8004 Reputation", deployment.reputationRegistry],
                  ["tUSD8", deployment.token],
                  ["EntryPoint v0.7", deployment.entryPoint],
                  ["Kernel v3.1 factory", deployment.kernelFactory],
                ] as const
              ).map(([k, a]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>
                    <a href={explorerAddr(a)} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)" }}>
                      {short(a, 6)}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">Not deployed on this network yet.</p>
          )}
        </div>
        <div className="glass pad">
          <div className="card-title">Use it in your API</div>
          <pre className="mono" style={{ fontSize: 12.5, lineHeight: 1.55, overflowX: "auto", marginTop: 12, color: "var(--ink-2)" }}>{`import { createMeterPassFetch } from "@meterpass/sdk";

const pay = createMeterPassFetch({
  signer: agentKey, chainId: 44005, passId,
  policy: { maxAmountPerRequest: 10_000n, … },
});
const res = await pay("https://api…/v1/data");`}</pre>
          <div className="actions">
            <a className="btn small" href={REPO_URL} target="_blank" rel="noreferrer">Read the code</a>
            <Link className="btn small primary" href="/playground">Try it</Link>
          </div>
        </div>
      </section>
    </>
  );
}
