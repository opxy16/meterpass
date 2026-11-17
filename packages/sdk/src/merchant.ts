import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { recoverVoucherSigner, type VoucherContext } from "./voucher";
import {
  BATCH_SCHEME,
  X402_HEADERS,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  type BatchSettlementRequirements,
  type PaymentErrorCode,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SettlementResponse,
} from "./x402";

/** On-chain pass state the merchant needs (kept fresh by a poller, see PassCache). */
export interface PassSnapshot {
  passId: bigint;
  merchant: Address;
  merchantAgentId: bigint;
  authorizer: Address;
  owner: Address;
  deposit: bigint;
  claimed: bigint;
  expiry: number;
  closeRequestedAt: number;
  closed: boolean;
}

export interface PassSource {
  /** Must reflect revokes within about one block. */
  getPass(passId: bigint): Promise<PassSnapshot | null>;
}

/** The best voucher the merchant holds for a pass: what it will claim. */
export interface StoredVoucher {
  passId: bigint;
  cumulative: bigint;
  signature: Hex;
  signer: Address;
  requests: number;
  updatedAt: number;
}

export interface VoucherStore {
  get(passId: bigint): Promise<StoredVoucher | null>;
  put(v: StoredVoucher): Promise<void>;
  all(): Promise<StoredVoucher[]>;
}

export class MemoryVoucherStore implements VoucherStore {
  private m = new Map<string, StoredVoucher>();
  async get(passId: bigint) {
    return this.m.get(passId.toString()) ?? null;
  }
  async put(v: StoredVoucher) {
    this.m.set(v.passId.toString(), v);
  }
  async all() {
    return [...this.m.values()];
  }
}

export interface MerchantConfig {
  chainId: number;
  vault: Address;
  asset: Address;
  payTo: Address;
  merchantAgentId: bigint;
  identityRegistry: Address;
  settlementWindow: number;
  passes: PassSource;
  store: VoucherStore;
  /** Stop serving a pass this many seconds before expiry, so there is always time to settle. */
  expirySafetySeconds?: number;
  now?: () => number;
}

export type VerifyResult =
  | {
      ok: true;
      receipt: StoredVoucher;
      price: bigint;
      remaining: bigint;
      verifyMs: number;
      responseHeader: string;
    }
  | {
      ok: false;
      status: 400 | 402;
      error: PaymentErrorCode;
      message: string;
      paymentRequired: PaymentRequired;
      requiredHeader: string;
      verifyMs: number;
    };

/**
 * Merchant side of `batch-settlement`. Verifying a voucher is a signature recovery plus an
 * in-memory check against cached pass state: no RPC call and no gas per request.
 */
