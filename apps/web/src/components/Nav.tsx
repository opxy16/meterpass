"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CHAIN_ID, publicClient } from "@/lib/config";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/passes", label: "Passes" },
  { href: "/playground", label: "Try it" },
  { href: "/how", label: "How" },
];

export function Nav() {
  const path = usePathname();
  const [block, setBlock] = useState<bigint | null>(null);
  const [ok, setOk] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const n = await publicClient.getBlockNumber({ cacheTime: 0 });
        if (alive) {
          setBlock(n);
          setOk(true);
        }
      } catch {
        if (alive) setOk(false);
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <nav className="nav" aria-label="Main">
      <div className="wrap nav-row">
        <Link href="/" className="brand" aria-label="MeterPass home">
          <span className="brand-mark" aria-hidden>
            <span>0</span>
            <span>2</span>
          </span>
          <span className="brand-name">MeterPass</span>
        </Link>
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </div>
        <span className="chain-lamp" title="Latest block on the Aevum RPC">
          <span className={`lamp ${ok ? "" : "off"}`} aria-hidden />
          <span className="chain-text">
            {CHAIN_ID === 44005 ? "Aevum testnet" : `Chain ${CHAIN_ID}`}
            {block !== null && `, block ${block.toLocaleString()}`}
          </span>
        </span>
      </div>
    </nav>
  );
}
