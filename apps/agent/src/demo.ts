/**
 * MeterPass demo runner. Every scenario of the demo video, against Aevum testnet (or a local fork).
 *
 *   pnpm demo setup                 owner: ONE signature -> Kernel account + session key + budget
 *   pnpm demo open [--amount 1]     agent A (session key, via bundler) opens a pass
 *   pnpm demo run [--calls 250] [--agent A|B] [--revoke-after N]
 *   pnpm demo inject                over-priced 402 + prompt injection + forbidden transfer
 *   pnpm demo revoke                owner revokes the pass's agent
 *   pnpm demo reassign              owner hands the pass to agent B (verified handoff)
 *   pnpm demo settle                merchant settles every voucher in ONE transaction
 *   pnpm demo baseline [--n 250]    the same calls paid the per-call way (EIP-3009 transfer each)
 *   pnpm demo refund-open / refund  a short pass, then the owner's refund at expiry
 *   pnpm demo status
 */
import { join } from "node:path";
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AEVUM,
  PaymentRefusedError,
  createMeterPassFetch,
  explorerTx,
  formatTusd8,
  getKernelAddress,
  createAccountCall,
  importHandoff,
  kernelInitData,
  passVaultAbi,
  sendDirect,
  sendViaBundler,
  sessionValidatorAbi,
  toMeterPassKernelAccount,
  toUnits,
  type KernelCall,
  type UserOpResult,
} from "@meterpass/sdk";
import { deployment, loadEnv, network, publicClient, repoRoot, requireEnv } from "@meterpass/node";
import { StateFile } from "./state";

loadEnv(join(repoRoot, "apps", "agent"));
const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const net = network();
const client = publicClient() as PublicClient;
const chainId = await client.getChainId();
// `fund` runs before anything is deployed; every other command needs the deployment + merchant.
const dep = cmd === "fund" ? ({ token: AEVUM.tUSD8, merchantAgentId: 0 } as unknown as ReturnType<typeof deployment>) : deployment(chainId);
if (cmd !== "fund" && !dep.merchantAgentId) throw new Error("merchant not registered yet: pnpm --filter @meterpass/merchant register");
const merchantAgentId = BigInt(dep.merchantAgentId ?? 0);
const st = new StateFile(chainId);
const S = st.state;

const owner = privateKeyToAccount(requireEnv("OWNER_PRIVATE_KEY") as Hex);
const agents = {
  A: privateKeyToAccount(requireEnv("AGENT_A_PRIVATE_KEY") as Hex),
  B: privateKeyToAccount(requireEnv("AGENT_B_PRIVATE_KEY") as Hex),
};
const ownerWallet = createWalletClient({ account: owner, chain: net.chain, transport: http(net.rpc) });
const merchantUrl = process.env.MERCHANT_URL ?? "http://localhost:8787";
const submit = (process.env.SUBMIT ?? (net.name === "aevum" ? "bundler" : "direct")) as "bundler" | "direct";
const PRICE = 2_000n;

const log = (...a: unknown[]) => console.log(...a);
const tx = (hash: Hex) => (net.name === "aevum" ? explorerTx(hash) : hash);
const usd = (x: bigint) => `${formatTusd8(x, 3)} tUSD8`;

async function ownerTx(label: string, request: Parameters<typeof ownerWallet.writeContract>[0] | { to: Address; value: bigint }) {
  const hash = "abi" in request ? await ownerWallet.writeContract({ ...request, type: "legacy" } as never) : await ownerWallet.sendTransaction({ ...request, type: "legacy" });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  st.evidence({ label, hash, gasUsed: r.gasUsed.toString() });
  log(`  ✓ ${label}  gas ${r.gasUsed}  ${tx(hash)}`);
  return r;
}

async function kernel(mode: "root" | "session") {
  if (!S.initData) throw new Error("run `setup` first");
  return toMeterPassKernelAccount({
    client: client as never,
    signer: mode === "root" ? owner : agents.A,
    initData: S.initData,
    salt: S.salt,
    mode: mode === "root" ? "root" : { sessionValidator: dep.sessionValidator },
  });
}

