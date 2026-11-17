import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { recoverVoucherSigner, signVoucher, type TypedDataSigner, type VoucherContext } from "./voucher";
import {
  BATCH_SCHEME,
  X402_HEADERS,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  isBatchRequirements,
  type BatchSettlementRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "./x402";

/**
 * The agent's spending rules. They are checked BEFORE anything is signed, and they do not depend
 * on anything the server or a web page says. This is the agent-side half of prompt-injection
 * resistance (the on-chain half is the session key + the pass deposit cap).
 */
export interface PayerPolicy {
  network: string;
  asset: Address;
  vault: Address;
  /** Highest price the agent accepts for ONE request (base units). */
  maxAmountPerRequest: bigint;
  /** Merchants (ERC-8004 agent ids) this agent may pay. */
  allowedMerchantAgentIds: bigint[];
  /** Optional: payout addresses this agent may pay. */
  allowedPayTo?: Address[];
  /** Optional: stop after this much in total on this pass, even if the deposit is larger. */
  maxTotal?: bigint;
}

/** Where the agent remembers the last voucher it signed per pass (its high-water mark). */
export interface VoucherLedger {
  get(passId: bigint): Promise<bigint>;
  set(passId: bigint, cumulative: bigint, signature: Hex): Promise<void>;
}

export class MemoryLedger implements VoucherLedger {
  private m = new Map<string, { cumulative: bigint; signature: Hex }>();
  async get(passId: bigint) {
    return this.m.get(passId.toString())?.cumulative ?? 0n;
  }
  async set(passId: bigint, cumulative: bigint, signature: Hex) {
    this.m.set(passId.toString(), { cumulative, signature });
  }
  last(passId: bigint) {
    return this.m.get(passId.toString());
  }
}

export class PaymentRefusedError extends Error {
  constructor(
    public readonly reason:
      | "no_supported_requirement"
      | "price_above_limit"
      | "merchant_not_allowed"
      | "payto_not_allowed"
      | "wrong_vault"
      | "total_above_limit"
      | "server_rejected",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

export type PaymentEvent =
  | { type: "quote"; url: string; requirements: BatchSettlementRequirements }
  | { type: "refused"; url: string; error: PaymentRefusedError }
  | { type: "signed"; url: string; passId: bigint; cumulative: bigint; ms: number }
  | { type: "paid"; url: string; passId: bigint; cumulative: bigint; response?: SettlementResponse }
  | { type: "rejected"; url: string; status: number; reason?: string };

export interface MeterPassFetchOptions {
  signer: TypedDataSigner;
  chainId: number;
  passId: bigint;
  policy: PayerPolicy;
  ledger?: VoucherLedger;
  fetch?: typeof fetch;
  onEvent?: (e: PaymentEvent) => void;
}

/** Decide whether a 402 quote is acceptable under the policy. Throws PaymentRefusedError if not. */
export function selectRequirement(paymentRequired: PaymentRequired, policy: PayerPolicy): BatchSettlementRequirements {
  const candidates = (paymentRequired.accepts ?? []).filter(
    (r) => isBatchRequirements(r) && r.network === policy.network && isAddressEqual(r.asset, policy.asset),
  );
  if (candidates.length === 0) {
    throw new PaymentRefusedError("no_supported_requirement", "server offers no batch-settlement option on this network/asset");
  }
  const r = candidates[0]!;
  if (!isAddressEqual(r.extra.vault, policy.vault)) {
    throw new PaymentRefusedError("wrong_vault", `server asks for vault ${r.extra.vault}, policy allows ${policy.vault}`);
  }
  const price = BigInt(r.amount);
  if (price > policy.maxAmountPerRequest) {
    throw new PaymentRefusedError(
      "price_above_limit",
      `quoted ${price} > limit ${policy.maxAmountPerRequest} per request`,
      { quoted: price, limit: policy.maxAmountPerRequest },
    );
  }
  if (!policy.allowedMerchantAgentIds.includes(BigInt(r.extra.merchantAgentId))) {
    throw new PaymentRefusedError("merchant_not_allowed", `merchant agent ${r.extra.merchantAgentId} is not on the allowlist`);
  }
  if (policy.allowedPayTo && !policy.allowedPayTo.some((a) => isAddressEqual(a, r.payTo))) {
    throw new PaymentRefusedError("payto_not_allowed", `payTo ${r.payTo} is not on the allowlist`);
  }
  return r;
}

/**
 * Wraps fetch: on HTTP 402 with a `batch-settlement` offer it checks the policy, signs the next
 * cumulative voucher (no gas, ~1 ms) and retries once with PAYMENT-SIGNATURE.
 */
export function createMeterPassFetch(opts: MeterPassFetchOptions) {
  const doFetch = opts.fetch ?? fetch;
  const ledger = opts.ledger ?? new MemoryLedger();
  const ctx: VoucherContext = { chainId: opts.chainId, vault: opts.policy.vault };
  let queue: Promise<unknown> = Promise.resolve(); // vouchers are sequential per pass

  // Prices already seen per endpoint: later calls pay on the FIRST request (one round trip).
  const known = new Map<string, { requirement: BatchSettlementRequirements; resource: PaymentRequired["resource"] }>();
  const keyOf = (url: string) => {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  };
  const enqueue = (fn: () => Promise<Response>) => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => undefined);
    return result;
  };

  return async function meterPassFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input.toString();
    const key = keyOf(url);
    let first: Response;
    const cached = known.get(key);
    if (cached) {
      const paid = await enqueue(() => payOnce(url, init, cached.requirement, cached.resource, true));
      if (paid.status !== 402) return paid;
      known.delete(key); // price or pass state changed: take the fresh quote below
      first = paid;
    } else {
      first = await doFetch(url, withHeaders(init, { "X-MeterPass-Pass": opts.passId.toString() }));
      if (first.status !== 402) return first;
    }

    const header = first.headers.get(X402_HEADERS.required);
    const paymentRequired: PaymentRequired = header ? decodeHeader(header) : await first.clone().json();
    let requirement: BatchSettlementRequirements;
    try {
      requirement = selectRequirement(paymentRequired, opts.policy);
    } catch (e) {
      if (e instanceof PaymentRefusedError) opts.onEvent?.({ type: "refused", url, error: e });
      throw e;
    }
    opts.onEvent?.({ type: "quote", url, requirements: requirement });
    const paid = await enqueue(() => payOnce(url, init, requirement, paymentRequired.resource, false));
    if (paid.ok) known.set(key, { requirement, resource: paymentRequired.resource });
    return paid;
  };

  async function payOnce(
    url: string,
    init: RequestInit | undefined,
    requirement: BatchSettlementRequirements,
    resource: PaymentRequired["resource"],
    optimistic: boolean,
  ): Promise<Response> {
    {
      const started = performance.now();
      const last = await ledger.get(opts.passId);
      const next = last + BigInt(requirement.amount);
      if (opts.policy.maxTotal !== undefined && next > opts.policy.maxTotal) {
        const err = new PaymentRefusedError("total_above_limit", `would reach ${next} > maxTotal ${opts.policy.maxTotal}`);
        opts.onEvent?.({ type: "refused", url, error: err });
        throw err;
      }
      const signature = await signVoucher(opts.signer, ctx, { passId: opts.passId, cumulativeAmount: next });
      opts.onEvent?.({ type: "signed", url, passId: opts.passId, cumulative: next, ms: performance.now() - started });

      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        resource,
        accepted: requirement,
        payload: { passId: opts.passId.toString(), cumulativeAmount: next.toString(), signature },
      };
      const paid = await doFetch(
        url,
        withHeaders(init, { [X402_HEADERS.signature]: encodeHeader(payload), "X-MeterPass-Pass": opts.passId.toString() }),
      );
      const respHeader = paid.headers.get(X402_HEADERS.response);
      const response = respHeader ? decodeHeader<SettlementResponse>(respHeader) : undefined;
      if (paid.ok && response?.success !== false) {
        await ledger.set(opts.passId, next, signature);
        opts.onEvent?.({ type: "paid", url, passId: opts.passId, cumulative: next, response });
      } else if (!optimistic || paid.status !== 402) {
        let reason: string | undefined = response?.errorReason;
        if (!reason && paid.status === 402) {
          const h = paid.headers.get(X402_HEADERS.required);
          if (h) reason = decodeHeader<PaymentRequired>(h).error;
        }
        opts.onEvent?.({ type: "rejected", url, status: paid.status, reason });
      }
      return paid;
    }
  }
}

/**
 * Pass reassignment: the new agent starts from the previous agent's last voucher, verified
 * (signature + signer) instead of trusting a number the server reports.
 */
export async function importHandoff(
  ledger: VoucherLedger,
  ctx: VoucherContext,
  handoff: { passId: bigint; cumulativeAmount: bigint; signature: Hex; expectedSigner: Address },
): Promise<void> {
  const signer = await recoverVoucherSigner(ctx, handoff, handoff.signature);
  if (!isAddressEqual(signer, getAddress(handoff.expectedSigner))) {
    throw new Error(`handoff voucher signed by ${signer}, expected ${handoff.expectedSigner}`);
  }
  if ((await ledger.get(handoff.passId)) < handoff.cumulativeAmount) {
    await ledger.set(handoff.passId, handoff.cumulativeAmount, handoff.signature);
  }
}

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return { ...init, headers };
}

export { BATCH_SCHEME };
