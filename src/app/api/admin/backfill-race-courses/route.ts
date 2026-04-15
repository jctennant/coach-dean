/**
 * POST /api/admin/backfill-race-courses
 *
 * Backfills elevation/altitude/trail data for races that are missing it.
 * Targets trail/mountain races where elevation_gain_feet IS NULL.
 * For each qualifying race, calls Claude with web_search to look up the
 * course profile, then updates the races table.
 *
 * Body:
 *   secret    string   — must match ADMIN_SECRET
 *   dry_run   boolean  — if true, shows what would be fetched without writing
 *   race_id   string   — optional: backfill only this race (for testing)
 *
 * Returns:
 *   { ok: true, updated: number, skipped: number, results: [...] }
 *
 * Safe to run multiple times — only targets races with null elevation_gain_feet.
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export const maxDuration = 300; // 5 minutes — may need to search many races

type CourseData = {
  elevation_gain_feet: number | null;
  elevation_loss_feet: number | null;
  race_altitude_ft: number | null;
  trail_subtype: "groomed" | "mixed" | "technical" | "highly_technical" | null;
  confidence: "high" | "medium" | "low";
  source_note: string | null;
};

/**
 * Uses Claude Sonnet + web_search to look up the course profile for a named race.
 * Falls back gracefully if the race is too obscure to find.
 */
async function fetchCourseProfile(
  raceName: string,
  goalDistanceMiles: number | null,
  terrainType: string | null
): Promise<CourseData | null> {
  const distLabel = goalDistanceMiles
    ? `${goalDistanceMiles} mile`
    : "";
  const query = `${raceName} ${distLabel} race course elevation profile total gain altitude`.trim();

  try {
    const searchResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages: [{
        role: "user",
        content: `Search for the course profile of "${raceName}"${distLabel ? ` (${distLabel})` : ""}.
Find: total elevation gain in feet, total descent in feet, starting altitude in feet (if a mountain race), and terrain character.
After searching, summarize what you found in 2-3 sentences covering those numbers.`,
      }],
    });

    // Extract the text response (after web search tool use blocks)
    const textBlocks = searchResponse.content.filter(b => b.type === "text");
    const lastToolIdx = (() => {
      let idx = -1;
      for (let i = 0; i < searchResponse.content.length; i++) {
        const b = searchResponse.content[i];
        if (b.type === "server_tool_use" || b.type === "web_search_tool_result" || b.type === "tool_use") {
          idx = i;
        }
      }
      return idx;
    })();
    const responseText = searchResponse.content
      .slice(lastToolIdx + 1)
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join(" ")
      .trim();

    if (!responseText) {
      // Web search may not have fired (no results or not a named race)
      const fallbackText = textBlocks.map(b => (b as { type: "text"; text: string }).text).join(" ").trim();
      if (!fallbackText) return null;
    }

    const summaryText = responseText || textBlocks.map(b => (b as { type: "text"; text: string }).text).join(" ").trim();

    // Haiku extraction pass — structured course data from the summary
    const extractResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `Extract course profile data from a race description. Only extract values explicitly stated — do not estimate or infer. Use null for anything not clearly mentioned.

trail_subtype classification:
- groomed: fire roads, well-maintained singletrack, minimal technical sections
- mixed: standard dirt trail, moderate rocks/roots, typical trail race terrain
- technical: rocky, rooty, requires careful footing, exposed ridges
- highly_technical: sustained scrambling, extreme terrain, alpine routes

confidence:
- high: specific numbers found from official race sources
- medium: approximate numbers from race reports or unofficial sources
- low: very little data found, numbers are rough estimates`,
      messages: [{
        role: "user",
        content: `Race: ${raceName}\nDescription: ${summaryText}`,
      }],
      tools: [{
        name: "save_course_data",
        description: "Save the extracted course profile data",
        input_schema: {
          type: "object" as const,
          properties: {
            elevation_gain_feet: {
              type: ["number", "null"],
              description: "Total elevation gain in feet. Null if not found.",
            },
            elevation_loss_feet: {
              type: ["number", "null"],
              description: "Total elevation loss/descent in feet. Often equals gain for loops. Null if not found.",
            },
            race_altitude_ft: {
              type: ["number", "null"],
              description: "Starting or peak altitude in feet. Only for mountain races. Null if not mentioned.",
            },
            trail_subtype: {
              type: ["string", "null"],
              enum: ["groomed", "mixed", "technical", "highly_technical", null],
              description: "Trail terrain character.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "How confident is the extracted data.",
            },
            source_note: {
              type: ["string", "null"],
              description: "Brief note on the data source (e.g. 'official race website', 'race report').",
            },
          },
          required: ["confidence"],
        },
      }],
      tool_choice: { type: "tool" as const, name: "save_course_data" },
    });

    const toolBlock = extractResponse.content.find(
      b => b.type === "tool_use" && b.name === "save_course_data"
    );
    if (!toolBlock || toolBlock.type !== "tool_use") return null;

    const data = toolBlock.input as CourseData;
    // Only return if we actually found something useful
    if (!data.elevation_gain_feet && !data.race_altitude_ft) return null;
    return data;
  } catch (err) {
    console.error(`[backfill-race-courses] search failed for "${raceName}":`, err);
    return null;
  }
}

