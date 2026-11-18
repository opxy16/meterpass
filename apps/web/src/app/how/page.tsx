import Link from "next/link";
import { REPO_URL, deployment, explorerAddr, short } from "@/lib/config";

export const metadata = { title: "How MeterPass works" };

const steps = [
  {
    t: "You approve once",
    d: "One transaction creates a smart account and gives your agent a session key: which merchants (by ERC-8004 id), how much in total, until when. Or one EIP-3009 signature opens a single pass.",
  },
  {
    t: "The agent opens a pass",
    d: "With only its session key, through the Aevum bundler, the agent moves part of the budget into a pass: an NFT that holds tUSD8 for one merchant. You own the NFT, not the agent.",
  },
  {
    t: "Each call is paid with a voucher",
    d: "The API answers 402 with a batch-settlement offer. The agent signs “pass 7, 0.502 tUSD8 used so far” and retries. The merchant checks it in about a millisecond. No transaction.",
  },
  {
    t: "The merchant settles in bulk",
    d: "Whenever it likes, the merchant submits the latest voucher of each pass in one claimBatch transaction and is paid the difference since its last claim.",
  },
];

const guarantees: [string, string][] = [
  ["Vouchers carry a running total", "Each voucher states the total used so far, so sending an old one again, or sending them out of order, pays nothing extra."],
  ["They only work for one chain, vault and pass", "The signed message names the pass; the signature domain names the chain and the vault."],
  ["Claims never exceed the deposit", "PassVault refuses any voucher above what was deposited. An invariant test checks this across thousands of random runs."],
  ["Refunds wait for the merchant", "Unused credit returns to you only after expiry (or a close request) plus the settlement window, which is longer than the merchant's claim interval."],
  ["Revoking stops the agent", "Clear the pass's agent key and the merchant refuses the next request, about 2 seconds after the block on Aevum. Vouchers signed before the revoke stay claimable for the window, so honest merchants are paid for work done."],
  ["The agent can't be talked into paying", "Its only payment tool signs vouchers for its pass, its merchant, under its price limit. Its session key can't call the token at all."],
];

export default function HowPage() {
  return (
    <>
      <section className="block" style={{ marginTop: 48 }}>
        <div className="head">
          <h2>A prepaid meter for AI agents</h2>
          <p>
            Paying per call on-chain means one transaction, and one fee, per call. MeterPass works like a payment channel:
            money is locked once, every call is paid by an off-chain signature, and the merchant collects the total
            whenever it wants. It speaks x402, the HTTP 402 payment standard, with a new scheme called batch-settlement.
          </p>
        </div>
        <ol className="seq">
          {steps.map((s, i) => (
            <li key={s.t}>
              <span className="k" aria-hidden>
                {i + 1}
              </span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="block" aria-labelledby="wire-title">
        <div className="head">
          <h2 id="wire-title">What travels over HTTP</h2>
          <p>Standard x402 headers, decoded. The server asks; the agent answers with a voucher.</p>
        </div>
        <div className="pair">
          <div>
            <h3>The server&apos;s offer, in PAYMENT-REQUIRED</h3>
            <pre className="code">{`{
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
          <div>
            <h3>The agent&apos;s payment, in PAYMENT-SIGNATURE</h3>
            <pre className="code">{`{
  "x402Version": 2,
  "accepted": { …the offer… },
  "payload": {
    "passId": "7",
    "cumulativeAmount": "502000",
    "signature": "0x…"   // EIP-712
  }
}

Voucher(uint256 passId,
        uint128 cumulativeAmount)
domain: MeterPass v1, chain 44005, PassVault`}</pre>
          </div>
        </div>
      </section>

      <section className="block" aria-labelledby="g-title">
        <div className="head">
          <h2 id="g-title">What the contracts guarantee</h2>
        </div>
        <div className="table-wrap">
          <table>
            <tbody>
              {guarantees.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" style={{ color: "var(--ink)", fontSize: 15, width: "32%" }}>
                    {k}
                  </th>
                  <td style={{ color: "var(--ink-2)" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="block pair" aria-label="Contracts and SDK">
        <div>
          <div className="head" style={{ marginBottom: 16 }}>
            <h2>Contracts on Aevum</h2>
          </div>
          {deployment ? (
            <dl className="kv" style={{ fontSize: 15 }}>
              {(
                [
                  ["PassVault", deployment.passVault],
                  ["Session validator", deployment.sessionValidator],
                  ["ERC-8004 identity", deployment.identityRegistry],
                  ["ERC-8004 reputation", deployment.reputationRegistry],
                  ["tUSD8", deployment.token],
                  ["EntryPoint v0.7", deployment.entryPoint],
                  ["Kernel v3.1 factory", deployment.kernelFactory],
                ] as const
              ).map(([k, a]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>
                    <a href={explorerAddr(a)} target="_blank" rel="noreferrer">
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
        <div>
          <div className="head" style={{ marginBottom: 16 }}>
            <h2>Use it from code</h2>
          </div>
          <pre className="code">{`import { createMeterPassFetch } from "@meterpass/sdk";

const pay = createMeterPassFetch({
  signer: agentKey, chainId: 44005, passId,
  policy: { maxAmountPerRequest: 10_000n, … },
});
const res = await pay("https://api…/v1/data");`}</pre>
          <div className="actions">
            <a className="btn small" href={REPO_URL} target="_blank" rel="noreferrer">
              Read the source
            </a>
            <Link className="btn solid small" href="/playground">
              Try it with your wallet
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
