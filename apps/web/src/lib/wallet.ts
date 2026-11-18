"use client";

import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, toHex, type Address, type WalletClient } from "viem";
import { chain, EXPLORER, RPC_URL } from "./config";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };
const eth = () => (typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null);

async function ensureChain(provider: Eip1193) {
  const hex = toHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    });
  }
}

/** Minimal injected-wallet connection (MetaMask, Rabby, …) pinned to Aevum testnet. */
export function useWallet() {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = useCallback((addr: Address) => {
    const p = eth();
    if (!p) return;
    setAddress(addr);
    setWallet(createWalletClient({ account: addr, chain, transport: custom(p) }));
  }, []);

  useEffect(() => {
    const p = eth();
    if (!p) return;
    p.request({ method: "eth_accounts" })
      .then((a) => {
        const list = a as Address[];
        if (list[0]) build(list[0]);
      })
      .catch(() => {});
    const onAccounts = (...a: unknown[]) => {
      const list = a[0] as Address[];
      if (list?.[0]) build(list[0]);
      else {
        setAddress(null);
        setWallet(null);
      }
    };
    p.on?.("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, [build]);

  const connect = useCallback(async () => {
    setError(null);
    const p = eth();
    if (!p) {
      setError("No browser wallet found. Install MetaMask or Rabby, then reload.");
      return;
    }
    try {
      const [addr] = (await p.request({ method: "eth_requestAccounts" })) as Address[];
      await ensureChain(p);
      build(addr!);
    } catch (e) {
      setError(friendly(e));
    }
  }, [build]);

  return { address, wallet, connect, error, ensureChain: async () => { const p = eth(); if (p) await ensureChain(p); } };
}

/** Plain-language error messages for the common wallet and contract failures. */
export function friendly(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number; cause?: { data?: { errorName?: string } } };
  if (err?.code === 4001 || /rejected|denied/i.test(err?.message ?? "")) return "You cancelled the request in your wallet.";
  const name = err?.cause?.data?.errorName;
  const map: Record<string, string> = {
    NotPassOwner: "Only the pass owner can do that.",
    PassClosed: "This pass is already closed.",
    NotRefundableYet: "Not refundable yet: the merchant still has time to settle.",
    AuthorizerIsMerchant: "The merchant can't be the pass's agent.",
    BadExpiry: "That expiry isn't allowed.",
  };
  if (name && map[name]) return map[name];
  if (/insufficient funds/i.test(err?.message ?? "")) return "Not enough tQDAY for gas. Get some from the QDay faucet.";
  return err?.shortMessage ?? err?.message ?? String(e);
}
