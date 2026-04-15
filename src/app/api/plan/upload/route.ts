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

export const maxDuration = 60;

interface UploadRequest {
  userId: string;
  /** Text content, base64-encoded image, or a URL (for pdf_url) */
  content: string;
  contentType: "text" | "image_base64" | "pdf_url";
  filename?: string;
  /** Dry run — extract and return plan without saving */
  dry_run?: boolean;
}

interface ExtractedSession {
  dayOfWeek: string;       // "Monday"
  weekNumber: number;      // 1-indexed
  type: string;            // "easy" | "tempo" | "long" | "interval" | "recovery" | "off" | "cross"
  targetDistanceMiles?: number | null;
  targetPace?: string | null;     // "9:30/mi" or "4:30/km"
  description: string;     // "Easy aerobic run" | "6×800m intervals" etc.
}

interface PlanWeek {
  week_number: number;
  sessions: ExtractedSession[];
  total_miles: number;
}

export async function POST(request: Request) {
  let body: UploadRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, content, contentType, filename, dry_run = false } = body;

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
    const sessions = contentType === "image_base64"
      ? await extractFromImage(content)
      : contentType === "pdf_url"
      ? await extractFromPDF(content)
      : await extractFromText(content);

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
      .map(([weekNum, weekSessions]) => ({
        week_number: parseInt(weekNum),
        sessions: weekSessions,
        total_miles: weekSessions.reduce((sum, s) => sum + (s.targetDistanceMiles ?? 0), 0),
      }));

    if (dry_run) {
      return NextResponse.json({ ok: true, sessions, weeks, sessionCount: sessions.length });
    }

    // Store in training_plans
    const { error: planError } = await supabase.from("training_plans").upsert(
      {
        user_id: userId,
        plan_source: "uploaded",
        raw_plan_text: content.slice(0, 10000), // cap stored text at 10KB
        total_weeks: weeks.length,
        // Store sessions in the weeks JSON array — each week has sessions array
        weeks: weeks as unknown as import("@/lib/database.types").Json,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (planError) {
      console.error("[plan/upload] training_plans upsert failed:", planError);
      return NextResponse.json({ error: "Failed to save plan" }, { status: 500 });
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
    });
  } catch (err) {
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
- targetDistanceMiles: convert km to miles if needed (1 km = 0.621 mi). Null for cross-training and off days.
- targetPace: extract if specified (e.g. "9:30/mi", "4:30/km"). Null if not specified.
- description: concise session description preserving the key details (pace targets, interval structure, etc.)
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

/**
 * Extract structured sessions from a PDF URL using Claude's document API.
 * Fetches the PDF, converts to base64, passes to Claude as a document block.
 */
async function extractFromPDF(pdfUrl: string): Promise<ExtractedSession[]> {
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`PDF fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const docResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: base64,
          },
        } as unknown as { type: "text"; text: string },
        {
          type: "text",
          text: "Extract all training sessions from this training plan PDF. List every session with its week number, day, workout type, distance, pace targets, and description. Format as structured text.",
        },
      ],
    }],
  });

  const extractedText = docResponse.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("\n");

  return extractFromText(extractedText);
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
