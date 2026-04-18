import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling these packages — they use dynamic requires
  // and internal path resolution that breaks in the bundled output.
  // Node.js will resolve them natively at runtime instead.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
