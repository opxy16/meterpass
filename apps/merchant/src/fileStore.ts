import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredVoucher, VoucherStore } from "@meterpass/sdk";

/** Voucher store persisted to a JSON file, so a merchant restart never loses unsettled money. */
export class FileVoucherStore implements VoucherStore {
  private m = new Map<string, StoredVoucher>();
  private dirty = false;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredVoucher & { passId: string; cumulative: string }>;
      for (const [k, v] of Object.entries(raw)) {
        this.m.set(k, { ...v, passId: BigInt(v.passId), cumulative: BigInt(v.cumulative) });
      }
    }
    setInterval(() => this.flush(), 500).unref();
    process.on("exit", () => this.flush());
  }

  async get(passId: bigint) {
    return this.m.get(passId.toString()) ?? null;
  }
  async put(v: StoredVoucher) {
    this.m.set(v.passId.toString(), v);
    this.dirty = true;
  }
  async all() {
    return [...this.m.values()];
  }

  flush() {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.m), (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
