// Registers the demo merchant as an ERC-8004 agent and records its agentId in deployments/<chainId>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, http, parseEventLogs, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentIdentityRegistryAbi, explorerTx } from "@meterpass/sdk";
import { deployment, loadEnv, network, publicClient, repoRoot, requireEnv } from "@meterpass/node";

loadEnv(join(repoRoot, "apps", "merchant"));
const net = network();
const client = publicClient();
const chainId = await client.getChainId();
const dep = deployment(chainId);
const account = privateKeyToAccount(requireEnv("MERCHANT_PRIVATE_KEY") as Hex);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.rpc) });
const publicUrl = process.env.MERCHANT_PUBLIC_URL ?? "http://localhost:8787";

// ERC-8004 registration file, stored inline as a data: URI so it lives on-chain with the agent.
const card = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Aevum Chain Intel",
  description: "Pay-per-request chain data for AI agents. Accepts x402 batch-settlement through MeterPass passes.",
  image: "",
  services: [
    { name: "web", endpoint: publicUrl },
    { name: "x402", endpoint: `${publicUrl}/.well-known/x402`, version: "2" },
  ],
  x402Support: true,
  active: true,
  registrations: [] as { agentId: number; agentRegistry: string }[],
  supportedTrust: ["reputation"],
};
const agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;

const hash = await wallet.writeContract({
  address: dep.identityRegistry,
  abi: agentIdentityRegistryAbi,
  functionName: "register",
  args: [agentURI, [{ metadataKey: "x402.scheme", metadataValue: toHex("batch-settlement") }]],
  type: "legacy",
});
const receipt = await client.waitForTransactionReceipt({ hash });
const [registered] = parseEventLogs({ abi: agentIdentityRegistryAbi, logs: receipt.logs, eventName: "Registered" });
if (!registered) throw new Error("no Registered event");
const agentId = Number(registered.args.agentId);

const file = join(repoRoot, "deployments", `${chainId}.json`);
const json = JSON.parse(readFileSync(file, "utf8"));
json.merchantAgentId = agentId;
json.merchant = account.address;
json.merchantRegisterTx = hash;
writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
console.log(`merchant ${account.address} registered as ERC-8004 agent #${agentId} (eip155:${chainId}:${dep.identityRegistry})`);
console.log(explorerTx(hash));