async function userOp(label: string, mode: "root" | "session", calls: KernelCall[]): Promise<UserOpResult> {
  const account = await kernel(mode);
  const r =
    submit === "bundler"
      ? await sendViaBundler({ publicClient: client, account, calls })
      : await sendDirect({ publicClient: client, walletClient: ownerWallet, account, calls });
  if (!r.success) throw new Error(`${label}: user operation reverted (${r.transactionHash})`);
  st.evidence({ label, hash: r.transactionHash, gasUsed: r.actualGasUsed.toString(), note: `userOp ${r.userOpHash} via ${r.via}` });
  log(`  ✓ ${label}  (${mode} key, via ${r.via})  gas ${r.actualGasUsed}  ${tx(r.transactionHash)}`);
  return r;
}

async function readPass(passId: bigint) {
  return client.readContract({ address: dep.passVault, abi: passVaultAbi, functionName: "getPass", args: [passId] });
}

function payFetch(agent: "A" | "B", passId: bigint, onEvent?: Parameters<typeof createMeterPassFetch>[0]["onEvent"]) {
  return createMeterPassFetch({
    signer: agents[agent],
    chainId,
    passId,
    ledger: st.ledger(agent),
    policy: {
      network: `eip155:${chainId}`,
      asset: dep.token,
      vault: dep.passVault,
      maxAmountPerRequest: toUnits(process.env.AGENT_MAX_PRICE ?? "0.01"),
      allowedMerchantAgentIds: [merchantAgentId],
    },
    onEvent,
  });
}

const mainPass = () => {
  if (!S.mainPass) throw new Error("run `open` first");
  return BigInt(S.mainPass);
};

// ------------------------------------------------------------------------------------------------

