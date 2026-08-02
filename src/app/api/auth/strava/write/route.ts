/**
 * GET /api/auth/strava/write?userId=<id>
 * Initiates the Strava OAuth flow. Despite the route name (kept to avoid
 * touching existing links across onboarding/SMS reconnect flows), this now
 * requests read-only scope, matching /api/auth/strava exactly — Coach Dean
 * no longer writes anything back to Strava (the activity-annotation feature
 * was removed; see CHANGELOG 2026-08-02), so there's no reason to request
 * activity:write. Same JS-redirect pattern as /api/auth/strava to correctly
 * trigger the Strava app via Universal Link on iOS.
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
    approval_prompt: "force",
    state: userId,
  });

  const appUrl = `strava://oauth/mobile/authorize?${params.toString()}`;
  const webUrl = `https://www.strava.com/oauth/mobile/authorize?${params.toString()}`;

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
