import {
  decodeEventLog,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { passVaultAbi } from "./abi";
import type { StoredVoucher } from "./merchant";

export interface SettlementResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  totalPaid: bigint;
  paid: { passId: bigint; cumulative: bigint; amount: bigint }[];
  skipped: { passId: bigint; status: number }[];
  /** Requests covered by this one transaction. */
  requests: number;
}

/**
 * Settle many vouchers in ONE transaction with PassVault.claimBatch. Simulates first, sends a
 * legacy transaction (Aevum's default), waits for the receipt and reads what was paid / skipped.
 */
export async function settleBatch(params: {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  vault: Address;
  vouchers: StoredVoucher[];
  requestsByPass?: Map<string, number>;
}): Promise<SettlementResult | null> {
  const { publicClient, walletClient, vault, vouchers } = params;
  if (vouchers.length === 0) return null;
  const claims = vouchers.map((v) => ({ passId: v.passId, cumulativeAmount: v.cumulative, signature: v.signature }));
  await publicClient.simulateContract({
    address: vault,
    abi: passVaultAbi,
    functionName: "claimBatch",
    args: [claims],
    account: walletClient.account,
  });
  const hash = await walletClient.writeContract({
    address: vault,
    abi: passVaultAbi,
    functionName: "claimBatch",
    args: [claims],
    type: "legacy",
    chain: walletClient.chain,
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, retryCount: 10 });
  if (receipt.status !== "success") throw new Error(`claimBatch reverted in ${hash}`);

  const paid: SettlementResult["paid"] = [];
  const skipped: SettlementResult["skipped"] = [];
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: passVaultAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Claimed") {
        paid.push({ passId: ev.args.passId, cumulative: ev.args.cumulativeAmount, amount: ev.args.paid });
      } else if (ev.eventName === "ClaimSkipped") {
        skipped.push({ passId: ev.args.passId, status: Number(ev.args.status) });
      }
    } catch {
      // token Transfer logs etc.
    }
  }
  const requests = paid.reduce((n, p) => n + (params.requestsByPass?.get(p.passId.toString()) ?? 0), 0);
  return {
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    totalPaid: paid.reduce((s, p) => s + p.amount, 0n),
    paid,
    skipped,
    requests,
  };
}
