import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http, type Chain } from "viem";
import { aevumTestnet, type MeterPassDeployment } from "@meterpass/sdk";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Loads .env.wallets (test keys, git-ignored) and an optional app .env. Never logs values. */
export function loadEnv(appDir?: string) {
  for (const file of [join(repoRoot, ".env.wallets"), join(repoRoot, ".env.local"), appDir && join(appDir, ".env")]) {
    if (file && existsSync(file)) process.loadEnvFile(file);
  }
}

export const NETWORKS = {
  aevum: { rpc: "https://rpc-test.qday.info", chain: aevumTestnet },
  fork: {
    rpc: "http://127.0.0.1:8555",
    chain: defineChain({ ...aevumTestnet, id: 440050, name: "Aevum fork (local)", rpcUrls: { default: { http: ["http://127.0.0.1:8555"] } } }),
  },
  local: {
    rpc: "http://127.0.0.1:8545",
    chain: defineChain({ ...aevumTestnet, id: 31337, name: "Anvil", rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } }),
  },
} as const satisfies Record<string, { rpc: string; chain: Chain }>;

export type NetworkName = keyof typeof NETWORKS;

export function network(): { name: NetworkName; rpc: string; chain: Chain } {
  const name = (process.env.METERPASS_NETWORK ?? "aevum") as NetworkName;
  if (!(name in NETWORKS)) throw new Error(`METERPASS_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
  const n = NETWORKS[name];
  return { name, chain: n.chain, rpc: name === "aevum" ? (process.env.AEVUM_RPC ?? n.rpc) : n.rpc };
}

export function publicClient() {
  const n = network();
  return createPublicClient({ chain: n.chain, transport: http(n.rpc, { batch: { wait: 5 } }) });
}

export function deployment(chainId: number): MeterPassDeployment {
  const file = join(repoRoot, "deployments", `${chainId}.json`);
  if (!existsSync(file)) throw new Error(`no deployment for chain ${chainId}: run the deploy script first (${file})`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} (run \`pnpm wallets\` and check .env.wallets)`);
  return v;
}
