import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling these packages — they use dynamic requires
  // and internal path resolution that breaks in the bundled output.
  // Node.js will resolve them natively at runtime instead.
  serverExternalPackages: ["pdf-parse"],
};

export default withSentryConfig(nextConfig, {
  org: "jake-tennant",
  project: "coach-dean",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: false,
});
