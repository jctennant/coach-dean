import { PostHog } from "posthog-node";

/**
 * Singleton PostHog Node client for server-side event tracking.
 * Used in API routes and background functions.
 */
let _client: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new PostHog(key, {
      host: "https://us.i.posthog.com",
      flushAt: 1,   // flush immediately — we're in serverless
      flushInterval: 0,
    });
  }
  return _client;
}