export async function POST(request: Request) {
  let body: { secret?: string; dry_run?: boolean; race_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { secret, dry_run = false, race_id } = body;

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Step 1: find upcoming races with missing elevation data
  let racesQuery = supabase
    .from("races")
    .select("id, race_name, goal, goal_distance_miles, user_id")
    .is("elevation_gain_feet", null)
    .not("race_name", "is", null)
    .gt("race_date", new Date().toISOString().split("T")[0]!) // upcoming races only
    .order("race_date", { ascending: true });

  if (race_id) {
    racesQuery = racesQuery.eq("id", race_id);
  }

  const { data: races, error } = await racesQuery;

  if (error) {
    console.error("[backfill-race-courses] query error:", error);
    return NextResponse.json({ error: "DB error", detail: error.message }, { status: 500 });
  }

  if (!races || races.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, skipped: 0, results: [] });
  }

  // Step 2: fetch terrain types for the affected users
  const userIds = [...new Set(races.map(r => r.user_id as string).filter(Boolean))];
  const { data: profiles } = await supabase
    .from("training_profiles")
    .select("user_id, terrain_type")
    .in("user_id", userIds);

  const terrainByUser = new Map<string, string | null>(
    (profiles ?? []).map(p => [p.user_id as string, p.terrain_type as string | null])
  );

  // Filter to trail/mixed terrain only (unless a specific race_id was requested)
  const qualifying = race_id
    ? races
    : races.filter(r => {
        const terrain = terrainByUser.get(r.user_id as string) ?? null;
        return terrain === "trail" || terrain === "mixed";
      });

  console.log(`[backfill-race-courses] ${dry_run ? "DRY RUN — " : ""}${qualifying.length} races to process`);

  let updated = 0;
  let skipped = 0;
  const results: {
    id: string;
    race_name: string;
    status: string;
    data?: Partial<CourseData>;
  }[] = [];

  for (const race of qualifying) {
    const raceName = race.race_name as string;
    const terrainType = terrainByUser.get(race.user_id as string) ?? null;

    console.log(`[backfill-race-courses] searching: "${raceName}"`);

    if (dry_run) {
      results.push({ id: race.id, race_name: raceName, status: "dry_run_would_search" });
      updated++;
      continue;
    }

    const courseData = await fetchCourseProfile(
      raceName,
      race.goal_distance_miles as number | null,
      terrainType
    );

    if (!courseData) {
      skipped++;
      results.push({ id: race.id, race_name: raceName, status: "not_found" });
      console.log(`[backfill-race-courses] no data found for "${raceName}"`);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const updatePayload: Record<string, unknown> = {};
    if (courseData.elevation_gain_feet != null) updatePayload.elevation_gain_feet = courseData.elevation_gain_feet;
    if (courseData.elevation_loss_feet != null) updatePayload.elevation_loss_feet = courseData.elevation_loss_feet;
    if (courseData.race_altitude_ft != null) updatePayload.race_altitude_ft = courseData.race_altitude_ft;
    if (courseData.trail_subtype != null) updatePayload.trail_subtype = courseData.trail_subtype;

    const { error: updateErr } = await supabase
      .from("races")
      .update(updatePayload)
      .eq("id", race.id);

    if (updateErr) {
      console.error(`[backfill-race-courses] update failed for ${race.id}:`, updateErr);
      skipped++;
      results.push({ id: race.id, race_name: raceName, status: "update_error" });
    } else {
      updated++;
      results.push({
        id: race.id,
        race_name: raceName,
        status: `updated (${courseData.confidence})`,
        data: {
          elevation_gain_feet: courseData.elevation_gain_feet,
          elevation_loss_feet: courseData.elevation_loss_feet,
          race_altitude_ft: courseData.race_altitude_ft,
          trail_subtype: courseData.trail_subtype,
        },
      });
      console.log(`[backfill-race-courses] updated "${raceName}":`, updatePayload, `(${courseData.confidence}, ${courseData.source_note ?? "no source"})`);
    }

    // 2 second gap between races to avoid Anthropic rate limits
    if (updated + skipped < qualifying.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return NextResponse.json({ ok: true, updated, skipped, results });
}
