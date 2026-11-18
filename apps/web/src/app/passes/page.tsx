"use client";

import { useCallback, useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { formatTusd8, passVaultAbi } from "@meterpass/sdk";
import { deployment, explorerAddr, explorerTx, publicClient, short } from "@/lib/config";
import { friendly, useWallet } from "@/lib/wallet";

interface PassView {
  id: bigint;
  owner: Address;
  merchant: Address;
  merchantAgentId: bigint;
  authorizer: Address;
  deposit: bigint;
  claimed: bigint;
  expiry: number;
  closeRequestedAt: number;
  closed: boolean;
  refundableAt: number;
  image?: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function status(p: PassView, now: number) {
  if (p.closed) return { label: "Closed and refunded", lamp: "off" };
  if (p.authorizer === ZERO) return { label: "Paused: agent revoked", lamp: "red" };
  if (p.closeRequestedAt) return { label: "Closing", lamp: "off" };
  if (now > p.expiry) return { label: "Expired, settling", lamp: "off" };
  return { label: "Active", lamp: "" };
}

async function loadPass(id: bigint): Promise<PassView | null> {
  const vault = deployment!.passVault;
  const [p, owner, uri, refundableAt] = await Promise.all([
    publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "getPass", args: [id] }),
    publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "ownerOf", args: [id] }),
    publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "tokenURI", args: [id] }).catch(() => ""),
    publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "refundableAt", args: [id] }),
  ]);
  if (p.merchant === ZERO) return null;
  let image: string | undefined;
  try {
    const json = JSON.parse(atob(uri.split(",")[1] ?? ""));
    image = json.image;
  } catch {
    /* no art */
  }
  return {
    id,
    owner,
    merchant: p.merchant,
    merchantAgentId: BigInt(p.merchantAgentId),
    authorizer: p.authorizer,
    deposit: p.deposit,
    claimed: p.claimed,
    expiry: Number(p.expiry),
    closeRequestedAt: Number(p.closeRequestedAt),
    closed: p.closed,
    refundableAt: Number(refundableAt),
    image,
  };
}

