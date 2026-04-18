/**
 * POST /api/plan/upload
 *
 * Accepts a training plan in text, image, or (future) PDF format.
 * Uses Claude to extract structured sessions and stores them in training_plans
 * with plan_source='uploaded'.
 *
 * Body:
 *   { userId: string, content: string, contentType: 'text' | 'image_base64', filename?: string }
 *
 * Returns: { ok: true, sessionCount: number, weeks: number }
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export const maxDuration = 120; // PDF path: fetch + Sonnet doc API + Haiku structure = ~90s for large files

interface UploadRequest {
  userId: string;
  /** Text content, base64-encoded image, base64-encoded PDF, or a URL (for pdf_url) */
  content: string;
  contentType: "text" | "image_base64" | "pdf_base64" | "pdf_url";
  filename?: string;
  /** Dry run — extract and return plan without saving */
  dry_run?: boolean;
  /** Which week the user is currently on (1-indexed). Defaults to 1. */
  currentWeek?: number;
}

interface ExtractedSession {
  dayOfWeek: string;                          // "Monday"
  weekNumber: number;                         // 1-indexed
  type: string;                               // "easy" | "tempo" | "long" | "interval" | "recovery" | "off" | "cross"
  targetDistanceMiles?: number | null;        // midpoint — used for calculations
  targetDistanceMilesMin?: number | null;     // low end of range (null if no range given)
  targetDistanceMilesMax?: number | null;     // high end of range (null if no range given)
  targetPace?: string | null;                 // "9:30/mi" or "4:30/km"
  description: string;                        // preserves range language: "Easy 4–8mi" | "6–10×800m at 5k pace"
}

interface PlanWeek {
  week_number: number;
  sessions: ExtractedSession[];
  total_miles: number;       // midpoint sum — used for calculations and progress bars
  total_miles_min?: number;  // sum of session minimums — shown in dashboard range display
  total_miles_max?: number;  // sum of session maximums — shown in dashboard range display
}

