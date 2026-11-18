"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, formatEther, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MemoryLedger,
  PaymentRefusedError,
  createMeterPassFetch,
  formatTusd8,
  openAuthorizationTypedData,
  passVaultAbi,
  toUnits,
  type OpenRequest,
} from "@meterpass/sdk";
import { CHAIN_ID, MERCHANT_URL, deployment, explorerTx, publicClient, short } from "@/lib/config";
import { friendly, useWallet } from "@/lib/wallet";

type Log = { at: number; kind: "ok" | "bad" | "info"; text: string; hash?: string };
const AGENT_KEY = "meterpass.playground.agentKey";

export default function Playground() {
  const { address, wallet, connect, error } = useWallet();
  const [bal, setBal] = useState<{ usd: bigint; gas: bigint } | null>(null);
  const [agentKey, setAgentKey] = useState<Hex | null>(null);
  const [passId, setPassId] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("0.1");
  const [calls, setCalls] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, cumulative: 0n, ms: 0 });
  const [log, setLog] = useState<Log[]>([]);
  const ledger = useRef(new MemoryLedger());
  const merchantBase = useMemo(() => (MERCHANT_URL.startsWith("http") ? MERCHANT_URL : `${typeof window !== "undefined" ? window.location.origin : ""}${MERCHANT_URL}`), []);

  const say = (kind: Log["kind"], text: string, hash?: string) => setLog((l) => [{ at: Date.now(), kind, text, hash }, ...l].slice(0, 80));

  useEffect(() => {
    try {
      const k = sessionStorage.getItem(AGENT_KEY) as Hex | null;
      if (k) setAgentKey(k);
      const p = sessionStorage.getItem(`${AGENT_KEY}.pass`);
      if (p) setPassId(BigInt(p));
    } catch {
      /* storage blocked */
    }
  }, []);

  useEffect(() => {
    if (!address || !deployment) return;
    const load = async () => {
      const [usd, gas] = await Promise.all([
        publicClient.readContract({ address: deployment!.token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        publicClient.getBalance({ address }),
      ]);
      setBal({ usd, gas });
    };
    void load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, [address]);

  const agent = agentKey ? privateKeyToAccount(agentKey) : null;

  function makeAgent() {
    const k = generatePrivateKey();
    try {
      sessionStorage.setItem(AGENT_KEY, k);
    } catch {
      /* ok: lives in memory only */
    }
    setAgentKey(k);
    say("info", "Created a fresh agent key in this browser tab. It can only sign vouchers for passes you give it.");
  }

  async function openPass() {
    if (!wallet || !address || !agent || !deployment) return;
    setBusy("open");
    try {
      const now = Math.floor(Date.now() / 1000);
      const req: OpenRequest = {
        owner: address,
        merchantAgentId: BigInt(deployment.merchantAgentId ?? 0),
        authorizer: agent.address,
        amount: toUnits(amount),
        expiry: BigInt(now + 3600),
        salt: keccak256(toHex(`${address}:${now}:${Math.random()}`)),
      };
      const validBefore = BigInt(now + 1800);
      const typed = openAuthorizationTypedData({ chainId: CHAIN_ID, vault: deployment.passVault, token: deployment.token, req, validBefore });
      say("info", "Sign ONE message in your wallet: it authorises exactly this pass (amount, merchant, agent, expiry). No gas.");
      const signature = await wallet.signTypedData({ ...typed, account: address });
      const res = await fetch("/api/relay/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ req: { ...req, merchantAgentId: req.merchantAgentId.toString(), amount: req.amount.toString(), expiry: req.expiry.toString() }, validBefore: validBefore.toString(), signature }),
      });
      const j = (await res.json()) as { passId?: string; hash?: Hex; error?: string };
      if (!res.ok || !j.passId) throw new Error(j.error ?? "relay failed");
      setPassId(BigInt(j.passId));
      try {
        sessionStorage.setItem(`${AGENT_KEY}.pass`, j.passId);
      } catch {}
      ledger.current = new MemoryLedger();
      say("ok", `Pass #${j.passId} opened with ${amount} tUSD8. The relayer paid the gas.`, j.hash);
    } catch (e) {
      say("bad", friendly(e));
    } finally {
      setBusy(null);
    }
  }

  function payer() {
    return createMeterPassFetch({
      signer: agent!,
      chainId: CHAIN_ID,
      passId: passId!,
      ledger: ledger.current,
      policy: {
        network: `eip155:${CHAIN_ID}`,
        asset: deployment!.token,
        vault: deployment!.passVault,
        maxAmountPerRequest: toUnits("0.01"),
        allowedMerchantAgentIds: [BigInt(deployment!.merchantAgentId ?? 0)],
      },
    });
  }

  async function run() {
    if (!agent || passId === null) return;
    setBusy("run");
    const pay = payer();
    const t0 = performance.now();
    setProgress({ done: 0, total: calls, cumulative: await ledger.current.get(passId), ms: 0 });
    try {
      for (let i = 0; i < calls; i++) {
        const res = await pay(`${merchantBase}/v1/block/latest`);
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          say("bad", `Call ${i + 1}: HTTP ${res.status} ${j.error ?? ""}. ${j.message ?? ""}`);
          break;
        }
        const c = await ledger.current.get(passId);
        setProgress({ done: i + 1, total: calls, cumulative: c, ms: performance.now() - t0 });
      }
      const c = await ledger.current.get(passId);
      say("ok", `Paid calls done. Your agent has signed vouchers for ${formatTusd8(c, 3)} tUSD8 in total, with zero transactions.`);
    } catch (e) {
      say("bad", friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function injection() {
    if (!agent || passId === null) return;
    setBusy("inject");
    try {
      await payer()(`${merchantBase}/v1/premium`);
      say("bad", "Paid an over-priced call (should not happen).");
    } catch (e) {
      if (e instanceof PaymentRefusedError) say("ok", `Refused before signing: the merchant asked 5 tUSD8 per call, the agent's limit is 0.01. (${e.reason})`);
      else say("bad", friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!wallet || !address || passId === null || !deployment) return;
    setBusy("revoke");
    try {
      const hash = await wallet.writeContract({ address: deployment.passVault, abi: passVaultAbi, functionName: "revoke", args: [passId], account: address, chain: wallet.chain, type: "legacy" });
      say("info", "Revoke sent…", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      say("ok", "Agent revoked on-chain. Try one more call: the merchant should answer 402.", hash);
    } catch (e) {
      say("bad", friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function settle() {
    setBusy("settle");
    try {
      const res = await fetch("/api/merchant/settle", { method: "POST" });
      const j = (await res.json()) as { hash?: Hex; totalPaid?: string; gasUsed?: string; requests?: number; nothingToSettle?: boolean; error?: string };
      if (j.nothingToSettle) say("info", "Nothing new to settle.");
      else if (j.hash) say("ok", `Merchant settled ${formatTusd8(BigInt(j.totalPaid ?? 0), 3)} tUSD8 in ONE transaction (${Number(j.gasUsed).toLocaleString()} gas).`, j.hash);
      else say("bad", j.error ?? "settlement failed");
    } catch (e) {
      say("bad", friendly(e));
    } finally {
      setBusy(null);
    }
  }

  const stepDone = [!!address, !!agent, passId !== null, progress.done > 0];
  const current = stepDone.findIndex((d) => !d);

  if (!deployment) return <p className="block muted">The playground goes live once MeterPass is deployed on Aevum.</p>;
  const cls = (i: number) => `step ${stepDone[i] ? "done" : current === i ? "current" : ""}`;

  return (
    <>
      <section className="block" style={{ marginTop: 48 }}>
        <div className="head">
          <h2>Give an agent a pass, then watch it pay</h2>
          <p>
            You need a little tUSD8, and tQDAY only if you want to revoke from your wallet. Both come from the QDay
            Discord faucet. This is testnet: tUSD8 has no value.
          </p>
        </div>
      </section>

      <section className="split" style={{ alignItems: "start" }}>
        <ol className="steps">
          <li className={cls(0)}>
            <div className="n" aria-hidden>1</div>
            <div>
              <h3>Connect your wallet</h3>
              <p>MetaMask, Rabby or any browser wallet. It will be switched to Aevum testnet (chain 44005).</p>
              {address ? (
                <div className="notice ok">
                  Connected as {short(address)}.{" "}
                  {bal ? `${formatTusd8(bal.usd, 3)} tUSD8 and ${Number(formatEther(bal.gas)).toFixed(4)} tQDAY.` : "Reading balances…"}
                </div>
              ) : (
                <div className="actions">
                  <button className="btn solid" onClick={connect}>Connect wallet</button>
                </div>
              )}
              {error && <div className="notice err" role="alert">{error}</div>}
            </div>
          </li>

          <li className={cls(1)}>
            <div className="n" aria-hidden>2</div>
            <div>
              <h3>Create an agent key</h3>
              <p>A throwaway key that lives in this browser tab. It can sign vouchers for the pass you give it, and nothing else: it holds no money.</p>
              {agent ? (
                <div className="notice ok">Agent key {short(agent.address, 6)} is ready.</div>
              ) : (
                <div className="actions">
                  <button className="btn" onClick={makeAgent} disabled={!address}>Create agent key</button>
                </div>
              )}
            </div>
          </li>

          <li className={cls(2)}>
            <div className="n" aria-hidden>3</div>
            <div>
              <h3>Open a pass with one signature</h3>
              <p>Your wallet signs once. The signature fixes the amount, the merchant, your agent and a one-hour expiry, so nobody can change them. A relayer pays the gas.</p>
              <div className="actions" role="group" aria-label="Pass amount">
                {["0.05", "0.1", "0.25"].map((a) => (
                  <button key={a} className="btn small" aria-pressed={amount === a} onClick={() => setAmount(a)}>{a} tUSD8</button>
                ))}
              </div>
              <div className="actions">
                <button className="btn solid" disabled={!agent || !address || busy !== null} onClick={openPass}>{busy === "open" ? "Waiting for your signature…" : "Sign and open pass"}</button>
              </div>
              {passId !== null && <div className="notice ok">Pass {passId.toString()} is yours. You can see it on the Passes page.</div>}
            </div>
          </li>

          <li className={cls(3)}>
            <div className="n" aria-hidden>4</div>
            <div>
              <h3>Let the agent pay per call</h3>
              <p>Each call is paid with a voucher signed in your browser: no wallet pop-up, no gas, a few milliseconds.</p>
              <div className="actions" role="group" aria-label="Number of calls">
                {[20, 50, 100].map((n) => (
                  <button key={n} className="btn small" aria-pressed={calls === n} onClick={() => setCalls(n)}>{n} calls</button>
                ))}
              </div>
              <div className="actions">
                <button className="btn solid" disabled={passId === null || busy !== null} onClick={run}>{busy === "run" ? "Paying…" : `Make ${calls} paid calls`}</button>
              </div>
              {progress.total > 0 && (
                <>
                  <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Paid calls">
                    <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                  </div>
                  <p style={{ fontSize: 15 }}>
                    {progress.done} of {progress.total} paid, {formatTusd8(progress.cumulative, 3)} tUSD8 in total,{" "}
                    {progress.done ? (progress.ms / progress.done).toFixed(0) : 0} ms per call, no transactions.
                  </p>
                </>
              )}
            </div>
          </li>

          <li className="step">
            <div className="n" aria-hidden>5</div>
            <div>
              <h3>Test the guard rails</h3>
              <p>An over-priced quote is refused before anything is signed. Revoking from your wallet stops the next request. Settling turns all the vouchers into one transaction.</p>
              <div className="actions">
                <button className="btn small" disabled={passId === null || busy !== null} onClick={injection}>Ask for a 5 tUSD8 call</button>
                <button className="btn danger small" disabled={passId === null || busy !== null} onClick={revoke}>{busy === "revoke" ? "Revoking…" : "Revoke the agent"}</button>
                <button className="btn small" disabled={busy !== null} onClick={settle}>{busy === "settle" ? "Settling…" : "Settle now"}</button>
              </div>
            </div>
          </li>
        </ol>

        <div className="panel log">
          <div className="panel-head">
            <h3>What happened</h3>
          </div>
          <div className="rows" role="log" aria-live="polite">
            {log.length === 0 && <p className="empty">Your steps and their results appear here.</p>}
            {log.map((l, i) => (
              <div key={`${l.at}-${i}`} className="r" style={{ gridTemplateColumns: "64px minmax(0,1fr)" }}>
                <span className="t">{new Date(l.at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span>
                <span style={{ color: l.kind === "bad" ? "var(--red-ink)" : l.kind === "ok" ? "var(--ink)" : "var(--ink-2)" }}>
                  {l.text}{" "}
                  {l.hash && (
                    <a href={explorerTx(l.hash)} target="_blank" rel="noreferrer">
                      {short(l.hash)}
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
