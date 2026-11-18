import { createPublicClient, defineChain, http, type Address } from "viem";
import { aevumTestnet, type MeterPassDeployment } from "@meterpass/sdk";
import deploymentsJson from "@/generated/deployments.json";
import evidenceJson from "@/generated/evidence.json";
import metricsJson from "@/generated/metrics.json";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 44005);

const forkChain = defineChain({
  ...aevumTestnet,
  id: 440050,
  name: "Aevum fork (local)",
  rpcUrls: { default: { http: ["http://127.0.0.1:8555"] } },
});
export const chain = CHAIN_ID === 440050 ? forkChain : aevumTestnet;
export const RPC_URL = chain.rpcUrls.default.http[0];
export const EXPLORER = aevumTestnet.blockExplorers.default.url;

export const deployment = (deploymentsJson as Record<string, MeterPassDeployment>)[String(CHAIN_ID)] as
  | (MeterPassDeployment & { merchantAgentId?: number; merchant?: Address })
  | undefined;

export interface Evidence {
  label: string;
  hash: `0x${string}`;
  gasUsed?: string;
  at: string;
  note?: string;
}
export const evidence = ((evidenceJson as Record<string, Evidence[]>)[String(CHAIN_ID)] ?? []) as Evidence[];

export interface Metrics {
  baseline?: { n: number; totalGas: string; avgGas: string; seconds: number; firstHash: string; lastHash: string; gasPrice: string };
  batch?: { requests: number; gasUsed: string; hash: string; seconds?: number };
  runs?: { agent: string; pass: string; calls: number; paid: number; ms: number; at: string; note?: string }[];
  revokeLatency?: { callsAfterRevokeSent: number; secondsAfterReceipt?: number };
}
export const metrics = ((metricsJson as Record<string, Metrics>)[String(CHAIN_ID)] ?? {}) as Metrics;

/** Where the merchant API lives: a separately hosted merchant, or this app's own /api/merchant. */
export const MERCHANT_URL = process.env.NEXT_PUBLIC_MERCHANT_URL || "/api/merchant";
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/opxy16/meterpass";

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { batch: { wait: 10 } }) });

export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`;
export const short = (s: string, n = 4) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);