export default function PassesPage() {
  const [passes, setPasses] = useState<PassView[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const { address, wallet, connect, error } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null);
  const [reassignTo, setReassignTo] = useState<Record<string, string>>({});
  const [mineOnly, setMineOnly] = useState(false);

  const refresh = useCallback(async () => {
    if (!deployment) return;
    const next = await publicClient.readContract({ address: deployment.passVault, abi: passVaultAbi, functionName: "nextPassId" });
    const ids: bigint[] = [];
    for (let i = next - 1n; i >= 1n && ids.length < 40; i--) ids.push(i);
    const loaded = (await Promise.all(ids.map((id) => loadPass(id).catch(() => null)))).filter(Boolean) as PassView[];
    setPasses(loaded);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const a = setInterval(refresh, 8000);
    const b = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh]);

  async function act(p: PassView, fn: "revoke" | "setAuthorizer" | "requestClose" | "refund") {
    if (!wallet || !address || !deployment) return;
    setBusy(`${p.id}-${fn}`);
    setMsg(null);
    try {
      let args: readonly unknown[] = [p.id];
      if (fn === "setAuthorizer") {
        const to = reassignTo[p.id.toString()]?.trim();
        if (!to || !isAddress(to)) throw new Error("Enter the new agent's address first.");
        args = [p.id, to];
      }
      const { request } = await publicClient.simulateContract({
        address: deployment.passVault,
        abi: passVaultAbi,
        functionName: fn,
        args: args as never,
        account: address,
      });
      const hash = await wallet.writeContract({ ...request, account: address, chain: wallet.chain, type: "legacy" } as never);
      setMsg({ ok: true, text: "Sent. Waiting for confirmation…", hash });
      await publicClient.waitForTransactionReceipt({ hash });
      setMsg({ ok: true, text: { revoke: "Agent revoked. The merchant now answers 402 to this pass.", setAuthorizer: "Pass handed to the new agent.", requestClose: "Close requested. Refund opens after the settlement window.", refund: "Refunded to your wallet." }[fn], hash });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: friendly(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!deployment) return <p className="block muted">PassVault is not deployed on this network yet.</p>;
  const shown = mineOnly && address ? passes.filter((p) => p.owner.toLowerCase() === address.toLowerCase()) : passes;

  return (
    <>
      <section className="block" style={{ marginTop: 48 }}>
        <div className="head">
          <h2>Passes</h2>
          <p>
            A pass is an NFT that holds prepaid tUSD8 for one merchant. Its owner can pause the agent, hand the pass to
            another agent, or take back unused credit. The card art is drawn on-chain from the pass's live state.
          </p>
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          {address ? (
            <>
              <span className="state">
                <span className="lamp" aria-hidden />
                Connected as {short(address)}
              </span>
              <button className="btn small" aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)}>
                Only my passes
              </button>
            </>
          ) : (
            <button className="btn solid small" onClick={connect}>
              Connect wallet to manage your passes
            </button>
          )}
        </div>
        {error && <div className="notice err" role="alert">{error}</div>}
        {msg && (
          <div className={`notice ${msg.ok ? "ok" : "err"}`} role="status">
            {msg.text}{" "}
            {msg.hash && (
              <a href={explorerTx(msg.hash)} target="_blank" rel="noreferrer">
                View the transaction
              </a>
            )}
          </div>
        )}
      </section>

      {loading && <p className="muted" style={{ marginTop: 24 }}>Reading passes from Aevum…</p>}
      {!loading && shown.length === 0 && <p className="muted" style={{ marginTop: 24 }}>No passes yet. Open one in the playground.</p>}

      <section className="pass-grid" style={{ marginTop: 24 }} aria-label="Passes">
        {shown.map((p) => {
          const s = status(p, now);
          const mine = address && p.owner.toLowerCase() === address.toLowerCase();
          const refundIn = p.refundableAt - now;
          const used = p.deposit === 0n ? 0 : Number((p.claimed * 1000n) / p.deposit) / 10;
          return (
            <article key={p.id.toString()} className="pass" aria-labelledby={`pass-${p.id}`}>
              {p.image ? <img src={p.image} alt={`On-chain card for pass ${p.id}`} /> : <div className="art" />}
              <div className="pass-top">
                <strong id={`pass-${p.id}`}>Pass {p.id.toString()}</strong>
                <span className="state">
                  <span className={`lamp ${s.lamp}`} aria-hidden />
                  {s.label}
                </span>
              </div>
              <div className="meter-bar" role="meter" aria-label="Share of the deposit settled" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
                <div style={{ width: `${used}%` }} />
              </div>
              <dl className="kv">
                <dt>Deposit</dt>
                <dd>{formatTusd8(p.deposit, 3)} tUSD8</dd>
                <dt>Paid to merchant</dt>
                <dd>{formatTusd8(p.claimed, 3)} tUSD8</dd>
                <dt>Merchant</dt>
                <dd>ERC-8004 agent #{p.merchantAgentId.toString()}</dd>
                <dt>Agent key</dt>
                <dd>{p.authorizer === ZERO ? (p.closed ? "none" : "none, revoked") : <a href={explorerAddr(p.authorizer)} target="_blank" rel="noreferrer">{short(p.authorizer)}</a>}</dd>
                <dt>Owner</dt>
                <dd><a href={explorerAddr(p.owner)} target="_blank" rel="noreferrer">{short(p.owner)}</a></dd>
                <dt>Expires</dt>
                <dd>{new Date(p.expiry * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd>
                {!p.closed && (
                  <>
                    <dt>Refund opens</dt>
                    <dd>{refundIn <= 0 ? "now" : `in ${Math.ceil(refundIn / 60)} min`}</dd>
                  </>
                )}
              </dl>
              {mine && !p.closed && (
                <>
                  <div className="actions">
                    {p.authorizer !== ZERO && (
                      <button className="btn danger small" disabled={!!busy} onClick={() => act(p, "revoke")}>
                        {busy === `${p.id}-revoke` ? "Revoking…" : "Revoke agent"}
                      </button>
                    )}
                    {!p.closeRequestedAt && now < p.expiry && (
                      <button className="btn small" disabled={!!busy} onClick={() => act(p, "requestClose")}>
                        Close early
                      </button>
                    )}
                    <button className="btn small" disabled={!!busy || refundIn > 0} onClick={() => act(p, "refund")} title={refundIn > 0 ? "Opens after the merchant's settlement window" : undefined}>
                      Refund unused credit
                    </button>
                  </div>
                  <div className="actions">
                    <label className="sr-only" htmlFor={`to-${p.id}`}>New agent address for pass {p.id.toString()}</label>
                    <input
                      id={`to-${p.id}`}
                      className="field"
                      placeholder="New agent address, 0x…"
                      value={reassignTo[p.id.toString()] ?? ""}
                      onChange={(e) => setReassignTo((m) => ({ ...m, [p.id.toString()]: e.target.value }))}
                    />
                    <button className="btn small" disabled={!!busy} onClick={() => act(p, "setAuthorizer")}>
                      Hand the pass over
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </section>
    </>
  );
}
