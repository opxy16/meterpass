import type { Address, Hex } from "viem";

/**
 * x402 v2 HTTP transport, with a new scheme: `batch-settlement`.
 *
 * `exact` (the usual x402 scheme) settles every request on-chain. `batch-settlement` pays each
 * request with an off-chain cumulative voucher against a prepaid MeterPass; the merchant settles
 * many requests later in one `PassVault.claimBatch` transaction. Same headers, same 402 flow:
 *
 *   client ── GET /resource ───────────────────────────────▶ server
 *   client ◀── 402 + PAYMENT-REQUIRED (accepts: batch-settlement) ── server
 *   client ── GET /resource + PAYMENT-SIGNATURE (voucher) ──▶ server   (verify ≈ 1 ms, no chain call)
 *   client ◀── 200 + PAYMENT-RESPONSE (settlement: deferred) ─ server
 */
export const X402_VERSION = 2 as const;
export const BATCH_SCHEME = "batch-settlement" as const;

export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

/** One entry of `accepts`: what the server wants for this resource. */
export interface BatchSettlementRequirements {
  scheme: typeof BATCH_SCHEME;
  /** CAIP-2, e.g. "eip155:44005". */
  network: string;
  /** Price of this request in token base units (tUSD8: 6 decimals). */
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    name: "MeterPass";
    version: "1";
    vault: Address;
    /** ERC-8004 agent id of the merchant; a pass must be opened for this id. */
    merchantAgentId: string;
    identityRegistry: Address;
    /** Seconds the merchant has to settle after expiry / revoke; refunds wait this long. */
    settlementWindow: number;
    /** When the client already sent a pass id: the highest cumulative the server has accepted. */
    passId?: string;
    acceptedCumulative?: string;
  };
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: PaymentErrorCode | string;
  resource: ResourceInfo;
  accepts: BatchSettlementRequirements[];
}

export interface BatchSettlementPayload {
  passId: string;
  cumulativeAmount: string;
  signature: Hex;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: BatchSettlementRequirements;
  payload: BatchSettlementPayload;
}

export interface SettlementResponse {
  success: boolean;
  /** Empty for batch settlement: the claim happens later. */
  transaction: string;
  network: string;
  payer: Address | "";
  errorReason?: PaymentErrorCode;
  extra?: {
    settlement: "deferred";
    passId: string;
    cumulativeAmount: string;
    remaining: string;
  };
}

/** Machine-readable reasons a payment was refused. */
export type PaymentErrorCode =
  | "payment_required"
  | "invalid_payload"
  | "unsupported_scheme"
  | "wrong_network"
  | "wrong_vault"
  | "unknown_pass"
  | "wrong_merchant"
  | "pass_revoked"
  | "pass_closing"
  | "pass_expired"
  | "insufficient_funds"
  | "stale_cumulative"
  | "underpaid"
  | "invalid_signature";

// --- header codec (base64 JSON, works in browsers and Node) ------------------------------------------

export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T>(header: string): T {
  const bin = atob(header.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function isBatchRequirements(r: unknown): r is BatchSettlementRequirements {
  const x = r as BatchSettlementRequirements;
  return !!x && x.scheme === BATCH_SCHEME && typeof x.amount === "string" && !!x.extra?.vault;
}
