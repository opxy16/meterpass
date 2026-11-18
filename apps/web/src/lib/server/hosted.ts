import { Hono } from "hono";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MemoryVoucherStore,
  MeterPassMerchant,
  readPass,
  settleBatch,
  type PassSnapshot,
  type PassSource,
  type StoredVoucher,
  type VoucherStore,
} from "@meterpass/sdk";
import { createMerchantApp } from "@meterpass/merchant";
import { Hub } from "@meterpass/merchant/hub";
import { CHAIN_ID, chain, deployment, RPC_URL } from "@/lib/config";

/**
 * The demo merchant running inside the dashboard's serverless functions (Vercel).
 * Same code as apps/merchant; differences: pass state is read per request with a 1 s cache
 * (no background poller on serverless) and vouchers live in Upstash Redis when configured.
 */

class UpstashVoucherStore implements VoucherStore {
  constructor(private url: string, private token: string, private key = `meterpass:${CHAIN_ID}:vouchers`) {}
  private async cmd(...args: (string | number)[]) {
    const r = await fetch(this.url, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body: JSON.stringify(args), cache: "no-store" });
    const j = (await r.json()) as { result?: unknown; error?: string };
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  private decode(s: string): StoredVoucher {
    const v = JSON.parse(s);
    return { ...v, passId: BigInt(v.passId), cumulative: BigInt(v.cumulative) };
  }
  async get(passId: bigint) {
    const s = (await this.cmd("HGET", this.key, passId.toString())) as string | null;
    return s ? this.decode(s) : null;
  }
  async put(v: StoredVoucher) {
    await this.cmd("HSET", this.key, v.passId.toString(), JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  }
  async all() {
    const flat = ((await this.cmd("HGETALL", this.key)) as string[]) ?? [];
    const out: StoredVoucher[] = [];
    for (let i = 1; i < flat.length; i += 2) out.push(this.decode(flat[i]!));
    return out;
  }
}

class CachedRpcPasses implements PassSource {
  private cache = new Map<string, { at: number; v: PassSnapshot | null }>();
  constructor(private client: ReturnType<typeof createPublicClient>, private vault: `0x${string}`, private ttlMs = 1000) {}
  async getPass(passId: bigint) {
    const hit = this.cache.get(passId.toString());
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const v = await readPass(this.client as never, this.vault, passId);
    this.cache.set(passId.toString(), { at: Date.now(), v });
    return v;
  }
  forget(passId: bigint) {
    this.cache.delete(passId.toString());
  }
}

let built: ReturnType<typeof build> | null = null;
export function hosted() {
  return (built ??= build());
}

function build() {
  if (!deployment?.merchant || !deployment.merchantAgentId) throw new Error("MeterPass is not deployed / merchant not registered on this chain");
  const client = createPublicClient({ chain, transport: http(process.env.AEVUM_RPC ?? RPC_URL) });
  const passes = new CachedRpcPasses(client, deployment.passVault);
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const store: VoucherStore = url && token ? new UpstashVoucherStore(url, token) : new MemoryVoucherStore();
  const hub = new Hub();
  const merchant = new MeterPassMerchant({
    chainId: CHAIN_ID,
    vault: deployment.passVault,
    asset: deployment.token,
    payTo: deployment.merchant,
    merchantAgentId: BigInt(deployment.merchantAgentId),
    identityRegistry: deployment.identityRegistry,
    settlementWindow: deployment.settlementWindow,
    passes,
    store,
  });

  const key = process.env.MERCHANT_PRIVATE_KEY as Hex | undefined;
  const wallet = key ? createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(process.env.AEVUM_RPC ?? RPC_URL) }) : null;
  let settling: Promise<unknown> | null = null;
  async function settleNow() {
    if (!wallet) throw new Error("settlement is not configured on this deployment (MERCHANT_PRIVATE_KEY)");
    if (settling) return settling as never;
    settling = (async () => {
      const vouchers = await merchant.claimable();
      const result = await settleBatch({ publicClient: client as never, walletClient: wallet as never, vault: deployment!.passVault, vouchers });
      for (const v of vouchers) passes.forget(v.passId);
      if (result) {
        hub.emit({ type: "settled", at: Date.now(), hash: result.hash, gasUsed: result.gasUsed.toString(), totalPaid: result.totalPaid.toString(), passes: result.paid.length, requests: 0, blockNumber: result.blockNumber.toString() });
      }
      return result;
    })().finally(() => {
      settling = null;
    });
    return settling as never;
  }

  const inner = createMerchantApp({
    merchant,
    client: client as never,
    passes,
    store,
    hub,
    settleNow: settleNow as never,
    adminToken: process.env.MERCHANT_ADMIN_TOKEN,
    info: {
      name: "Aevum Chain Intel (hosted MeterPass merchant)",
      merchantAgentId: String(deployment.merchantAgentId),
      identityRegistry: deployment.identityRegistry,
      payTo: deployment.merchant,
      vault: deployment.passVault,
      chainId: CHAIN_ID,
      settlementWindow: deployment.settlementWindow,
      settleIntervalSeconds: 0,
    },
  });
  const app = new Hono().basePath("/api/merchant").route("/", inner);
  return { app, settleNow, merchant, client, wallet };
}

/** Tiny in-memory rate limiter (per serverless instance; a speed bump, not a wall). */
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return true;
  list.push(now);
  hits.set(key, list);
  return false;
}
export const clientIp = (req: Request) =>
  req.headers.get(process.env.TRUSTED_IP_HEADER ?? "x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "local";
