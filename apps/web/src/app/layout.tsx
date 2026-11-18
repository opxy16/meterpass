import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { REPO_URL, deployment, explorerAddr, short } from "@/lib/config";

export const metadata: Metadata = {
  title: "MeterPass: pay per request, settle once",
  description:
    "AI agents pay for every API call with an off-chain voucher; the merchant settles hundreds of calls in one transaction. x402 batch settlement on QDay Aevum.",
};

export const viewport: Viewport = { themeColor: "#070912", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="ambient" aria-hidden>
          <div className="grid-bg" />
          <div className="orb a" />
          <div className="orb b" />
        </div>
        <Nav />
        <main className="container">{children}</main>
        <footer className="container footer">
          <span>
            MeterPass · built for Aevum Builder Challenge #1 · testnet only (tUSD8 has no value)
          </span>
          <span>
            {deployment && (
              <>
                vault{" "}
                <a className="mono" href={explorerAddr(deployment.passVault)} target="_blank" rel="noreferrer">
                  {short(deployment.passVault)}
                </a>{" "}
                ·{" "}
              </>
            )}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              source (MIT)
            </a>
          </span>
        </footer>
      </body>
    </html>
  );
}
