import { hosted } from "@/lib/server/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = (req: Request) => {
  try {
    return hosted().app.fetch(req);
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 503 });
  }
};

export { handler as GET, handler as POST, handler as OPTIONS };