export async function POST(request: Request) {
  let body: UploadRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, content, contentType, filename, dry_run = false, currentWeek = 1 } = body;

  if (!userId || !content || !contentType) {
    return NextResponse.json({ error: "Missing required fields: userId, content, contentType" }, { status: 400 });
  }

  // Verify user exists
  const { data: user } = await supabase
    .from("users")
    .select("id, phone_number")
    .eq("id", userId)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    let truncated = false;
    let sessions: ExtractedSession[];

    if (contentType === "image_base64") {
      sessions = await extractFromImage(content);
    } else if (contentType === "pdf_url" || contentType === "pdf_base64") {
      const result = contentType === "pdf_url"
        ? await extractFromPDF(content)
        : await extractFromPDFBase64(content);
      sessions = result.sessions;
      truncated = result.truncated;
    } else {
      sessions = await extractFromText(content);
    }

    if (sessions.length === 0) {
      return NextResponse.json({ error: "Could not extract any training sessions from the provided content." }, { status: 422 });
    }

    // Group sessions into weeks
    const weekMap: Record<number, ExtractedSession[]> = {};
    for (const session of sessions) {
      if (!weekMap[session.weekNumber]) weekMap[session.weekNumber] = [];
      weekMap[session.weekNumber].push(session);
    }

    const weeks: PlanWeek[] = Object.entries(weekMap)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([weekNum, weekSessions]) => {
        const midpointMiles = weekSessions.reduce((sum, s) => sum + (s.targetDistanceMiles ?? 0), 0);
        const minMiles = weekSessions.reduce((sum, s) => sum + (s.targetDistanceMilesMin ?? s.targetDistanceMiles ?? 0), 0);
        const maxMiles = weekSessions.reduce((sum, s) => sum + (s.targetDistanceMilesMax ?? s.targetDistanceMiles ?? 0), 0);
        const hasRange = Math.abs(maxMiles - minMiles) > 0.5;
        return {
          week_number: parseInt(weekNum),
          sessions: weekSessions,
          total_miles: Math.round(midpointMiles * 10) / 10,
          ...(hasRange ? {
            total_miles_min: Math.round(minMiles * 10) / 10,
            total_miles_max: Math.round(maxMiles * 10) / 10,
          } : {}),
        };
      });

    if (dry_run) {
      return NextResponse.json({ ok: true, sessions, weeks, sessionCount: sessions.length, truncated });
    }

    // Store in training_plans — no unique constraint on user_id, so select+update/insert
    const { data: existingPlan } = await supabase
      .from("training_plans")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const planPayload = {
      plan_source: "uploaded" as const,
      raw_plan_text: content.slice(0, 10000), // cap stored text at 10KB (URL for pdf_url)
      total_weeks: weeks.length,
      weeks: weeks as unknown as import("@/lib/database.types").Json,
      updated_at: new Date().toISOString(),
    };

    const { error: planError } = existingPlan
      ? await supabase.from("training_plans").update(planPayload).eq("id", existingPlan.id)
      : await supabase.from("training_plans").insert({ user_id: userId, ...planPayload });

    if (planError) {
      console.error("[plan/upload] training_plans save failed:", planError);
      return NextResponse.json({ error: "Failed to save plan" }, { status: 500 });
    }

    // Set training_state to the user's current week.
    const targetWeekNum = Math.max(1, Math.min(currentWeek, weeks.length));
    const week1 = weeks.find(w => w.week_number === targetWeekNum);
    if (week1) {
      const DAY_OFFSETS: Record<string, number> = {
        monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
      };
      const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      // Use UTC arithmetic so the Monday anchor is timezone-independent.
      // server.getDay() is local time — on a UTC server, a user uploading at 11pm
      // US/Eastern would get a Monday that's one day off.
      const now = new Date();
      const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon, ...
      const daysFromMonday = utcDay === 0 ? 6 : utcDay - 1;
      const thisMonday = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday,
      ));

      const week1Sessions = week1.sessions
        .filter(s => s.type !== "off")
        .map(s => {
          const offset = DAY_OFFSETS[s.dayOfWeek.toLowerCase()] ?? 0;
          const d = new Date(thisMonday);
          d.setUTCDate(thisMonday.getUTCDate() + offset);
          const distPart = s.targetDistanceMiles ? ` ${s.targetDistanceMiles}mi` : "";
          const pacePart = s.targetPace ? ` @ ${s.targetPace}` : "";
          return {
            day: DAY_SHORT[offset],
            date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
            label: `${s.description}${distPart}${pacePart}`,
            optional: false,
          };
        });

      const week1StartStr = `${thisMonday.getUTCFullYear()}-${String(thisMonday.getUTCMonth() + 1).padStart(2, "0")}-${String(thisMonday.getUTCDate()).padStart(2, "0")}`;

      await supabase.from("training_state").upsert({
        user_id: userId,
        current_week: targetWeekNum,
        current_phase: "base",
        taper_peak_miles: null,
        week1_start_date: week1StartStr,
        weekly_mileage_target: week1.total_miles || null,
        weekly_plan_sessions: week1Sessions as unknown as import("@/lib/database.types").Json,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    }

    // Update training_profiles to reflect that user has an existing plan
    await supabase.from("training_profiles")
      .update({ updated_at: new Date().toISOString() })
      .eq("user_id", userId);

    console.log(`[plan/upload] saved ${sessions.length} sessions across ${weeks.length} weeks for user ${userId}${filename ? ` (${filename})` : ""}`);

    return NextResponse.json({
      ok: true,
      sessionCount: sessions.length,
      weeks: weeks.length,
      truncated,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "pdf_unreadable") {
      return NextResponse.json({
        error: "pdf_unreadable",
        message: "This PDF doesn't have a readable text layer — it may be a scanned image. Can you paste your plan as text, or describe it in a few sentences?",
      }, { status: 422 });
    }
    if (code === "pdf_too_large") {
      return NextResponse.json({
        error: "pdf_too_large",
        message: "This PDF is too large to read automatically. Can you paste your plan as text, or give me a quick description — which days you run, weekly mileage, and any key workouts?",
      }, { status: 422 });
    }
    console.error("[plan/upload] extraction failed:", err);
    return NextResponse.json({ error: "Plan extraction failed" }, { status: 500 });
  }
}

/**
 * Extract structured sessions from plain text using Claude Haiku.
 */
