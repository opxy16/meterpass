import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm monorepo: trace files from the repo root so workspace packages are bundled on Vercel.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@meterpass/sdk", "@meterpass/merchant"],
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
};

export default config;
