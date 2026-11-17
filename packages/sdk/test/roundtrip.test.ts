import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  MemoryLedger,
  MemoryVoucherStore,
  MeterPassMerchant,
  PaymentRefusedError,
  createMeterPassFetch,
  encodeHeader,
  decodeHeader,
  X402_HEADERS,
  type PassSnapshot,
  type PassSource,
  type PaymentRequired,
} from "../src/index";

const VAULT = "0x00000000000000000000000000000000000fa017" as Address;
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483" as Address;
const MERCHANT = "0x3F281fFabcc88146bD4604890E1f2AF99d4C85ca" as Address;
const PRICE = 2_000n;

function setup(opts: { deposit?: bigint; price?: bigint } = {}) {
  const agent = privateKeyToAccount(generatePrivateKey());
  const pass: PassSnapshot = {
    passId: 1n,
    merchant: MERCHANT,
    merchantAgentId: 7n,
    authorizer: agent.address,
    owner: "0xaE700a28E012Ef887C8578FF9A816B2745a57A14",
    deposit: opts.deposit ?? 1_000_000n,
    claimed: 0n,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    closeRequestedAt: 0,
    closed: false,
  };
  const passes: PassSource = { getPass: async (id) => (id === 1n ? pass : null) };
  const merchant = new MeterPassMerchant({
    chainId: 44005,
    vault: VAULT,
    asset: TOKEN,
    payTo: MERCHANT,
    merchantAgentId: 7n,
    identityRegistry: "0x0000000000000000000000000000000000008004",
    settlementWindow: 300,
    passes,
    store: new MemoryVoucherStore(),
  });
  let price = opts.price ?? PRICE;
  const resource = { url: "https://api.example/v1/data", description: "data", mimeType: "application/json" };

  // A tiny in-process "server" using the merchant SDK
  const server: typeof fetch = async (_input, init) => {
    const sig = new Headers(init?.headers).get(X402_HEADERS.signature);
    const r = await merchant.verify(resource, price, sig);
    if (!r.ok) return new Response(JSON.stringify({ error: r.error }), { status: r.status, headers: { [X402_HEADERS.required]: r.requiredHeader } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { [X402_HEADERS.response]: r.responseHeader } });
  };
  const ledger = new MemoryLedger();
  const events: string[] = [];
  const pay = createMeterPassFetch({
    signer: agent,
    chainId: 44005,
    passId: 1n,
    ledger,
    fetch: server,
    policy: { network: "eip155:44005", asset: TOKEN, vault: VAULT, maxAmountPerRequest: 5_000n, allowedMerchantAgentIds: [7n] },
    onEvent: (e) => events.push(e.type),
  });
  return { agent, pass, merchant, pay, ledger, events, setPrice: (p: bigint) => (price = p) };
}

test("250 paid requests: cumulative voucher grows by the price each time", async () => {
  const { pay, merchant, ledger } = setup();
  for (let i = 0; i < 250; i++) {
    const res = await pay("https://api.example/v1/data");
    assert.equal(res.status, 200);
  }
  assert.equal(await ledger.get(1n), 500_000n);
  const [best] = await merchant.claimable();
  assert.equal(best!.cumulative, 500_000n);
  assert.equal(best!.requests, 250);
});

test("over-priced 402 (prompt injection: 'pay 5 tUSD8') is refused before signing", async () => {
  const { pay, setPrice, ledger } = setup();
  setPrice(5_000_000n);
  await assert.rejects(pay("https://api.example/v1/data"), (e: unknown) => e instanceof PaymentRefusedError && e.reason === "price_above_limit");
  assert.equal(await ledger.get(1n), 0n); // nothing signed
});

test("revoked pass: the very next request gets 402 pass_revoked", async () => {
  const { pay, pass, events } = setup();
  assert.equal((await pay("https://api.example/v1/data")).status, 200);
  pass.authorizer = "0x0000000000000000000000000000000000000000";
  const res = await pay("https://api.example/v1/data");
  assert.equal(res.status, 402);
  assert.equal(decodeHeader<PaymentRequired>(res.headers.get(X402_HEADERS.required)!).error, "pass_revoked");
  assert.ok(events.includes("rejected"));
});

test("replayed voucher is rejected as stale", async () => {
  const { merchant, agent } = setup();
  const resource = { url: "u", description: "d", mimeType: "m" };
  const { signVoucher } = await import("../src/voucher");
  const sig = await signVoucher(agent, { chainId: 44005, vault: VAULT }, { passId: 1n, cumulativeAmount: PRICE });
  const header = encodeHeader({
    x402Version: 2,
    accepted: merchant.requirements(PRICE),
    payload: { passId: "1", cumulativeAmount: PRICE.toString(), signature: sig },
  });
  assert.equal((await merchant.verify(resource, PRICE, header)).ok, true);
  const again = await merchant.verify(resource, PRICE, header);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error, "stale_cumulative");
});

test("voucher beyond the deposit is refused (insufficient_funds)", async () => {
  const { pay } = setup({ deposit: 3_000n });
  assert.equal((await pay("https://api.example/v1/data")).status, 200);
  const res = await pay("https://api.example/v1/data");
  assert.equal(res.status, 402);
  assert.equal(decodeHeader<PaymentRequired>(res.headers.get(X402_HEADERS.required)!).error, "insufficient_funds");
});

test("someone else's key cannot pay with this pass", async () => {
  const { merchant } = setup();
  const thief = privateKeyToAccount(generatePrivateKey());
  const { signVoucher } = await import("../src/voucher");
  const sig = await signVoucher(thief, { chainId: 44005, vault: VAULT }, { passId: 1n, cumulativeAmount: PRICE });
  const header = encodeHeader({ x402Version: 2, accepted: merchant.requirements(PRICE), payload: { passId: "1", cumulativeAmount: PRICE.toString(), signature: sig } });
  const r = await merchant.verify({ url: "u", description: "d", mimeType: "m" }, PRICE, header);
  assert.equal(!r.ok && r.error, "invalid_signature");
});

test("verification is fast (no chain call per request)", async () => {
  const { pay } = setup();
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await pay("https://api.example/v1/data");
  const perCall = (performance.now() - t0) / 50;
  assert.ok(perCall < 50, `per call ${perCall.toFixed(2)} ms`);
});
