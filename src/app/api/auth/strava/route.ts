/**
 * GET /api/auth/strava
 * Initiates the Strava OAuth flow.
 *
 * Returns an HTML page that immediately navigates to Strava via JavaScript.
 * This is intentional: iOS Universal Links (which open the Strava app) only
 * fire on direct user-initiated navigations, not server-side HTTP redirects.
 * A JS window.location assignment is treated as a user navigation and correctly
 * triggers the Universal Link → Strava app opens if installed, browser fallback if not.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return new Response("User ID is required", { status: 400 });
  }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    response_type: "code",
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/callback`,
    scope: "read,activity:read_all",
    state: userId,
  });

  const appUrl = `strava://oauth/mobile/authorize?${params.toString()}`;
  const webUrl = `https://www.strava.com/oauth/mobile/authorize?${params.toString()}`;

  // Try the custom URL scheme first (opens Strava app directly if installed).
  // After 1.5s, fall back to the web URL for users without the app.
  // This is more reliable than Universal Links, which don't fire from JS navigations.
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connecting to Strava…</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script>
      window.location.href = ${JSON.stringify(appUrl)};
      setTimeout(function() { window.location.href = ${JSON.stringify(webUrl)}; }, 1500);
    </script>
  </head>
  <body style="font-family:sans-serif;text-align:center;padding:40px;color:#333">
    <p>Connecting to Strava…</p>
    <p><a href="${webUrl}">Tap here if you aren't redirected</a></p>
  </body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
