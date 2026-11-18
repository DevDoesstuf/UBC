import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The CDP SDK is only loaded on the server, and only when Coinbase mode is on.
  serverExternalPackages: ["@coinbase/cdp-sdk"],
};

export default nextConfig;
