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

/** Live merchant feed: SSE /events, plus /stats polling. Works with any MeterPass merchant URL. */
export function useMerchantFeed(base: string = MERCHANT_URL) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [stats, setStats] = useState<MerchantStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [rate, setRate] = useState(0);
  const stamps = useRef<number[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let alive = true;
    const push = (e: FeedEvent) => {
      if (e.type === "paid") stamps.current.push(Date.now());
      setEvents((prev) => [e, ...prev].slice(0, 120));
    };
    try {
      es = new EventSource(`${base}/events`);
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      for (const t of ["paid", "rejected", "settled", "settle_failed", "pass"]) {
        es.addEventListener(t, (m) => push(JSON.parse((m as MessageEvent).data)));
      }
    } catch {
      setConnected(false);
    }
    const poll = async () => {
      try {
        const r = await fetch(`${base}/stats`, { cache: "no-store" });
        if (r.ok && alive) setStats(await r.json());
      } catch {
        /* merchant offline */
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

  return { events, stats, connected, rate };
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
        const logs = await getLogsChunked(publicClient as never, {
          address: vault,
          events: [getAbiItem({ abi: passVaultAbi, name: "Claimed" })],
          fromBlock: BigInt(deployment!.startBlock),
        });
        const claims = logs.map((l) => {
          const a = (l as unknown as { args: { passId: bigint; paid: bigint; cumulativeAmount: bigint } }).args;
          return { hash: l.transactionHash!, passId: a.passId, paid: a.paid, cumulative: a.cumulativeAmount, block: l.blockNumber! };
        });
        if (alive) setS({ passesOpened: Number(next) - 1, escrowed, settledVolume: settled, claims: claims.reverse(), loaded: true });
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
