import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address, Hex } from "viem";
import type { VoucherLedger } from "@meterpass/sdk";
import { repoRoot } from "@meterpass/node";

export interface Evidence {
  label: string;
  hash: Hex;
  gasUsed?: string;
  at: string;
  note?: string;
}

export interface DemoState {
  chainId: number;
  account?: Address;
  initData?: Hex;
  salt?: Hex;
  validUntil?: number;
  mainPass?: string;
  refundPass?: string;
  ledgers: Record<string, Record<string, { cumulative: string; signature: Hex }>>;
  baseline?: { n: number; totalGas: string; avgGas: string; seconds: number; firstHash: Hex; lastHash: Hex; gasPrice: string };
  runs: { agent: string; pass: string; calls: number; paid: number; refusedOrRejected: number; ms: number; at: string; note?: string }[];
}

/** Demo state lives in apps/agent/data (git-ignored). Public evidence goes to deployments/. */
export class StateFile {
  readonly path: string;
  readonly evidencePath: string;
  state: DemoState;

  constructor(chainId: number) {
    this.path = join(repoRoot, "apps", "agent", "data", `state-${chainId}.json`);
    this.evidencePath = join(repoRoot, "deployments", `evidence-${chainId}.json`);
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { chainId, ledgers: {}, runs: [] };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  /** Public, measured numbers for the dashboard and README (deployments/metrics-<chainId>.json). */
  metric(key: string, value: unknown) {
    const path = this.evidencePath.replace("evidence-", "metrics-");
    const m: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    m[key] = value;
    writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  }

  evidence(e: Omit<Evidence, "at">) {
    const list: Evidence[] = existsSync(this.evidencePath) ? JSON.parse(readFileSync(this.evidencePath, "utf8")) : [];
    list.push({ ...e, at: new Date().toISOString() });
    writeFileSync(this.evidencePath, JSON.stringify(list, null, 2) + "\n");
  }

  ledger(agent: string): VoucherLedger & { last(passId: bigint): { cumulative: bigint; signature: Hex } | undefined } {
    const self = this;
    const book = (this.state.ledgers[agent] ??= {});
    return {
      async get(passId) {
        return BigInt(book[passId.toString()]?.cumulative ?? "0");
      },
      async set(passId, cumulative, signature) {
        book[passId.toString()] = { cumulative: cumulative.toString(), signature };
        self.save();
      },
      last(passId) {
        const e = book[passId.toString()];
        return e && { cumulative: BigInt(e.cumulative), signature: e.signature };
      },
    };
  }
}