async function extractFromText(planText: string): Promise<ExtractedSession[]> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `Extract structured training sessions from the training plan text. Call extract_sessions with every session you find.

Rules:
- weekNumber: 1-indexed. If the plan doesn't explicitly number weeks, infer from context (e.g., "Week 1", "Mon Jan 6 - Sun Jan 12").
- dayOfWeek: full name (Monday, Tuesday, etc.)
- type: "easy" | "tempo" | "long" | "interval" | "recovery" | "off" | "cross"
- Distance ranges (e.g. "4-8 miles", "6–10 km"):
  - targetDistanceMilesMin: the low end, converted to miles
  - targetDistanceMilesMax: the high end, converted to miles
  - targetDistanceMiles: the midpoint ((min+max)/2), rounded to 1 decimal
  - If a single distance is given (no range), set all three to the same value
  - Null for cross-training and off days
- targetPace: extract if specified (e.g. "9:30/mi", "4:30/km"). Null if not specified.
- description: preserve range language exactly as written (e.g. "Easy 4–8mi" not "Easy 6mi"). For intervals, preserve the rep range (e.g. "6–10×800m at 5k pace").
- Extract ALL sessions including rest days (type: "off") and cross-training.
- If a session has a total distance AND individual segments, use the total.`,
    messages: [{ role: "user", content: `Training plan:\n\n${planText}` }],
    tools: [{
      name: "extract_sessions",
      description: "Save the extracted training sessions",
      input_schema: {
        type: "object" as const,
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                weekNumber: { type: "number" },
                dayOfWeek: { type: "string" },
                type: { type: "string", enum: ["easy", "tempo", "long", "interval", "recovery", "off", "cross"] },
                targetDistanceMiles: { type: ["number", "null"] },
                targetDistanceMilesMin: { type: ["number", "null"] },
                targetDistanceMilesMax: { type: ["number", "null"] },
                targetPace: { type: ["string", "null"] },
                description: { type: "string" },
              },
              required: ["weekNumber", "dayOfWeek", "type", "description"],
            },
          },
        },
        required: ["sessions"],
      },
    }],
    tool_choice: { type: "tool" as const, name: "extract_sessions" },
  });

  const toolBlock = response.content.find(b => b.type === "tool_use" && b.name === "extract_sessions");
  if (toolBlock?.type === "tool_use") {
    const input = toolBlock.input as { sessions: ExtractedSession[] };
    return input.sessions ?? [];
  }
  return [];
}

interface PDFExtractionResult {
  sessions: ExtractedSession[];
  truncated: boolean;
}

// 100k chars fits comfortably in gpt-4o's 128k token context.
// 200k chars means we'd lose >50% — surface the fallback prompt instead.
const PDF_CHAR_TRUNCATE = 100_000;
const PDF_CHAR_TOO_LARGE = 200_000;

async function extractFromPDFBase64(base64: string): Promise<PDFExtractionResult> {
  return extractFromPDFData(base64);
}

async function extractFromPDF(pdfUrl: string): Promise<PDFExtractionResult> {
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`PDF fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return extractFromPDFData(base64);
}

async function extractFromPDFData(base64: string): Promise<PDFExtractionResult> {
  // The shim (anthropic.ts) runs pdf-parse when on OpenAI. On Anthropic native, the
  // document block is sent directly. We pre-parse here to measure size and apply limits.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const buffer = Buffer.from(base64, "base64");
  const parsed = await pdfParse(buffer) as { text: string; numpages: number };
  const rawText = parsed.text?.trim() ?? "";

  console.log(`[plan/upload] pdf-parse: ${parsed.numpages} pages, ${rawText.length} chars`);

  if (!rawText) {
    // Image-based / encrypted PDF — no text layer
    throw Object.assign(new Error("pdf_unreadable"), { code: "pdf_unreadable" });
  }

  if (rawText.length > PDF_CHAR_TOO_LARGE) {
    // Would lose >50% of the plan — ask the user instead
    throw Object.assign(new Error("pdf_too_large"), { code: "pdf_too_large" });
  }

  const truncated = rawText.length > PDF_CHAR_TRUNCATE;
  const text = truncated ? rawText.slice(0, PDF_CHAR_TRUNCATE) : rawText;

  if (truncated) {
    console.log(`[plan/upload] PDF truncated: ${rawText.length} → ${PDF_CHAR_TRUNCATE} chars`);
  }

  // Send pre-extracted text via the regular text extraction path (avoids double pdf-parse in shim)
  const sessions = await extractFromText(text);
  return { sessions, truncated };
}

/**
 * Extract structured sessions from an image (screenshot or photo) using Claude Sonnet vision.
 */
async function extractFromImage(base64Image: string): Promise<ExtractedSession[]> {
  // First, use Sonnet to OCR + extract text from the image
  const visionResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: base64Image,
          },
        },
        {
          type: "text",
          text: "Extract all training sessions from this training plan image. List every session with its week number, day, workout type, distance, pace targets, and description. Format as structured text.",
        },
      ],
    }],
  });

  const extractedText = visionResponse.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("\n");

  // Then run the same text extraction on the result
  return extractFromText(extractedText);
}
