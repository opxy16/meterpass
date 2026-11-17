import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ChainPassCache, MeterPassMerchant, settleBatch, formatTusd8, explorerTx } from "@meterpass/sdk";
import { createMerchantApp } from "./app";
import { FileVoucherStore } from "./fileStore";
import { Hub } from "./hub";
import { deployment, loadEnv, network, publicClient, repoRoot, requireEnv } from "@meterpass/node";

loadEnv(join(repoRoot, "apps", "merchant"));
const net = network();
const client = publicClient();
const chainId = await client.getChainId();
const dep = deployment(chainId);
if (!dep.merchantAgentId) throw new Error("merchant not registered: run `pnpm --filter @meterpass/merchant register`");

const account = privateKeyToAccount(requireEnv("MERCHANT_PRIVATE_KEY") as Hex);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.rpc) });
const port = Number(process.env.PORT ?? 8787);
const settleIntervalSeconds = Number(process.env.SETTLE_INTERVAL_SECONDS ?? 60);
if (settleIntervalSeconds >= dep.settlementWindow) {
  throw new Error(`SETTLE_INTERVAL_SECONDS (${settleIntervalSeconds}) must be shorter than the vault settlement window (${dep.settlementWindow}s)`);
}
const adminToken = process.env.MERCHANT_ADMIN_TOKEN ?? `dev-${randomBytes(8).toString("hex")}`;

const passes = new ChainPassCache(client, dep.passVault, Number(process.env.PASS_POLL_MS ?? 500));
const store = new FileVoucherStore(join(repoRoot, "apps", "merchant", "data", `vouchers-${chainId}.json`));
const hub = new Hub();
const merchant = new MeterPassMerchant({
  chainId,
  vault: dep.passVault,
  asset: dep.token,
  payTo: account.address,
  merchantAgentId: BigInt(dep.merchantAgentId),
  identityRegistry: dep.identityRegistry,
  settlementWindow: dep.settlementWindow,
  passes,
  store,
});

const settledRequests = new Map<string, number>();
let settling: Promise<Awaited<ReturnType<typeof settleBatch>>> | null = null;
async function settleNow() {
  if (settling) return settling;
  settling = (async () => {
    const vouchers = await merchant.claimable();
    if (vouchers.length === 0) return null;
    const result = await settleBatch({ publicClient: client, walletClient: wallet, vault: dep.passVault, vouchers });
    if (result) {
      for (const v of vouchers) await passes.refresh(v.passId);
      // requests covered by this one transaction = new requests since each pass's last settlement
      let requests = 0;
      for (const v of vouchers) {
        if (!result.paid.some((p) => p.passId === v.passId)) continue;
        requests += v.requests - (settledRequests.get(v.passId.toString()) ?? 0);
        settledRequests.set(v.passId.toString(), v.requests);
      }
      hub.emit({
        type: "settled",
        at: Date.now(),
        hash: result.hash,
        gasUsed: result.gasUsed.toString(),
        totalPaid: result.totalPaid.toString(),
        passes: result.paid.length,
        requests,
        blockNumber: result.blockNumber.toString(),
      });
      console.log(`settled ${formatTusd8(result.totalPaid, 3)} tUSD8 from ${result.paid.length} pass(es) in one tx, gas ${result.gasUsed}: ${explorerTx(result.hash)}`);
    }
    return result;
  })()
    .catch((e) => {
      hub.emit({ type: "settle_failed", at: Date.now(), error: String(e?.shortMessage ?? e?.message ?? e) });
      console.error("settlement failed:", e?.shortMessage ?? e);
      return null;
    })
    .finally(() => {
      settling = null;
    });
  return settling;
}

passes.onChange((p, event) => {
  hub.emit({ type: "pass", at: Date.now(), passId: p.passId.toString(), event, authorizer: p.authorizer, deposit: p.deposit.toString(), claimed: p.claimed.toString(), closed: p.closed });
  // A revoke, reassignment or close request starts the settlement clock: settle right away.
  if (event === "AuthorizerChanged" || event === "CloseRequested") void settleNow();
});
await passes.start();
if (settleIntervalSeconds > 0) setInterval(() => void settleNow(), settleIntervalSeconds * 1000).unref();

const app = createMerchantApp({
  merchant,
  client,
  passes,
  store,
  hub,
  settleNow,
  adminToken,
  info: {
    name: "Aevum Chain Intel (MeterPass demo merchant)",
    merchantAgentId: dep.merchantAgentId.toString(),
    identityRegistry: dep.identityRegistry,
    payTo: account.address,
    vault: dep.passVault,
    chainId,
    settlementWindow: dep.settlementWindow,
    settleIntervalSeconds,
  },
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`MeterPass merchant on http://localhost:${port}  (network ${net.name}, chain ${chainId})`);
  console.log(`  pays to ${account.address}, ERC-8004 agent #${dep.merchantAgentId}, vault ${dep.passVault}`);
  console.log(`  auto-settle every ${settleIntervalSeconds}s (window ${dep.settlementWindow}s); admin token for POST /admin/settle: ${adminToken}`);
});
