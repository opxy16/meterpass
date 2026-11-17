import { defineChain, type Address, type Hex } from "viem";

/** QDay Aevum testnet. Verified on-chain 2026-11-17. */
export const aevumTestnet = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const AEVUM = {
  chainId: 44005,
  network: "eip155:44005",
  rpcUrl: "https://rpc-test.qday.info",
  bundlerUrl: "https://bundler.qday.info",
  explorerUrl: "https://explorer-test.qday.info",
  tUSD8: "0x456569838f1d43009A91ebA4263147Afd7233483",
  tUSD8Decimals: 6,
  entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  kernelV31Implementation: "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D",
  kernelV31Factory: "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419",
  kernelEcdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57",
  /** eth_getLogs refuses ranges above this many blocks. */
  maxLogRange: 1000n,
} as const satisfies Record<string, string | number | bigint>;

/** Addresses written by contracts/script/Deploy.s.sol to deployments/<chainId>.json. */
export interface MeterPassDeployment {
  chainId: number;
  startBlock: number;
  settlementWindow: number;
  token: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
  passVault: Address;
  sessionValidator: Address;
  entryPoint: Address;
  kernelFactory: Address;
  kernelEcdsaValidator: Address;
  /** Filled by the merchant registration script. */
  merchantAgentId?: number;
  merchant?: Address;
}

export const explorerTx = (hash: Hex, base: string = AEVUM.explorerUrl) => `${base}/tx/${hash}`;
export const explorerAddress = (address: Address, base: string = AEVUM.explorerUrl) => `${base}/address/${address}`;
export const caip2 = (chainId: number) => `eip155:${chainId}` as const;
