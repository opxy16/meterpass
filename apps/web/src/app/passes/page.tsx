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
  if (p.closed) return { label: "Closed · refunded", cls: "" };
  if (p.authorizer === ZERO) return { label: "Paused · agent revoked", cls: "bad" };
  if (p.closeRequestedAt) return { label: "Closing", cls: "warn" };
  if (now > p.expiry) return { label: "Expired · settling", cls: "warn" };
  return { label: "Active", cls: "ok" };
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

  if (!deployment) return <div className="glass pad section">PassVault is not deployed on this network yet.</div>;
  const shown = mineOnly && address ? passes.filter((p) => p.owner.toLowerCase() === address.toLowerCase()) : passes;

  return (
    <>
      <section className="section">
        <div className="section-head">
          <div>
            <div className="eyebrow">ERC-721 · on-chain art · live state</div>
            <h2>Passes</h2>
            <p className="lead" style={{ marginTop: 8 }}>
              Each pass is an NFT that holds prepaid tUSD8 for one merchant. Its owner can pause the agent, hand the pass
              to another agent, or take back unused credit.
            </p>
          </div>
          <div className="actions" style={{ marginTop: 0 }}>
            {address ? (
              <>
                <span className="chip ok" style={{ marginTop: 0 }}>{short(address)}</span>
                <button className="btn small" onClick={() => setMineOnly((v) => !v)}>
                  {mineOnly ? "Show all" : "Only mine"}
                </button>
              </>
            ) : (
              <button className="btn primary small" onClick={connect}>
                Connect wallet to manage yours
              </button>
            )}
          </div>
        </div>
        {error && <div className="note err">{error}</div>}
        {msg && (
          <div className={`note ${msg.ok ? "ok" : "err"}`}>
            {msg.text}{" "}
            {msg.hash && (
              <a className="grad-text" href={explorerTx(msg.hash)} target="_blank" rel="noreferrer">
                view transaction
              </a>
            )}
          </div>
        )}
      </section>

      {loading && <div className="glass pad muted">Reading passes from Aevum…</div>}
      {!loading && shown.length === 0 && <div className="glass pad muted">No passes yet.</div>}

      <section className="pass-grid" style={{ marginTop: 18 }}>
        {shown.map((p) => {
          const s = status(p, now);
          const mine = address && p.owner.toLowerCase() === address.toLowerCase();
          const refundIn = p.refundableAt - now;
          const used = p.deposit === 0n ? 0 : Number((p.claimed * 1000n) / p.deposit) / 10;
          return (
            <article key={p.id.toString()} className="glass pad">
              {p.image ? <img className="pass-art" src={p.image} alt={`MeterPass #${p.id} card`} /> : <div className="pass-art" />}
              <div className="actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <strong>Pass #{p.id.toString()}</strong>
                <span className={`chip ${s.cls}`} style={{ marginTop: 0 }}>{s.label}</span>
              </div>
              <div className="progress" title={`${used}% settled`}>
                <div style={{ width: `${used}%` }} />
              </div>
              <dl className="kv">
                <dt>Deposit</dt>
                <dd>{formatTusd8(p.deposit, 3)} tUSD8</dd>
                <dt>Settled to merchant</dt>
                <dd>{formatTusd8(p.claimed, 3)} tUSD8</dd>
                <dt>Merchant</dt>
                <dd>agent #{p.merchantAgentId.toString()}</dd>
                <dt>Agent key</dt>
                <dd>{p.authorizer === ZERO ? (p.closed ? "none" : "none (revoked)") : <a href={explorerAddr(p.authorizer)} target="_blank" rel="noreferrer">{short(p.authorizer)}</a>}</dd>
                <dt>Owner</dt>
                <dd><a href={explorerAddr(p.owner)} target="_blank" rel="noreferrer">{short(p.owner)}</a></dd>
                <dt>Expires</dt>
                <dd>{new Date(p.expiry * 1000).toLocaleString()}</dd>
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
                    <button className="btn small" disabled={!!busy || refundIn > 0} onClick={() => act(p, "refund")} title={refundIn > 0 ? "Waits for the settlement window" : ""}>
                      Refund unused
                    </button>
                  </div>
                  <div className="actions">
                    <input
                      className="input"
                      placeholder="New agent address 0x…"
                      value={reassignTo[p.id.toString()] ?? ""}
                      onChange={(e) => setReassignTo((m) => ({ ...m, [p.id.toString()]: e.target.value }))}
                    />
                    <button className="btn small" disabled={!!busy} onClick={() => act(p, "setAuthorizer")}>
                      Hand to this agent
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
