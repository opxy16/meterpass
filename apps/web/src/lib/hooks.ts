"use client";

import { useEffect, useRef, useState } from "react";
import { getAbiItem, type Address } from "viem";
import { passVaultAbi, getLogsChunked } from "@meterpass/sdk";
import { MERCHANT_URL, deployment, publicClient } from "./config";

export type FeedEvent =
  | { type: "paid"; at: number; path: string; passId: string; cumulative: string; price: string; verifyMs: number; requests: number; signer: string }
  | { type: "rejected"; at: number; path: string; passId?: string; error: string; message: string; status: number }
  | { type: "settled"; at: number; hash: string; gasUsed: string; totalPaid: string; passes: number; requests: number; blockNumber: string }
  | { type: "settle_failed"; at: number; error: string }
  | { type: "pass"; at: number; passId: string; event: string; authorizer: string; deposit: string; claimed: string; closed: boolean };

export interface MerchantStats {
  paidRequests: number;
  acceptedVolume: string;
  rejected: Record<string, number>;
  avgVerifyMs: number;
  settlements: Extract<FeedEvent, { type: "settled" }>[];
  settledVolume: string;
  settlementGas: string;
}

/**
 * Live merchant feed: Server-Sent Events from /events, with /history polling whenever the stream
 * is not open (serverless hosts cut long connections), plus /stats polling.
 */
export function useMerchantFeed(base: string = MERCHANT_URL) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [stats, setStats] = useState<MerchantStats | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [reachable, setReachable] = useState(false);
  const [rate, setRate] = useState(0);
  const stamps = useRef<number[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let alive = true;
    let open = false;
    const seen = new Set<string>();
    const keyOf = (e: FeedEvent) => `${e.type}:${e.at}:${"cumulative" in e ? e.cumulative : "hash" in e ? e.hash : ""}`;
    const merge = (incoming: FeedEvent[]) => {
      const fresh = incoming.filter((e) => !seen.has(keyOf(e)));
      if (fresh.length === 0) return;
      for (const e of fresh) {
        seen.add(keyOf(e));
        if (e.type === "paid" && Date.now() - e.at < 4000) stamps.current.push(Date.now());
      }
      setEvents((prev) => [...fresh, ...prev].sort((a, b) => b.at - a.at).slice(0, 120));
    };
    try {
      es = new EventSource(`${base}/events`);
      es.onopen = () => {
        open = true;
        setStreaming(true);
      };
      es.onerror = () => {
        open = false;
        setStreaming(false);
      };
      for (const t of ["paid", "rejected", "settled", "settle_failed", "pass"]) {
        es.addEventListener(t, (m) => merge([JSON.parse((m as MessageEvent).data)]));
      }
    } catch {
      /* no EventSource: polling covers it */
    }
    const poll = async () => {
      try {
        const [s, h] = await Promise.all([
          fetch(`${base}/stats`, { cache: "no-store" }),
          open ? null : fetch(`${base}/history?limit=60`, { cache: "no-store" }),
        ]);
        if (!alive) return;
        setReachable(s.ok);
        if (s.ok) setStats(await s.json());
        if (h?.ok) merge(((await h.json()) as FeedEvent[]).reverse());
      } catch {
        if (alive) setReachable(false);
      }
    };
    void poll();
    const statsId = setInterval(poll, 3000);
    const rateId = setInterval(() => {
      const now = Date.now();
      stamps.current = stamps.current.filter((t) => now - t < 3000);
      setRate(stamps.current.length / 3);
    }, 500);
    return () => {
      alive = false;
      es?.close();
      clearInterval(statsId);
      clearInterval(rateId);
    };
  }, [base]);

  return { events, stats, connected: reachable || streaming, streaming, rate };
}

export interface ChainStats {
  passesOpened: number;
  settledVolume: bigint;
  escrowed: bigint;
  claims: { hash: string; passId: bigint; paid: bigint; cumulative: bigint; block: bigint }[];
  loaded: boolean;
}

/** Facts read straight from PassVault on Aevum. */
export function useChainStats(pollMs = 6000): ChainStats {
  const [s, setS] = useState<ChainStats>({ passesOpened: 0, settledVolume: 0n, escrowed: 0n, claims: [], loaded: false });
  useEffect(() => {
    if (!deployment) return;
    const vault = deployment.passVault as Address;
    let alive = true;
    // Scan the vault's history once, then only read blocks added since (Aevum caps getLogs at 1,000 blocks).
    let scannedTo = BigInt(deployment.startBlock) - 1n;
    let claims: ChainStats["claims"] = [];
    const load = async () => {
      try {
        const [next, escrowed, settled] = await Promise.all([
          publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "nextPassId" }),
          publicClient.readContract({ address: vault, abi: passVaultAbi, functionName: "totalEscrowed" }),
          publicClient.readContract({
            address: vault,
            abi: passVaultAbi,
            functionName: "settledVolume",
            args: [BigInt(deployment!.merchantAgentId ?? 0)],
          }),
        ]);
        // Cheap facts first, so the meter has a number before the history scan finishes.
        if (alive) setS((prev) => ({ ...prev, passesOpened: Number(next) - 1, escrowed, settledVolume: settled }));
        const head = await publicClient.getBlockNumber();
        if (head > scannedTo) {
          const logs = await getLogsChunked(publicClient as never, {
            address: vault,
            events: [getAbiItem({ abi: passVaultAbi, name: "Claimed" })],
            fromBlock: scannedTo + 1n,
            toBlock: head,
          });
          const fresh = logs.map((l) => {
            const a = (l as unknown as { args: { passId: bigint; paid: bigint; cumulativeAmount: bigint } }).args;
            return { hash: l.transactionHash!, passId: a.passId, paid: a.paid, cumulative: a.cumulativeAmount, block: l.blockNumber! };
          });
          claims = [...fresh.reverse(), ...claims];
          scannedTo = head;
        }
        if (alive) setS({ passesOpened: Number(next) - 1, escrowed, settledVolume: settled, claims, loaded: true });
      } catch {
        if (alive) setS((p) => ({ ...p, loaded: true }));
      }
    };
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);
  return s;
}

/** Smoothly animates a number toward its target. */
export function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setV(a + (target - a) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
