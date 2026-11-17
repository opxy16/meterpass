import { hashTypedData, parseSignature, type Address, type Hex, type TypedDataDefinition } from "viem";

/**
 * Open a pass with ONE owner signature and no owner gas.
 * The owner signs an EIP-3009 ReceiveWithAuthorization (token -> PassVault) whose nonce is the
 * EIP-712 hash of the pass terms. A relayer submits PassVault.openWithAuthorization; changing any
 * term changes the nonce and invalidates the signature.
 */
export interface OpenRequest {
  owner: Address;
  merchantAgentId: bigint;
  authorizer: Address;
  amount: bigint;
  expiry: bigint;
  salt: Hex;
}

export const openRequestTypes = {
  OpenRequest: [
    { name: "owner", type: "address" },
    { name: "merchantAgentId", type: "uint256" },
    { name: "authorizer", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "expiry", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Same value as PassVault.openAuthNonce(req). */
export function openAuthNonce(ctx: { chainId: number; vault: Address }, req: OpenRequest): Hex {
  return hashTypedData({
    domain: { name: "MeterPass", version: "1", chainId: ctx.chainId, verifyingContract: ctx.vault },
    types: openRequestTypes,
    primaryType: "OpenRequest",
    message: req,
  });
}

/** The typed data the owner's wallet signs (eth_signTypedData_v4). tUSD8 domain: name "tUSD8", version "2". */
export function openAuthorizationTypedData(params: {
  chainId: number;
  vault: Address;
  token: Address;
  tokenName?: string;
  tokenVersion?: string;
  req: OpenRequest;
  validAfter?: bigint;
  validBefore: bigint;
}): TypedDataDefinition<typeof receiveWithAuthorizationTypes, "ReceiveWithAuthorization"> {
  return {
    domain: {
      name: params.tokenName ?? "tUSD8",
      version: params.tokenVersion ?? "2",
      chainId: params.chainId,
      verifyingContract: params.token,
    },
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: params.req.owner,
      to: params.vault,
      value: params.req.amount,
      validAfter: params.validAfter ?? 0n,
      validBefore: params.validBefore,
      nonce: openAuthNonce({ chainId: params.chainId, vault: params.vault }, params.req),
    },
  };
}

/** Arguments for PassVault.openWithAuthorization from the owner's signature. */
export function openWithAuthorizationArgs(req: OpenRequest, validAfter: bigint, validBefore: bigint, signature: Hex) {
  const { v, r, s, yParity } = parseSignature(signature);
  const vv = Number(v ?? BigInt(yParity + 27));
  return [req, validAfter, validBefore, vv, r, s] as const;
}
