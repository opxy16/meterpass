import {
  http,
  parseEventLogs,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  createBundlerClient,
  entryPoint07Abi,
  entryPoint07Address,
  toPackedUserOperation,
  type SmartAccount,
  type UserOperation,
} from "viem/account-abstraction";
import { AEVUM } from "./chain";
import type { KernelCall } from "./kernel";

export interface UserOpResult {
  userOpHash: Hex;
  transactionHash: Hex;
  success: boolean;
  actualGasUsed: bigint;
  actualGasCost: bigint;
  via: "bundler" | "direct";
}

/** Fees the QDay bundler (a rundler fork) accepts: priority >= rundler_maxPriorityFeePerGas. */
export async function bundlerFees(publicClient: PublicClient, bundlerUrl: string = AEVUM.bundlerUrl) {
  let priority = 1_300_000_000n;
  try {
    const res = await fetch(bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rundler_maxPriorityFeePerGas", params: [] }),
    });
    const j = (await res.json()) as { result?: Hex };
    if (j.result) priority = (BigInt(j.result) * 12n) / 10n;
  } catch {
    // keep default
  }
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  return { maxPriorityFeePerGas: priority, maxFeePerGas: priority + base * 2n };
}

/** Send through the ERC-4337 bundler (bundler.qday.info). */
export async function sendViaBundler(params: {
  publicClient: PublicClient;
  account: SmartAccount;
  calls: KernelCall[];
  bundlerUrl?: string;
}): Promise<UserOpResult> {
  const bundlerUrl = params.bundlerUrl ?? AEVUM.bundlerUrl;
  const bundler = createBundlerClient({
    account: params.account,
    client: params.publicClient,
    transport: http(bundlerUrl),
    userOperation: { estimateFeesPerGas: () => bundlerFees(params.publicClient, bundlerUrl) },
  });
  const userOpHash = await bundler.sendUserOperation({
    calls: params.calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? "0x" })),
  });
  const r = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000, pollingInterval: 1_000 });
  return {
    userOpHash,
    transactionHash: r.receipt.transactionHash,
    success: r.success,
    actualGasUsed: r.actualGasUsed,
    actualGasCost: r.actualGasCost,
    via: "bundler",
  };
}

/**
 * Fallback / local mode: build and sign the user operation ourselves and call
 * EntryPoint.handleOps from an EOA. Same validation path, no bundler needed.
 */
export async function sendDirect(params: {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  account: SmartAccount;
  calls: KernelCall[];
}): Promise<UserOpResult> {
  const { publicClient, walletClient, account } = params;
  const [callData, factoryArgs, nonce, gasPrice] = await Promise.all([
    account.encodeCalls(params.calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? "0x" }))),
    account.getFactoryArgs(),
    account.getNonce(),
    publicClient.getGasPrice(),
  ]);
  const deploying = !!factoryArgs.factory;
  const userOp: UserOperation<"0.7"> = {
    sender: account.address,
    nonce,
    ...(deploying && { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData }),
    callData,
    callGasLimit: 600_000n,
    verificationGasLimit: deploying ? 1_500_000n : 400_000n,
    preVerificationGas: 80_000n,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
    signature: "0x",
  };
  userOp.signature = await account.signUserOperation(userOp);
  const packed = toPackedUserOperation(userOp);
  const hash = await walletClient.writeContract({
    address: entryPoint07Address,
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packed], walletClient.account.address],
    type: "legacy",
    gas: deploying ? 3_000_000n : 1_500_000n,
    chain: walletClient.chain,
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: entryPoint07Abi, logs: receipt.logs, eventName: "UserOperationEvent" });
  if (!ev) throw new Error(`handleOps produced no UserOperationEvent (${hash})`);
  return {
    userOpHash: ev.args.userOpHash,
    transactionHash: hash,
    success: ev.args.success,
    actualGasUsed: ev.args.actualGasUsed,
    actualGasCost: ev.args.actualGasCost,
    via: "direct",
  };
}
