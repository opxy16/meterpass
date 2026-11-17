import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";

/**
 * A MeterPass voucher: "for pass `passId`, I have now used `cumulativeAmount` in total".
 * Signed off-chain by the pass authorizer (the agent's session key) for every request.
 * Cumulative + EIP-712 domain (chain id + vault address) = no replay, no reordering problems.
 */
export interface Voucher {
  passId: bigint;
  cumulativeAmount: bigint;
}

export interface VoucherContext {
  chainId: number;
  vault: Address;
}

export const voucherTypes = {
  Voucher: [
    { name: "passId", type: "uint256" },
    { name: "cumulativeAmount", type: "uint128" },
  ],
} as const;

export const voucherDomain = ({ chainId, vault }: VoucherContext): TypedDataDomain => ({
  name: "MeterPass",
  version: "1",
  chainId,
  verifyingContract: vault,
});

export function hashVoucher(ctx: VoucherContext, voucher: Voucher): Hex {
  return hashTypedData({
    domain: voucherDomain(ctx),
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
  });
}

/** Signer: anything that can sign EIP-712 (a viem LocalAccount, or a wallet via signTypedData). */
export type TypedDataSigner = Pick<LocalAccount, "address" | "signTypedData">;

export async function signVoucher(signer: TypedDataSigner, ctx: VoucherContext, voucher: Voucher): Promise<Hex> {
  return signer.signTypedData({
    domain: voucherDomain(ctx),
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
  });
}

export async function recoverVoucherSigner(ctx: VoucherContext, voucher: Voucher, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: voucherDomain(ctx),
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
    signature,
  });
}
