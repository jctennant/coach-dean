import { supabase } from "./supabase";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/**
 * Refresh Strava access token if expired, then return a valid token.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const { data: user, error } = await supabase
    .from("users")
    .select(
      "strava_access_token, strava_refresh_token, strava_token_expires_at"
    )
    .eq("id", userId)
    .single();

  if (error || !user) throw new Error(`User not found: ${userId}`);

  const now = new Date();
  const expiresAt = new Date(user.strava_token_expires_at ?? 0);

  // Refresh if token expires within the next 5 minutes
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    if (!user.strava_refresh_token) throw new Error(`Missing refresh token for user ${userId}`);
    const tokens = await refreshToken(user.strava_refresh_token);

    await supabase
      .from("users")
      .update({
        strava_access_token: tokens.access_token,
        strava_refresh_token: tokens.refresh_token,
        strava_token_expires_at: new Date(
          tokens.expires_at * 1000
        ).toISOString(),
      })
      .eq("id", userId);

    return tokens.access_token;
  }

  if (!user.strava_access_token) throw new Error(`Missing access token for user ${userId}`);
  return user.strava_access_token;
}

async function refreshToken(refreshToken: string): Promise<StravaTokens> {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Strava token refresh failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch a Strava activity by ID.
 */
export async function getActivity(accessToken: string, activityId: number) {
  const response = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Strava API error: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch the authenticated athlete's profile.
 */
export async function getAthlete(accessToken: string) {
  const response = await fetch(`${STRAVA_API_BASE}/athlete`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Strava API error: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch a page of activities for the authenticated athlete.
 * Strava returns max 200 per page.
 */
export async function listActivities(
  accessToken: string,
  options?: { before?: number; after?: number; page?: number; per_page?: number }
) {
  const { before, after, page = 1, per_page = 200 } = options || {};
  const params = new URLSearchParams({
    page: page.toString(),
    per_page: per_page.toString(),
  });
  if (before) params.append("before", before.toString());
  if (after) params.append("after", after.toString());

  const response = await fetch(
    `${STRAVA_API_BASE}/athlete/activities?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Strava API error: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch all activities with automatic pagination.
 * Optionally limit to activities after a given Unix timestamp.
 */
export async function getAllActivities(
  accessToken: string,
  options?: { after?: number; maxPages?: number }
): Promise<unknown[]> {
  const allActivities: unknown[] = [];
  let page = 1;
  const maxPages = options?.maxPages ?? 10; // Safety limit (2000 activities)

  while (page <= maxPages) {
    const activities = await listActivities(accessToken, {
      after: options?.after,
      page,
      per_page: 200,
    });

    if (!Array.isArray(activities) || activities.length === 0) break;
    allActivities.push(...activities);
    if (activities.length < 200) break; // Last page
    page++;
  }

  return allActivities;
}

/**
 * Update the description of a Strava activity.
 * Fetches the existing description first so the caller can prepend without overwriting.
 */
export async function getActivityDescription(accessToken: string, activityId: number): Promise<string> {
  const response = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Strava getActivity failed: ${response.statusText}`);
  }
  const data = await response.json();
  return (data.description as string) || "";
}

export async function updateActivityDescription(
  accessToken: string,
  activityId: number,
  description: string
): Promise<void> {
  const response = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ description }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Strava updateActivity failed: ${response.status} ${body}`);
  }
}

/**
 * Fetch athlete statistics (all-time, YTD, recent 4 weeks).
 */
export async function getAthleteStats(accessToken: string, athleteId: number) {
  const response = await fetch(
    `${STRAVA_API_BASE}/athletes/${athleteId}/stats`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Strava API error: ${response.statusText}`);
  }

  return response.json();
}
