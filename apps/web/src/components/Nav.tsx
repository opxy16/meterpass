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
    <nav className="nav">
      <div className="container nav-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 12V4l4 5 4-5v8" stroke="#0a0b17" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="13" cy="12" r="1.6" fill="#0a0b17" />
            </svg>
          </span>
          <span className="brand-name">MeterPass</span>
        </Link>
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={path === l.href ? "active" : ""}>
              {l.label}
            </Link>
          ))}
        </div>
        <span className="net-pill" title="Live block height from the Aevum RPC">
          <span className={`dot ${ok ? "" : "off"}`} />
          {CHAIN_ID === 44005 ? "Aevum testnet" : `chain ${CHAIN_ID}`}
          {block !== null && <span className="muted">#{block.toLocaleString()}</span>}
        </span>
      </div>
    </nav>
  );
}
