/** In-memory event feed + counters for the dashboard (SSE) and /stats. */
export type MerchantEvent =
  | { type: "paid"; at: number; path: string; passId: string; cumulative: string; price: string; verifyMs: number; requests: number; signer: string }
  | { type: "rejected"; at: number; path: string; passId?: string; error: string; message: string; status: number }
  | { type: "settled"; at: number; hash: string; gasUsed: string; totalPaid: string; passes: number; requests: number; blockNumber: string }
  | { type: "settle_failed"; at: number; error: string }
  | { type: "pass"; at: number; passId: string; event: string; authorizer: string; deposit: string; claimed: string; closed: boolean };

export interface Stats {
  startedAt: number;
  paidRequests: number;
  acceptedVolume: string;
  rejected: Record<string, number>;
  avgVerifyMs: number;
  settlements: Extract<MerchantEvent, { type: "settled" }>[];
  settledVolume: string;
  settlementGas: string;
}

export class Hub {
  private listeners = new Set<(e: MerchantEvent) => void>();
  private recent: MerchantEvent[] = [];
  private verifyTotal = 0;
  readonly stats: Stats = {
    startedAt: Date.now(),
    paidRequests: 0,
    acceptedVolume: "0",
    rejected: {},
    avgVerifyMs: 0,
    settlements: [],
    settledVolume: "0",
    settlementGas: "0",
  };

  emit(e: MerchantEvent) {
    if (e.type === "paid") {
      this.stats.paidRequests++;
      this.stats.acceptedVolume = (BigInt(this.stats.acceptedVolume) + BigInt(e.price)).toString();
      this.verifyTotal += e.verifyMs;
      this.stats.avgVerifyMs = this.verifyTotal / this.stats.paidRequests;
    } else if (e.type === "rejected") {
      this.stats.rejected[e.error] = (this.stats.rejected[e.error] ?? 0) + 1;
    } else if (e.type === "settled") {
      this.stats.settlements.unshift(e);
      this.stats.settlements = this.stats.settlements.slice(0, 50);
      this.stats.settledVolume = (BigInt(this.stats.settledVolume) + BigInt(e.totalPaid)).toString();
      this.stats.settlementGas = (BigInt(this.stats.settlementGas) + BigInt(e.gasUsed)).toString();
    }
    this.recent.push(e);
    if (this.recent.length > 500) this.recent.shift();
    for (const fn of this.listeners) fn(e);
  }

  subscribe(fn: (e: MerchantEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  history(limit = 100) {
    return this.recent.slice(-limit);
  }
}
