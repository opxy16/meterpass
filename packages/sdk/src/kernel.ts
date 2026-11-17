import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type LocalAccount,
  type Transport,
} from "viem";
import { readContract, getCode } from "viem/actions";
import {
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  toSmartAccount,
  type SmartAccount,
} from "viem/account-abstraction";
import { AEVUM } from "./chain";

/**
 * Kernel v3.1 (ZeroDev) smart accounts on Aevum, with the MeterPass session module.
 *
 * Owner setup is ONE user operation signed ONCE by the owner: it deploys the account (root
 * validator = ECDSA(owner)), installs MeterPassSessionValidator for the agent's key in the
 * account's initConfig, and approves PassVault for the budget. From then on the agent signs its
 * own user operations, which the module limits to PassVault.open/topUp within the policy.
 */

export const kernelAbi = parseAbi([
  "function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function installModule(uint256 moduleType, address module, bytes initData)",
  "function uninstallModule(uint256 moduleType, address module, bytes deInitData)",
  "function execute(bytes32 execMode, bytes executionCalldata)",
]);
export const kernelFactoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);

const EXECUTE_SELECTOR = "0xe9ae5c53" as const;
const MODE_SINGLE = zeroHash;
const MODE_BATCH = "0x0100000000000000000000000000000000000000000000000000000000000000" as const;
/** A well-formed dummy signature for gas estimation (recovers to an unrelated address). */
export const STUB_SIGNATURE =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c" as const;

export interface SessionPolicy {
  /** Deployed MeterPassSessionValidator. */
  validator: Address;
  /** The agent's key: signs user operations AND pass vouchers. */
  sessionKey: Address;
  /** Every pass the agent opens must be owned by this address (the human). */
  passOwner: Address;
  /** Max tUSD8 (base units) the agent may move into passes, in total. */
  budget: bigint;
  validAfter: number;
  validUntil: number;
  merchantAgentIds: bigint[];
}

export function sessionInstallData(p: SessionPolicy): Hex {
  const sessionData = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint128" },
      { type: "uint48" },
      { type: "uint48" },
      { type: "uint256[]" },
    ],
    [p.sessionKey, p.passOwner, p.budget, p.validAfter, p.validUntil, p.merchantAgentIds],
  );
  // Kernel v3.1 validator install data: hook (20 bytes) ++ abi.encode(validatorData, hookData, selectorData)
  return concat([
    zeroAddress,
    encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [sessionData, "0x", EXECUTE_SELECTOR]),
  ]);
}

export function kernelInitData(params: { owner: Address; session?: SessionPolicy; ecdsaValidator?: Address }): Hex {
  const ecdsa = params.ecdsaValidator ?? AEVUM.kernelEcdsaValidator;
  const initConfig: Hex[] = params.session
    ? [
        encodeFunctionData({
          abi: kernelAbi,
          functionName: "installModule",
          args: [1n, params.session.validator, sessionInstallData(params.session)],
        }),
      ]
    : [];
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "initialize",
    args: [concat(["0x01", ecdsa]), zeroAddress, params.owner, "0x", initConfig],
  });
}

export interface KernelCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

export function encodeKernelCalls(calls: readonly KernelCall[]): Hex {
  if (calls.length === 1) {
    const c = calls[0]!;
    return encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [MODE_SINGLE, encodePacked(["address", "uint256", "bytes"], [c.to, c.value ?? 0n, c.data ?? "0x"])],
    });
  }
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [
      MODE_BATCH,
      encodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "callData", type: "bytes" },
            ],
          },
        ],
        [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? "0x" }))],
      ),
    ],
  });
}

/** Kernel v3 nonce key selecting a non-root validator: [mode 0x00][type 0x01][validator][key]. */
export function validatorNonceKey(validator: Address, key = 0): bigint {
  return (1n << 176n) | (BigInt(validator) << 16n) | BigInt(key);
}

export async function getKernelAddress(client: Client, initData: Hex, salt: Hex = zeroHash, factory: Address = AEVUM.kernelV31Factory) {
  return readContract(client, { address: factory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, salt] });
}

/**
 * A viem SmartAccount for a MeterPass Kernel account.
 *  - mode "root": the owner key signs (setup, revoke, rotate, uninstall).
 *  - mode "session": the agent key signs and the nonce key routes validation to the session module.
 */
export async function toMeterPassKernelAccount(params: {
  client: Client<Transport, Chain>;
  signer: LocalAccount;
  initData: Hex;
  salt?: Hex;
  mode: "root" | { sessionValidator: Address };
  factory?: Address;
}): Promise<SmartAccount> {
  const { client, signer, initData } = params;
  const salt = params.salt ?? zeroHash;
  const factory = params.factory ?? AEVUM.kernelV31Factory;
  const address = await getKernelAddress(client, initData, salt, factory);
  const nonceKey = params.mode === "root" ? 0n : validatorNonceKey(params.mode.sessionValidator);
  let deployed = false;

  return toSmartAccount({
    client: client as unknown as Parameters<typeof toSmartAccount>[0]["client"],
    entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: "0.7" },
    async getAddress() {
      return address;
    },
    async encodeCalls(calls) {
      return encodeKernelCalls(calls);
    },
    async getFactoryArgs() {
      if (!deployed) deployed = !!(await getCode(client, { address }));
      if (deployed) return { factory: undefined, factoryData: undefined };
      return {
        factory,
        factoryData: encodeFunctionData({ abi: kernelFactoryAbi, functionName: "createAccount", args: [initData, salt] }),
      };
    },
    async getNonce() {
      return readContract(client, {
        address: entryPoint07Address,
        abi: entryPoint07Abi,
        functionName: "getNonce",
        args: [address, nonceKey],
      });
    },
    async getStubSignature() {
      return STUB_SIGNATURE;
    },
    async signUserOperation(op) {
      const { chainId = client.chain.id, ...userOperation } = op;
      const hash = getUserOperationHash({
        chainId,
        entryPointAddress: entryPoint07Address,
        entryPointVersion: "0.7",
        userOperation: { ...userOperation, sender: address },
      });
      return signer.signMessage({ message: { raw: hash } });
    },
    async signMessage() {
      throw new Error("MeterPass Kernel adapter does not sign ERC-1271 messages");
    },
    async signTypedData() {
      throw new Error("MeterPass Kernel adapter does not sign ERC-1271 typed data");
    },
  });
}
