"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "@/lib/hooks";

interface Packet {
  id: number;
  kind: "voucher" | "settle" | "reject";
  born: number;
}

/**
 * Agent -> Merchant -> PassVault. Every paid request sends a voucher packet along the off-chain
 * lane; every settlement sends one green packet down to the chain. With no live traffic it plays
 * a labelled illustration loop.
 */
export function Pipeline({ events, live }: { events: FeedEvent[]; live: boolean }) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [now, setNow] = useState(0);
  const seen = useRef(0);
  const nextId = useRef(1);
  const lastTop = useRef<FeedEvent | undefined>(undefined);
  const lastPaidAt = events.find((e) => e.type === "paid")?.at ?? 0;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const idleDemo = !live || clock - lastPaidAt > 5000;

  // new live events -> packets
  useEffect(() => {
    const top = events[0];
    if (!top || top === lastTop.current) return;
    const fresh: FeedEvent[] = [];
    for (const e of events) {
      if (e === lastTop.current) break;
      fresh.push(e);
    }
    lastTop.current = top;
    seen.current += fresh.length;
    const t = performance.now();
    setPackets((p) => [
      ...p.filter((x) => t - x.born < 2600),
      ...fresh
        .filter((e) => e.type === "paid" || e.type === "settled" || e.type === "rejected")
        .slice(0, 12)
        .map((e, i) => ({
          id: nextId.current++,
          kind: e.type === "settled" ? ("settle" as const) : e.type === "rejected" ? ("reject" as const) : ("voucher" as const),
          born: t + i * 40,
        })),
    ]);
  }, [events]);

  // illustration loop
  useEffect(() => {
    if (!idleDemo) return;
    let n = 0;
    const id = setInterval(() => {
      n++;
      const t = performance.now();
      setPackets((p) => [
        ...p.filter((x) => t - x.born < 2600),
        { id: nextId.current++, kind: n % 14 === 0 ? "settle" : "voucher", born: t },
      ]);
    }, 260);
    return () => clearInterval(id);
  }, [idleDemo]);

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      setNow(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const W = 1000;
  const agent = { x: 110, y: 80 };
  const merchant = { x: 500, y: 80 };
  const vault = { x: 890, y: 150 };

  return (
    <div className="glass pipeline">
      <svg viewBox={`0 0 ${W} 220`} role="img" aria-label="Vouchers flow from the agent to the merchant off-chain; settlements flow to PassVault on-chain">
        <path className="lane" d={`M${agent.x + 70},${agent.y} L${merchant.x - 80},${merchant.y}`} />
        <path className="lane" d={`M${merchant.x + 80},${merchant.y} C${merchant.x + 200},${merchant.y} ${vault.x - 160},${vault.y} ${vault.x - 70},${vault.y}`} />
        <text x={(agent.x + merchant.x) / 2} y={agent.y - 22} textAnchor="middle" className="node-sub">
          off-chain · EIP-712 voucher · ~ms · no gas
        </text>
        <text x={(merchant.x + vault.x) / 2 + 30} y={vault.y + 46} textAnchor="middle" className="node-sub">
          on-chain · claimBatch · one tx for many calls
        </text>
        {[
          { ...agent, label: "AI agent", sub: "session key" },
          { ...merchant, label: "Merchant API", sub: "x402 · ERC-8004" },
          { ...vault, label: "PassVault", sub: "Aevum · tUSD8" },
        ].map((n) => (
          <g key={n.label}>
            <rect className="node-box" x={n.x - 72} y={n.y - 28} width={144} height={56} rx={14} />
            <text x={n.x} y={n.y - 2} textAnchor="middle" className="node-label">
              {n.label}
            </text>
            <text x={n.x} y={n.y + 16} textAnchor="middle" className="node-sub">
              {n.sub}
            </text>
          </g>
        ))}
        {packets.map((p) => {
          const age = (now - p.born) / (p.kind === "settle" ? 1600 : 900);
          if (age < 0 || age > 1) return null;
          if (p.kind === "settle") {
            const t = age;
            const x0 = merchant.x + 80, y0 = merchant.y, x3 = vault.x - 70, y3 = vault.y;
            const x1 = merchant.x + 200, y1 = merchant.y, x2 = vault.x - 160, y2 = vault.y;
            const x = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3 * x3;
            const y = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3 * y3;
            return <circle key={p.id} cx={x} cy={y} r={9} className="packet settle" />;
          }
          const x = agent.x + 70 + (merchant.x - 80 - agent.x - 70) * age;
          return <circle key={p.id} cx={x} cy={agent.y} r={5} className="packet" style={p.kind === "reject" ? { fill: "var(--rose)", filter: "drop-shadow(0 0 6px var(--rose))" } : undefined} />;
        })}
      </svg>
      {idleDemo && (
        <span className="chip" style={{ position: "absolute", left: 16, bottom: 14, marginTop: 0 }}>
          illustration · live packets appear while an agent is paying
        </span>
      )}
    </div>
  );
}
