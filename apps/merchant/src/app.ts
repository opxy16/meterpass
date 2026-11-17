import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { PublicClient } from "viem";
import {
  X402_HEADERS,
  formatTusd8,
  type MeterPassMerchant,
  type PassSource,
  type SettlementResult,
  type VoucherStore,
} from "@meterpass/sdk";
import { catalog } from "./catalog";
import type { Hub } from "./hub";

export interface MerchantAppDeps {
  merchant: MeterPassMerchant;
  client: PublicClient;
  passes: PassSource;
  store: VoucherStore;
  hub: Hub;
  info: {
    name: string;
    merchantAgentId: string;
    identityRegistry: string;
    payTo: string;
    vault: string;
    chainId: number;
    settlementWindow: number;
    settleIntervalSeconds: number;
  };
  settleNow?: () => Promise<SettlementResult | null>;
  adminToken?: string;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** The MeterPass demo merchant as a Hono app: runs on Node (src/server.ts) or any fetch runtime. */
export function createMerchantApp(deps: MerchantAppDeps) {
  const app = new Hono();
  const products = catalog();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization", X402_HEADERS.signature, "X-MeterPass-Pass"],
      exposeHeaders: [X402_HEADERS.required, X402_HEADERS.response],
    }),
  );

  app.get("/", (c) =>
    c.json({
      ...deps.info,
      x402: { version: 2, scheme: "batch-settlement", network: `eip155:${deps.info.chainId}` },
      products: products.map((p) => ({ path: p.path, price: p.price.toString(), priceTusd8: formatTusd8(p.price, 3), description: p.description })),
    }),
  );

  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      resources: products.map((p) => ({
        path: p.path,
        description: p.description,
        accepts: [deps.merchant.requirements(p.price)],
      })),
    }),
  );

  app.get("/stats", (c) => c.json(deps.hub.stats));
  app.get("/history", (c) => c.json(deps.hub.history(Number(c.req.query("limit") ?? 100))));

  app.get("/passes/:id", async (c) => {
    const id = BigInt(c.req.param("id"));
    const [pass, voucher] = await Promise.all([deps.passes.getPass(id), deps.store.get(id)]);
    if (!pass) return c.json({ error: "unknown pass" }, 404);
    return c.json(json({ pass, latestVoucher: voucher, unsettled: voucher ? voucher.cumulative - pass.claimed : 0n }));
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      for (const e of deps.hub.history(50)) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      let open = true;
      const off = deps.hub.subscribe((e) => {
        if (open) void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      });
      stream.onAbort(() => {
        open = false;
        off();
      });
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
    }),
  );

  app.post("/admin/settle", async (c) => {
    if (!deps.adminToken || c.req.header("authorization") !== `Bearer ${deps.adminToken}`) return c.json({ error: "unauthorized" }, 401);
    if (!deps.settleNow) return c.json({ error: "settlement not configured" }, 501);
    const result = await deps.settleNow();
    return c.json(json(result ?? { nothingToSettle: true }));
  });

  for (const product of products) {
    app.get(product.path, async (c) => {
      const resource = { url: c.req.url, description: product.description, mimeType: "application/json" };
      const result = await deps.merchant.verify(resource, product.price, c.req.header(X402_HEADERS.signature) ?? null);
      const passHeader = c.req.header("X-MeterPass-Pass");
      if (!result.ok) {
        if (result.error !== "payment_required") {
          deps.hub.emit({ type: "rejected", at: Date.now(), path: product.path, passId: passHeader, error: result.error, message: result.message, status: result.status });
        }
        c.header(X402_HEADERS.required, result.requiredHeader);
        return c.json({ error: result.error, message: result.message, ...result.paymentRequired }, result.status);
      }
      const data = await product.handler({ client: deps.client, params: c.req.param(), query: new URL(c.req.url).searchParams });
      deps.hub.emit({
        type: "paid",
        at: Date.now(),
        path: product.path,
        passId: result.receipt.passId.toString(),
        cumulative: result.receipt.cumulative.toString(),
        price: result.price.toString(),
        verifyMs: Math.round(result.verifyMs * 100) / 100,
        requests: result.receipt.requests,
        signer: result.receipt.signer,
      });
      c.header(X402_HEADERS.response, result.responseHeader);
      return c.json({ data, paid: { price: formatTusd8(result.price, 3), remaining: formatTusd8(result.remaining, 3) } });
    });
  }

  return app;
}
