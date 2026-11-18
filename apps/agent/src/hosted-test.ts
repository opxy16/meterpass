// End-to-end test of the dashboard's hosted path (relayer + hosted merchant + settle).
import { readFileSync } from "node:fs";
import { erc20Abi, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMeterPassFetch, openAuthorizationTypedData, toUnits, formatTusd8, type OpenRequest } from "@meterpass/sdk";
import { loadEnv, publicClient, repoRoot } from "@meterpass/node";
loadEnv();
const base = process.env.WEB_URL ?? "http://localhost:3000";
const dep = JSON.parse(readFileSync(`${repoRoot}/deployments/44005.json`, "utf8"));
const client = publicClient();
const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as Hex);
const agent = privateKeyToAccount(generatePrivateKey()); // like the playground's in-tab key
console.log("owner tUSD8:", formatTusd8(await client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] })));
const now = Math.floor(Date.now() / 1000);
const req: OpenRequest = { owner: owner.address, merchantAgentId: BigInt(dep.merchantAgentId), authorizer: agent.address, amount: toUnits("0.02"), expiry: BigInt(now + 3600), salt: keccak256(toHex(`hosted-test:${now}`)) };
const validBefore = BigInt(now + 1800);
const sig = await owner.signTypedData(openAuthorizationTypedData({ chainId: 44005, vault: dep.passVault, token: dep.token, req, validBefore }));
const r = await fetch(`${base}/api/relay/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ req: { ...req, merchantAgentId: req.merchantAgentId.toString(), amount: req.amount.toString(), expiry: req.expiry.toString() }, validBefore: validBefore.toString(), signature: sig }) });
const opened = (await r.json()) as { passId?: string; hash?: string; error?: string };
console.log("relay:", r.status, JSON.stringify(opened));
if (!opened.passId) process.exit(1);
const pay = createMeterPassFetch({ signer: agent, chainId: 44005, passId: BigInt(opened.passId), policy: { network: "eip155:44005", asset: dep.token, vault: dep.passVault, maxAmountPerRequest: toUnits("0.01"), allowedMerchantAgentIds: [BigInt(dep.merchantAgentId)] } });
let ok = 0;
for (let i = 0; i < Number(process.env.CALLS ?? 10); i++) if ((await pay(`${base}/api/merchant/v1/block/latest`)).ok) ok++;
console.log("paid calls via hosted merchant:", ok);
const s = await fetch(`${base}/api/merchant/settle`, { method: "POST" });
console.log("settle:", s.status, await s.text());