const commands: Record<string, () => Promise<void>> = {
  /** Spread ONE faucet claim (1 tQDAY + 5 tUSD8 on DEPLOYER) across the demo's own test wallets. */
  async fund() {
    const deployer = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
    const dWallet = createWalletClient({ account: deployer, chain: net.chain, transport: http(net.rpc) });
    const merchantAddr = privateKeyToAccount(requireEnv("MERCHANT_PRIVATE_KEY") as Hex).address;
    const plan: { to: Address; tqday: string; tusd8: string; who: string }[] = [
      { to: owner.address, tqday: flag("owner-gas", "0.35")!, tusd8: flag("owner-usd", "4.5")!, who: "OWNER" },
      { to: merchantAddr, tqday: flag("merchant-gas", "0.25")!, tusd8: "0", who: "MERCHANT" },
    ];
    for (const p of plan) {
      const native = await client.getBalance({ address: p.to });
      const wantNative = parseEther(p.tqday);
      if (native < wantNative) {
        const hash = await dWallet.sendTransaction({ to: p.to, value: wantNative - native, type: "legacy" });
        await client.waitForTransactionReceipt({ hash });
        log(`  ✓ ${p.tqday} tQDAY -> ${p.who} ${tx(hash)}`);
      }
      const want = toUnits(p.tusd8);
      if (want > 0n) {
        const bal = await client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [p.to] });
        if (bal < want) {
          const hash = await dWallet.writeContract({ address: dep.token, abi: erc20Abi, functionName: "transfer", args: [p.to, want - bal], type: "legacy" });
          await client.waitForTransactionReceipt({ hash });
          log(`  ✓ ${usd(want - bal)} -> ${p.who} ${tx(hash)}`);
        }
      }
    }
  },

  async setup() {
    const budget = toUnits(flag("budget", "1.2")!);
    // Reuse the saved account: the address depends on every policy field, so rebuilding it would
    // point at a NEW counterfactual account. Pass --new to deliberately create another one.
    const reuse = !!(S.initData && S.account && S.validUntil && !args.includes("--new"));
    const validUntil = reuse ? S.validUntil! : Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    if (!reuse) S.salt = keccak256(toHex(`meterpass-demo:${owner.address}:${flag("salt", String(Date.now()))}`));
    S.validUntil = validUntil;
    S.initData = kernelInitData({
      owner: owner.address,
      session: {
        validator: dep.sessionValidator,
        sessionKey: agents.A.address,
        passOwner: owner.address,
        budget,
        validAfter: 0,
        validUntil,
        merchantAgentIds: [merchantAgentId],
      },
      // runs as the account inside the same deployment transaction
      initCalls: [{ to: dep.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [dep.passVault, budget] }) }],
    });
    S.account = await getKernelAddress(client, S.initData, S.salt);
    st.save();
    log(`Smart account (Kernel v3.1): ${S.account}`);
    log(`Session policy: agent A ${agents.A.address} may open passes owned by ${owner.address}, up to ${usd(budget)}, merchant #${merchantAgentId}, until ${new Date(validUntil * 1000).toISOString()}`);

    const [bal, native] = await Promise.all([
      client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [S.account] }),
      client.getBalance({ address: S.account }),
    ]);
    if (bal < budget) {
      await ownerTx("owner funds smart account with tUSD8", { address: dep.token, abi: erc20Abi, functionName: "transfer", args: [S.account, budget - bal] } as never);
    }
    const gasFloat = parseEther(flag("gas", "0.05")!);
    if (native < gasFloat / 2n) await ownerTx("owner funds smart account with tQDAY for gas", { to: S.account, value: gasFloat - native });

    if (await client.getCode({ address: S.account })) {
      log("  account already deployed; skipping");
      return;
    }
    log("Owner sends ONE transaction: create the account, install the agent's session key, approve PassVault for the budget");
    const create = createAccountCall(S.initData, S.salt);
    await ownerTx("owner: one tx creates smart account + session policy + budget approval", { to: create.to, data: create.data, value: 0n } as never);
    const allowance = await client.readContract({ address: dep.token, abi: erc20Abi, functionName: "allowance", args: [S.account, dep.passVault] });
    const active = await client.readContract({ address: dep.sessionValidator, abi: sessionValidatorAbi, functionName: "isInitialized", args: [S.account] });
    log(`  session module installed: ${active}, PassVault allowance: ${usd(allowance)}`);
  },

  /** Move funds out of smart accounts created by mistake (data/stray-account-*.json) back to the owner. */
  async "recover-strays"() {
    const { readdirSync, readFileSync, renameSync } = await import("node:fs");
    const dir = join(repoRoot, "apps", "agent", "data");
    for (const f of readdirSync(dir).filter((x) => x.startsWith(`stray-account-${chainId}`) && x.endsWith(".json") && !x.includes("recovered"))) {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as { account: Address; initData: Hex; salt: Hex };
      log(`stray account ${s.account}`);
      if (!(await client.getCode({ address: s.account }))) {
        const c = createAccountCall(s.initData, s.salt);
        await ownerTx("owner deploys stray account to recover its funds", { to: c.to, data: c.data, value: 0n } as never);
      }
      const bal = await client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [s.account] });
      const account = await toMeterPassKernelAccount({ client: client as never, signer: owner, initData: s.initData, salt: s.salt, mode: "root" });
      if (bal > 0n) {
        const r = await sendViaBundler({ publicClient: client, account, calls: [{ to: dep.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner.address, bal] }) }] });
        log(`  ✓ returned ${usd(bal)} to owner (root key, via ${r.via}) ${tx(r.transactionHash)}`);
      }
      renameSync(join(dir, f), join(dir, f.replace(".json", ".recovered.json")));
    }
  },

  async open() {
    const amount = toUnits(flag("amount", "1")!);
    const hours = Number(flag("hours", "48"));
    const expiry = BigInt(Math.floor(Date.now() / 1000) + hours * 3600);
    log(`Agent A opens a ${usd(amount)} pass for merchant #${merchantAgentId} (session key, no owner involvement)`);
    const r = await userOp("agent A opens pass via session key", "session", [
      {
        to: dep.passVault,
        data: encodeFunctionData({ abi: passVaultAbi, functionName: "open", args: [owner.address, merchantAgentId, agents.A.address, amount, expiry] }),
      },
    ]);
    const receipt = await client.getTransactionReceipt({ hash: r.transactionHash });
    const [opened] = parseEventLogs({ abi: passVaultAbi, logs: receipt.logs, eventName: "PassOpened" });
    S.mainPass = opened!.args.passId.toString();
    st.save();
    log(`  pass #${S.mainPass} opened, NFT owned by ${owner.address}`);
  },

  async run() {
    const agent = (flag("agent", "A") as "A" | "B");
    const passId = mainPass();
    const calls = Number(flag("calls", "250"));
    const path = flag("path", "/v1/block/latest")!;
    const revokeAfter = flag("revoke-after") ? Number(flag("revoke-after")) : undefined;
    let paid = 0;
    let failed = 0;
    const intervalMs = Number(flag("interval-ms", "0"));
    let revokedAt: number | undefined; // wall-clock ms of the block that included the revoke
    let paidAfterRevoke = 0;
    let revokeTx: Promise<unknown> | undefined;
    const signMs: number[] = [];
    const pay = payFetch(agent, passId, (e) => {
      if (e.type === "signed") signMs.push(e.ms);
    });
    const t0 = performance.now();
    log(`Agent ${agent} calls ${merchantUrl}${path} ${calls} times on pass #${passId} (price ${usd(PRICE)} each)`);
    // With --revoke-after, keep calling past --calls until the merchant refuses (that is the point).
    for (let i = 1; i <= calls || (revokeAfter !== undefined && i <= calls + 2000); i++) {
      if (intervalMs) await new Promise((r) => setTimeout(r, intervalMs));
      const res = await pay(`${merchantUrl}${path}`);
      if (res.ok) {
        paid++;
        if (revokedAt && Date.now() > revokedAt) paidAfterRevoke++;
        if (paid % 25 === 0) log(`  ${paid} paid  (cumulative ${usd(await st.ledger(agent).get(passId))})`);
      } else {
        failed++;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        let timing = "";
        if (revokeAfter) {
          await revokeTx;
          const after = revokedAt ? (Date.now() - revokedAt) / 1000 : undefined;
          timing = after !== undefined ? `  (${after.toFixed(1)}s after the block containing the revoke; ${paidAfterRevoke} call(s) accepted in between)` : "";
          if (body.error === "pass_revoked") st.metric("revokeLatency", { secondsAfterBlock: after, callsAcceptedAfterBlock: paidAfterRevoke, intervalMs });
        }
        log(`  ✗ call ${i}: HTTP ${res.status} ${body.error ?? ""}${timing}`);
        break;
      }
      if (revokeAfter && i === revokeAfter) {
        log(`  owner revokes pass #${passId} now (agent keeps calling)...`);
        revokeTx = ownerTx("owner revokes pass mid-run", { address: dep.passVault, abi: passVaultAbi, functionName: "revoke", args: [passId] } as never).then(async (r) => {
          const block = await client.getBlock({ blockNumber: r.blockNumber });
          revokedAt = Number(block.timestamp) * 1000;
        });
      }
    }
    await revokeTx;
    const ms = performance.now() - t0;
    const avgSign = signMs.reduce((a, b) => a + b, 0) / Math.max(1, signMs.length);
    log(`Done: ${paid} paid calls in ${(ms / 1000).toFixed(1)}s (${(ms / Math.max(1, paid)).toFixed(1)} ms per call incl. HTTP; voucher signing ${avgSign.toFixed(1)} ms). On-chain transactions so far: 0.`);
    S.runs.push({ agent, pass: passId.toString(), calls, paid, refusedOrRejected: failed, ms: Math.round(ms), at: new Date().toISOString(), note: revokeAfter ? `revoke after ${revokeAfter}` : undefined });
    st.save();
  },

  async inject() {
    const current = (await readPass(mainPass())).authorizer;
    const who = current.toLowerCase() === agents.B.address.toLowerCase() ? "B" : "A";
    const pay = payFetch(who, mainPass());
    log("1) Merchant quotes 5 tUSD8 for one call (agent limit 0.01):");
    try {
      await pay(`${merchantUrl}/v1/premium`);
      log("  !! paid (should not happen)");
    } catch (e) {
      if (e instanceof PaymentRefusedError) log(`  ✓ refused before signing anything: ${e.reason} (${e.message})`);
      else throw e;
    }
    log("2) A paid page contains a prompt injection:");
    const res = await pay(`${merchantUrl}/v1/news`);
    const body = (await res.json()) as { data?: { headlines: string[] }; error?: string };
    if (!res.ok) log(`     (merchant answered ${res.status} ${body.error}; run this before revoking)`);
    for (const h of body.data?.headlines ?? []) log(`     "${h}"`);
    log("  ✓ the agent's only payment tool is a voucher for THIS pass + merchant at a capped price; it has no send-money tool.");
    log("3) Even if a compromised agent tried a raw transfer with its session key:");
    try {
      const account = await kernel("session");
      const calls = [{ to: dep.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", toUnits("5")] }) }];
      // Check the policy without spending gas: the module's own dry-run, then the bundler.
      const callData = await account.encodeCalls(calls.map((c) => ({ to: c.to, data: c.data, value: 0n })));
      await client.readContract({ address: dep.sessionValidator, abi: sessionValidatorAbi, functionName: "checkCallData", args: [account.address, callData] });
      log("  !! policy allowed it (should not happen)");
    } catch (e) {
      const cause = (e as { cause?: { data?: { errorName?: string; args?: readonly unknown[] } } }).cause;
      const name = cause?.data?.errorName;
      const msg = name ? `${name}(${(cause?.data?.args ?? []).join(", ")})` : String((e as { shortMessage?: string }).shortMessage ?? e).split("\n")[0];
      log(`  ✓ blocked by the on-chain session policy: ${msg}`);
    }
  },

  async revoke() {
    await ownerTx("owner revokes pass", { address: dep.passVault, abi: passVaultAbi, functionName: "revoke", args: [mainPass()] } as never);
  },

  async reassign() {
    const passId = mainPass();
    const from = st.ledger("A").last(passId);
    log(`Owner hands pass #${passId} to agent B ${agents.B.address}`);
    await ownerTx("owner reassigns pass to agent B", { address: dep.passVault, abi: passVaultAbi, functionName: "setAuthorizer", args: [passId, agents.B.address] } as never);
    if (from) {
      await importHandoff(st.ledger("B"), { chainId, vault: dep.passVault }, { passId, cumulativeAmount: from.cumulative, signature: from.signature, expectedSigner: agents.A.address });
      log(`  ✓ agent B verified agent A's last voucher (${usd(from.cumulative)}) and continues from there`);
    }
  },

  async settle() {
    const token = requireEnv("MERCHANT_ADMIN_TOKEN");
    const res = await fetch(`${merchantUrl}/admin/settle`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const j = (await res.json()) as { hash?: Hex; gasUsed?: string; totalPaid?: string; nothingToSettle?: boolean };
    if (j.nothingToSettle) return log("nothing to settle");
    log(`Merchant settled ${usd(BigInt(j.totalPaid ?? 0))} in ONE transaction, gas ${j.gasUsed}: ${j.hash && tx(j.hash)}`);
    if (j.hash) st.evidence({ label: "merchant settles all vouchers in one claimBatch", hash: j.hash, gasUsed: j.gasUsed });
    // --requests N: this settlement covered N paid calls (the headline comparison uses it)
    if (j.hash && flag("requests")) st.metric("batch", { requests: Number(flag("requests")), gasUsed: j.gasUsed, hash: j.hash, totalPaid: j.totalPaid });
  },

  async baseline() {
    // The per-call way x402 `exact` works: the payer signs an EIP-3009 transfer for EVERY request and
    // a facilitator submits each one. Here the merchant submits, so it pays the gas, as a facilitator would.
    const n = Number(flag("n", "250"));
    const merchant = privateKeyToAccount(requireEnv("MERCHANT_PRIVATE_KEY") as Hex);
    const mWallet = createWalletClient({ account: merchant, chain: net.chain, transport: http(net.rpc) });
    const gasPrice = await client.getGasPrice();
    const abi3009 = [{ type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] }] as const;
    let nonce = await client.getTransactionCount({ address: merchant.address, blockTag: "pending" });
    const hashes: Hex[] = [];
    const t0 = performance.now();
    log(`Baseline: ${n} requests paid one transaction each (EIP-3009 transferWithAuthorization of ${usd(PRICE)})`);
    for (let i = 0; i < n; i += 25) {
      const batch: Promise<Hex>[] = [];
      for (let j = i; j < Math.min(n, i + 25); j++) {
        const authNonce = keccak256(toHex(`baseline:${Date.now()}:${j}`));
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const sig = await owner.signTypedData({
          domain: { name: "tUSD8", version: "2", chainId, verifyingContract: dep.token },
          types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
          primaryType: "TransferWithAuthorization",
          message: { from: owner.address, to: merchant.address, value: PRICE, validAfter: 0n, validBefore, nonce: authNonce },
        });
        const r = `0x${sig.slice(2, 66)}` as Hex;
        const s = `0x${sig.slice(66, 130)}` as Hex;
        const v = parseInt(sig.slice(130, 132), 16);
        batch.push(mWallet.writeContract({ address: dep.token, abi: abi3009, functionName: "transferWithAuthorization", args: [owner.address, merchant.address, PRICE, 0n, validBefore, authNonce, v, r, s], type: "legacy", gas: 120_000n, gasPrice, nonce: nonce++ }));
      }
      hashes.push(...(await Promise.all(batch)));
      log(`  sent ${hashes.length}/${n}`);
    }
    let totalGas = 0n;
    for (const h of hashes) totalGas += (await client.waitForTransactionReceipt({ hash: h })).gasUsed;
    const seconds = (performance.now() - t0) / 1000;
    S.baseline = { n, totalGas: totalGas.toString(), avgGas: (totalGas / BigInt(n)).toString(), seconds: Math.round(seconds), firstHash: hashes[0]!, lastHash: hashes.at(-1)!, gasPrice: gasPrice.toString() };
    st.save();
    st.metric("baseline", S.baseline);
    st.evidence({ label: `baseline: first of ${n} per-call transfers`, hash: hashes[0]! });
    st.evidence({ label: `baseline: last of ${n} per-call transfers`, hash: hashes.at(-1)!, note: `total gas ${totalGas}` });
    log(`Baseline: ${n} transactions, ${totalGas} gas in total (${totalGas / BigInt(n)} each), ${formatEther(totalGas * gasPrice)} tQDAY, ${seconds.toFixed(0)}s`);
  },

  async "refund-open"() {
    const seconds = Number(flag("seconds", "120"));
    const expiry = BigInt(Math.floor(Date.now() / 1000) + seconds);
    const r = await userOp("agent A opens a short pass (refund demo)", "session", [
      { to: dep.passVault, data: encodeFunctionData({ abi: passVaultAbi, functionName: "open", args: [owner.address, merchantAgentId, agents.A.address, toUnits(flag("amount", "0.05")!), expiry] }) },
    ]);
    const receipt = await client.getTransactionReceipt({ hash: r.transactionHash });
    const [opened] = parseEventLogs({ abi: passVaultAbi, logs: receipt.logs, eventName: "PassOpened" });
    S.refundPass = opened!.args.passId.toString();
    st.save();
    const at = await client.readContract({ address: dep.passVault, abi: passVaultAbi, functionName: "refundableAt", args: [opened!.args.passId] });
    log(`  pass #${S.refundPass} expires in ${seconds}s; refund opens at ${new Date(Number(at) * 1000).toLocaleTimeString()} (expiry + ${dep.settlementWindow}s settlement window)`);
  },

  async refund() {
    if (!S.refundPass) throw new Error("run `refund-open` first");
    const passId = BigInt(S.refundPass);
    const at = Number(await client.readContract({ address: dep.passVault, abi: passVaultAbi, functionName: "refundableAt", args: [passId] }));
    const wait = at - Number((await client.getBlock()).timestamp);
    if (wait > 0) {
      log(`  waiting ${wait}s for the settlement window to pass...`);
      await new Promise((r) => setTimeout(r, (wait + 3) * 1000));
    }
    const p = await readPass(passId);
    log(`Owner refunds pass #${passId}: ${usd(p.deposit - p.claimed)} unused`);
    await ownerTx("owner refund at expiry", { address: dep.passVault, abi: passVaultAbi, functionName: "refund", args: [passId] } as never);
  },

  async status() {
    log(`network ${net.name} (chain ${chainId}), submit mode ${submit}`);
    log(`vault ${dep.passVault}, merchant agent #${merchantAgentId}`);
    if (S.account) {
      const [bal, native, rem] = await Promise.all([
        client.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [S.account] }),
        client.getBalance({ address: S.account }),
        client.readContract({ address: dep.sessionValidator, abi: sessionValidatorAbi, functionName: "remainingBudget", args: [S.account] }),
      ]);
      log(`smart account ${S.account}: ${usd(bal)}, ${formatEther(native)} tQDAY, session budget left ${usd(rem)}`);
    }
    for (const id of [S.mainPass, S.refundPass].filter(Boolean) as string[]) {
      const p = await readPass(BigInt(id));
      log(`pass #${id}: deposit ${usd(p.deposit)}, settled ${usd(p.claimed)}, authorizer ${p.authorizer}, closed ${p.closed}`);
      for (const a of ["A", "B"]) {
        const l = st.ledger(a).last(BigInt(id));
        if (l) log(`   agent ${a} last voucher: ${usd(l.cumulative)}`);
      }
    }
  },
};

const fn = commands[cmd];
if (!fn) {
  console.error(`unknown command ${cmd}. Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
await fn();