export class MeterPassMerchant {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private readonly cfg: MerchantConfig) {}

  get voucherContext(): VoucherContext {
    return { chainId: this.cfg.chainId, vault: this.cfg.vault };
  }

  requirements(price: bigint, passInfo?: { passId: bigint; acceptedCumulative: bigint }): BatchSettlementRequirements {
    return {
      scheme: BATCH_SCHEME,
      network: `eip155:${this.cfg.chainId}`,
      amount: price.toString(),
      asset: this.cfg.asset,
      payTo: this.cfg.payTo,
      maxTimeoutSeconds: 60,
      extra: {
        name: "MeterPass",
        version: "1",
        vault: this.cfg.vault,
        merchantAgentId: this.cfg.merchantAgentId.toString(),
        identityRegistry: this.cfg.identityRegistry,
        settlementWindow: this.cfg.settlementWindow,
        ...(passInfo && {
          passId: passInfo.passId.toString(),
          acceptedCumulative: passInfo.acceptedCumulative.toString(),
        }),
      },
    };
  }

  paymentRequired(resource: ResourceInfo, price: bigint, error?: PaymentErrorCode, passInfo?: { passId: bigint; acceptedCumulative: bigint }): PaymentRequired {
    return {
      x402Version: X402_VERSION,
      ...(error && { error }),
      resource,
      accepts: [this.requirements(price, passInfo)],
    };
  }

  /** Verify the PAYMENT-SIGNATURE header for a request costing `price`. Serialised per pass. */
  async verify(resource: ResourceInfo, price: bigint, signatureHeader: string | null): Promise<VerifyResult> {
    const started = performance.now();
    if (!signatureHeader) return this.fail(resource, price, 402, "payment_required", "send PAYMENT-SIGNATURE", started);

    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(signatureHeader);
      BigInt(payload.payload.passId);
      BigInt(payload.payload.cumulativeAmount);
    } catch {
      return this.fail(resource, price, 400, "invalid_payload", "PAYMENT-SIGNATURE is not valid base64 JSON", started);
    }
    const passId = BigInt(payload.payload.passId);
    const key = passId.toString();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.verifyLocked(resource, price, payload, started));
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }

  private async verifyLocked(
    resource: ResourceInfo,
    price: bigint,
    payload: PaymentPayload,
    started: number,
  ): Promise<VerifyResult> {
    const { accepted } = payload;
    const passId = BigInt(payload.payload.passId);
    const cumulative = BigInt(payload.payload.cumulativeAmount);
    const latest = await this.cfg.store.get(passId);
    const info = { passId, acceptedCumulative: latest?.cumulative ?? 0n };
    const fail = (status: 400 | 402, code: PaymentErrorCode, msg: string) =>
      this.fail(resource, price, status, code, msg, started, info);

    if (accepted?.scheme !== BATCH_SCHEME) return fail(400, "unsupported_scheme", "scheme must be batch-settlement");
    if (accepted.network !== `eip155:${this.cfg.chainId}`) return fail(400, "wrong_network", `network must be eip155:${this.cfg.chainId}`);
    if (!isAddressEqual(accepted.extra.vault, this.cfg.vault)) return fail(400, "wrong_vault", "voucher is for another vault");

    const pass = await this.cfg.passes.getPass(passId);
    if (!pass) return fail(402, "unknown_pass", `pass ${passId} does not exist`);
    if (!isAddressEqual(pass.merchant, this.cfg.payTo) || pass.merchantAgentId !== this.cfg.merchantAgentId) {
      return fail(402, "wrong_merchant", "this pass pays a different merchant");
    }
    if (pass.closed || pass.closeRequestedAt !== 0) return fail(402, "pass_closing", "pass is closed or closing");
    if (pass.authorizer === "0x0000000000000000000000000000000000000000") {
      return fail(402, "pass_revoked", "the owner revoked this pass's agent");
    }
    const now = this.cfg.now?.() ?? Math.floor(Date.now() / 1000);
    if (now + (this.cfg.expirySafetySeconds ?? 30) >= pass.expiry) return fail(402, "pass_expired", "pass expired");

    const floor = latest && latest.cumulative > pass.claimed ? latest.cumulative : pass.claimed;
    if (cumulative < floor + price) {
      return fail(402, cumulative <= floor ? "stale_cumulative" : "underpaid", `cumulative must be >= ${floor + price}`);
    }
    if (cumulative > pass.deposit) return fail(402, "insufficient_funds", "voucher exceeds the pass deposit; top up");

    let signer: Address;
    try {
      signer = await recoverVoucherSigner(this.voucherContext, { passId, cumulativeAmount: cumulative }, payload.payload.signature);
    } catch {
      return fail(400, "invalid_signature", "signature does not recover");
    }
    if (!isAddressEqual(signer, pass.authorizer)) return fail(402, "invalid_signature", "voucher not signed by the pass authorizer");

    const receipt: StoredVoucher = {
      passId,
      cumulative,
      signature: payload.payload.signature,
      signer: getAddress(signer),
      requests: (latest?.requests ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await this.cfg.store.put(receipt);
    const remaining = pass.deposit - cumulative;
    const response: SettlementResponse = {
      success: true,
      transaction: "",
      network: accepted.network,
      payer: getAddress(signer),
      extra: { settlement: "deferred", passId: passId.toString(), cumulativeAmount: cumulative.toString(), remaining: remaining.toString() },
    };
    return {
      ok: true,
      receipt,
      price,
      remaining,
      verifyMs: performance.now() - started,
      responseHeader: encodeHeader(response),
    };
  }

  private fail(
    resource: ResourceInfo,
    price: bigint,
    status: 400 | 402,
    error: PaymentErrorCode,
    message: string,
    started: number,
    passInfo?: { passId: bigint; acceptedCumulative: bigint },
  ): VerifyResult {
    const paymentRequired = this.paymentRequired(resource, price, error, passInfo);
    return {
      ok: false,
      status,
      error,
      message,
      paymentRequired,
      requiredHeader: encodeHeader(paymentRequired),
      verifyMs: performance.now() - started,
    };
  }

  /** Vouchers worth claiming now: newer than what the vault has already paid. */
  async claimable(): Promise<StoredVoucher[]> {
    const out: StoredVoucher[] = [];
    for (const v of await this.cfg.store.all()) {
      const pass = await this.cfg.passes.getPass(v.passId);
      if (pass && !pass.closed && v.cumulative > pass.claimed) out.push(v);
    }
    return out;
  }
}

export { X402_HEADERS };
