import { getAbiItem, type Address, type PublicClient } from "viem";
import { passVaultAbi } from "./abi";
import type { PassSnapshot, PassSource } from "./merchant";
import { AEVUM } from "./chain";

const WATCHED = [
  "AuthorizerChanged",
  "ToppedUp",
  "CloseRequested",
  "Refunded",
  "Claimed",
  "ExpiryExtended",
  "Transfer",
] as const;
const EVENTS = WATCHED.map((name) => getAbiItem({ abi: passVaultAbi, name }));

export async function readPass(client: PublicClient, vault: Address, passId: bigint): Promise<PassSnapshot | null> {
  const p = await client.readContract({ address: vault, abi: passVaultAbi, functionName: "getPass", args: [passId] });
  if (p.merchant === "0x0000000000000000000000000000000000000000") return null;
  const owner = await client.readContract({ address: vault, abi: passVaultAbi, functionName: "ownerOf", args: [passId] });
  return {
    passId,
    merchant: p.merchant,
    merchantAgentId: BigInt(p.merchantAgentId),
    authorizer: p.authorizer,
    owner,
    deposit: p.deposit,
    claimed: p.claimed,
    expiry: Number(p.expiry),
    closeRequestedAt: Number(p.closeRequestedAt),
    closed: p.closed,
  };
}

/**
 * Pass state from the chain, cached in memory and refreshed by polling vault events every block.
 * Request verification never waits on RPC for a known pass; a revoke shows up within ~1 block.
 */
export class ChainPassCache implements PassSource {
  private cache = new Map<string, PassSnapshot>();
  private lastBlock = 0n;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private listeners = new Set<(p: PassSnapshot, event: string, block: bigint) => void>();

  constructor(
    private readonly client: PublicClient,
    private readonly vault: Address,
    private readonly pollMs = 1000,
  ) {}

  async getPass(passId: bigint): Promise<PassSnapshot | null> {
    const hit = this.cache.get(passId.toString());
    if (hit) return hit;
    const fresh = await readPass(this.client, this.vault, passId);
    if (fresh) this.cache.set(passId.toString(), fresh);
    return fresh;
  }

  /** Force a re-read (e.g. right after we sent a claim). */
  async refresh(passId: bigint): Promise<PassSnapshot | null> {
    const fresh = await readPass(this.client, this.vault, passId);
    if (fresh) this.cache.set(passId.toString(), fresh);
    return fresh;
  }

  onChange(fn: (p: PassSnapshot, event: string, block: bigint) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    this.lastBlock = await this.client.getBlockNumber();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const head = await this.client.getBlockNumber();
      if (head <= this.lastBlock) return;
      const from = this.lastBlock + 1n;
      const to = head - from >= AEVUM.maxLogRange ? from + AEVUM.maxLogRange - 1n : head;
      const logs = await this.client.getLogs({ address: this.vault, events: EVENTS, fromBlock: from, toBlock: to });
      const touched = new Map<string, string>();
      for (const log of logs) {
        const args = (log as unknown as { args: Record<string, unknown>; eventName: string }).args;
        const id = (args.passId ?? args.tokenId) as bigint | undefined;
        if (id !== undefined && this.cache.has(id.toString())) {
          touched.set(id.toString(), (log as unknown as { eventName: string }).eventName);
        }
      }
      for (const [id, event] of touched) {
        const fresh = await readPass(this.client, this.vault, BigInt(id));
        if (fresh) {
          this.cache.set(id, fresh);
          for (const fn of this.listeners) fn(fresh, event, to);
        }
      }
      this.lastBlock = to;
    } catch {
      // transient RPC error: retry next tick
    } finally {
      this.polling = false;
    }
  }
}
