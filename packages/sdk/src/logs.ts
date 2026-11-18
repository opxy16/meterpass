import type { AbiEvent, Address, Log, PublicClient } from "viem";
import { AEVUM } from "./chain";

/** eth_getLogs in ranges of at most `chunk` blocks (Aevum refuses more than 1,000). */
export async function getLogsChunked<const E extends readonly AbiEvent[]>(
  client: PublicClient,
  params: { address: Address | Address[]; events: E; fromBlock: bigint; toBlock?: bigint; chunk?: bigint; parallel?: number },
): Promise<Log[]> {
  const to = params.toBlock ?? (await client.getBlockNumber());
  const chunk = params.chunk ?? AEVUM.maxLogRange;
  const ranges: [bigint, bigint][] = [];
  for (let from = params.fromBlock; from <= to; from += chunk) {
    ranges.push([from, from + chunk - 1n > to ? to : from + chunk - 1n]);
  }
  // A few ranges at a time: fast on long histories, gentle on the public RPC.
  const parallel = params.parallel ?? 6;
  const out: Log[][] = new Array(ranges.length);
  for (let i = 0; i < ranges.length; i += parallel) {
    await Promise.all(
      ranges.slice(i, i + parallel).map(async ([from, end], j) => {
        out[i + j] = (await client.getLogs({ address: params.address, events: params.events, fromBlock: from, toBlock: end })) as Log[];
      }),
    );
  }
  return out.flat();
}
