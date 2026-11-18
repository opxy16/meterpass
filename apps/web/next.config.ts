import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@meterpass/sdk", "@meterpass/merchant"],
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
};

export default config;
