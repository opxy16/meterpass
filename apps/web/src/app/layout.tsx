import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { REPO_URL, deployment, explorerAddr, short } from "@/lib/config";

// One family, used through its width axis: expanded for headlines, condensed for meter digits.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

export const metadata: Metadata = {
  title: "MeterPass: pay per request, settle once",
  description:
    "AI agents pay for every API call with an off-chain voucher; the merchant settles hundreds of calls in one transaction. x402 batch settlement on QDay Aevum.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6eaed" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1c22" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <a href="#main" className="sr-only">
          Skip to content
        </a>
        <Nav />
        <main id="main" className="wrap">
          {children}
        </main>
        <footer className="wrap footer">
          <span>MeterPass, built for Aevum Builder Challenge #1. Testnet only: tUSD8 has no value.</span>
          <span>
            {deployment && (
              <>
                PassVault{" "}
                <a href={explorerAddr(deployment.passVault)} target="_blank" rel="noreferrer">
                  {short(deployment.passVault)}
                </a>
                {", "}
              </>
            )}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              source code (MIT)
            </a>
          </span>
        </footer>
      </body>
    </html>
  );
}
