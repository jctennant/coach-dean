import { after } from "next/server";

/**
 * Guaranteed error boundary for background work.
 *
 * `after()` swallows anything thrown inside it: the route has already returned
 * `{ ok: true }`, so a crash produces no failed response, no Sentry event, and
 * no log line unless the body caught its own error. That silent-failure class
 * has bitten repeatedly (reengagement_sent_at incident, userId-vs-user_id
 * no-ops — see CLAUDE.md). All background blocks must go through this wrapper
 * instead of calling `after()` directly; an ESLint rule enforces it.
 *
 * Call sites may still keep their own try/catch for site-specific fallbacks
 * (e.g. sending an apology SMS) — this wrapper is the outer net, guaranteeing
 * every escape lands in the logs and Sentry with the site's label.
 */
export function runAfter(
  label: string,
  fn: () => Promise<void> | void,
  tags?: Record<string, string>
): void {
  after(async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] unhandled error in after():`, err);
      try {
        const { captureException } = await import("@sentry/nextjs");
        captureException(err, { tags: { after_label: label, ...tags } });
      } catch (sentryErr) {
        console.error(`[${label}] failed to report after() error to Sentry:`, sentryErr);
      }
    }
  });
}
