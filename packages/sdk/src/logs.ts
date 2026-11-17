import type { AbiEvent, Address, Log, PublicClient } from "viem";
import { AEVUM } from "./chain";

/** eth_getLogs in ranges of at most `chunk` blocks (Aevum refuses more than 1,000). */
export async function getLogsChunked<const E extends readonly AbiEvent[]>(
  client: PublicClient,
  params: { address: Address | Address[]; events: E; fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<Log[]> {
  const to = params.toBlock ?? (await client.getBlockNumber());
  const chunk = params.chunk ?? AEVUM.maxLogRange;
  const logs: Log[] = [];
  for (let from = params.fromBlock; from <= to; from += chunk) {
    const end = from + chunk - 1n > to ? to : from + chunk - 1n;
    const part = await client.getLogs({ address: params.address, events: params.events, fromBlock: from, toBlock: end });
    logs.push(...(part as Log[]));
  }
  return logs;
}
