import { hosted, rateLimited } from "@/lib/server/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Public "settle now" for the playground: claims every unsettled voucher in one transaction. */
export async function POST() {
  if (rateLimited("settle", 1, 20_000)) return Response.json({ error: "settled moments ago, try again in 20 seconds" }, { status: 429 });
  try {
    const result = (await hosted().settleNow()) as { hash: string; gasUsed: bigint; totalPaid: bigint } | null;
    if (!result) return Response.json({ nothingToSettle: true });
    return Response.json({ hash: result.hash, gasUsed: result.gasUsed.toString(), totalPaid: result.totalPaid.toString() });
  } catch (e) {
    return Response.json({ error: (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message }, { status: 500 });
  }
}
