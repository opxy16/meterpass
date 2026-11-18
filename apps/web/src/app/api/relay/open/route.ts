import { createPublicClient, createWalletClient, http, isAddress, isHex, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openWithAuthorizationArgs, passVaultAbi, toUnits, type OpenRequest } from "@meterpass/sdk";
import { chain, deployment, RPC_URL } from "@/lib/config";
import { clientIp, rateLimited } from "@/lib/server/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Gasless pass opening for the playground. The relayer only ever calls
 * PassVault.openWithAuthorization for OUR merchant, small amounts and short expiries. It cannot change
 * the terms: they are bound into the owner's EIP-3009 signature nonce.
 */
const MAX_AMOUNT = toUnits(process.env.RELAY_MAX_AMOUNT ?? "0.5");
const MAX_EXPIRY_SECONDS = 2 * 24 * 3600;

export async function POST(req: Request) {
  const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key || !deployment?.merchantAgentId) return Response.json({ error: "relayer is not configured on this deployment" }, { status: 503 });
  if (rateLimited(`relay:${clientIp(req)}`, 5, 10 * 60_000)) return Response.json({ error: "too many passes from this address, try again in a few minutes" }, { status: 429 });

  let body: { req: Record<string, string>; validBefore: string; signature: Hex };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const r = body.req ?? {};
  if (!isAddress(r.owner ?? "") || !isAddress(r.authorizer ?? "") || !isHex(r.salt) || !isHex(body.signature)) {
    return Response.json({ error: "malformed request" }, { status: 400 });
  }
  const open: OpenRequest = {
    owner: r.owner as `0x${string}`,
    authorizer: r.authorizer as `0x${string}`,
    merchantAgentId: BigInt(r.merchantAgentId ?? "0"),
    amount: BigInt(r.amount ?? "0"),
    expiry: BigInt(r.expiry ?? "0"),
    salt: r.salt as Hex,
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validBefore = BigInt(body.validBefore ?? "0");
  if (open.merchantAgentId !== BigInt(deployment.merchantAgentId)) return Response.json({ error: "this relayer only opens passes for the demo merchant" }, { status: 400 });
  if (open.amount <= 0n || open.amount > MAX_AMOUNT) return Response.json({ error: `amount must be between 0 and ${MAX_AMOUNT} base units` }, { status: 400 });
  if (open.expiry <= now || open.expiry > now + BigInt(MAX_EXPIRY_SECONDS)) return Response.json({ error: "expiry must be within 2 days" }, { status: 400 });
  if (validBefore <= now || validBefore > now + 3600n) return Response.json({ error: "signature window must be at most 1 hour" }, { status: 400 });

  const account = privateKeyToAccount(key);
  const rpc = http(process.env.AEVUM_RPC ?? RPC_URL);
  const client = createPublicClient({ chain, transport: rpc });
  const wallet = createWalletClient({ account, chain, transport: rpc });
  const args = openWithAuthorizationArgs(open, 0n, validBefore, body.signature);
  try {
    await client.simulateContract({ address: deployment.passVault, abi: passVaultAbi, functionName: "openWithAuthorization", args, account });
    const hash = await wallet.writeContract({ address: deployment.passVault, abi: passVaultAbi, functionName: "openWithAuthorization", args, type: "legacy" });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: passVaultAbi, logs: receipt.logs, eventName: "PassOpened" });
    return Response.json({ hash, passId: ev?.args.passId.toString() });
  } catch (e) {
    const err = e as { shortMessage?: string; cause?: { data?: { errorName?: string } } };
    const name = err.cause?.data?.errorName;
    const msg = /insufficient funds|transfer amount exceeds balance/i.test(String(e))
      ? "your wallet doesn't have enough tUSD8 for this pass"
      : name ?? err.shortMessage ?? "could not open the pass";
    return Response.json({ error: msg }, { status: 400 });
  }
}
