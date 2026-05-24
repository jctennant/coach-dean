/**
 * POST /api/plan/upload
 *
 * Accepts a training plan as text, image, or PDF.
 * Extracts the raw text and stores it in onboarding_data.plan_context so Coach Dean
 * can reference it conversationally — no structured parsing.
 *
 * Body:
 *   { userId: string, content: string, contentType: 'text' | 'image_base64' | 'pdf_base64' | 'pdf_url', filename?: string }
 *
 * Returns: { ok: true }
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import type { Json } from "@/lib/database.types";
import { computeWeekSessions, type UploadedPlanWeek } from "@/lib/training-plan";

export const maxDuration = 120;

interface UploadRequest {
  userId: string;
  content: string;
  contentType: "text" | "image_base64" | "pdf_base64" | "pdf_url";
  filename?: string;
}

export async function POST(request: Request) {
  let body: UploadRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, content, contentType, filename } = body;

  if (!userId || !content || !contentType) {
    return NextResponse.json({ error: "Missing required fields: userId, content, contentType" }, { status: 400 });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_data, timezone")
    .eq("id", userId)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    let planText: string;

    if (contentType === "image_base64") {
      planText = await extractTextFromImage(content);
    } else if (contentType === "pdf_url" || contentType === "pdf_base64") {
      const base64 = contentType === "pdf_url" ? await fetchPDFAsBase64(content) : content;
      planText = await extractTextFromPDF(base64);
    } else {
      planText = content;
    }

    // Cap at 15KB — enough for any realistic training plan
    const truncated = planText.length > 15_000;
    const storedText = truncated ? planText.slice(0, 15_000) + "\n[truncated]" : planText;

    // Extract all weeks into structured JSON — fire-and-forget, non-fatal if it fails.
    let allWeeks: UploadedPlanWeek[] = [];
    try {
      allWeeks = await extractAllPlanWeeks(storedText);
      console.log(`[plan/upload] extracted ${allWeeks.length} weeks of structured sessions for user ${userId}`);
    } catch (err) {
      console.error("[plan/upload] structured extraction failed (non-fatal):", err);
    }

    const existingData = ((user.onboarding_data as Record<string, unknown>) || {});
    const updatedData: Record<string, unknown> = {
      ...existingData,
      plan_context: storedText,
      plan_filename: filename ?? null,
      has_existing_plan: true,
      plan_uploaded: true,
      ...(allWeeks.length > 0 ? { plan_sessions_all_weeks: allWeeks } : {}),
    };

    await supabase
      .from("users")
      .update({ onboarding_data: updatedData as unknown as Json })
      .eq("id", userId);

    // Seed training_state.weekly_plan_sessions with the current week's sessions so
    // morning_plan and post_run can surface today's specific workout immediately.
    if (allWeeks.length > 0) {
      try {
        const { data: stateRow } = await supabase
          .from("training_state")
          .select("current_week")
          .eq("user_id", userId)
          .maybeSingle();
        const currentWeek = (stateRow?.current_week as number | null) ?? 1;
        const timezone = (user.timezone as string | null) ?? "America/New_York";
        const sessions = computeWeekSessions(allWeeks, currentWeek, timezone);
        if (sessions.length > 0) {
          await supabase
            .from("training_state")
            .upsert(
              { user_id: userId, weekly_plan_sessions: sessions as unknown as Json, updated_at: new Date().toISOString() },
              { onConflict: "user_id" }
            );
          console.log(`[plan/upload] seeded ${sessions.length} sessions for week ${currentWeek} into training_state`);
        }
      } catch (err) {
        console.error("[plan/upload] training_state seed failed (non-fatal):", err);
      }
    }

    console.log(`[plan/upload] stored plan context for user ${userId}${filename ? ` (${filename})` : ""} — ${storedText.length} chars${truncated ? " (truncated)" : ""}`);

    return NextResponse.json({ ok: true });
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

async function fetchPDFAsBase64(pdfUrl: string): Promise<string> {
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`PDF fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

const PDF_CHAR_TOO_LARGE = 200_000;

async function extractTextFromPDF(base64: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const buffer = Buffer.from(base64, "base64");
  const parsed = await pdfParse(buffer) as { text: string; numpages: number };
  const rawText = parsed.text?.trim() ?? "";

  console.log(`[plan/upload] pdf-parse: ${parsed.numpages} pages, ${rawText.length} chars`);

  if (!rawText) {
    throw Object.assign(new Error("pdf_unreadable"), { code: "pdf_unreadable" });
  }

  if (rawText.length > PDF_CHAR_TOO_LARGE) {
    throw Object.assign(new Error("pdf_too_large"), { code: "pdf_too_large" });
  }

  return rawText;
}

async function extractAllPlanWeeks(planText: string): Promise<UploadedPlanWeek[]> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    system: `Extract every training week from this plan and call save_plan_weeks.
For each week include every session with its day of week and a concise label (type + distance/duration + any structure).
Use "Rest" as the label for rest days. Skip weeks with no sessions.
Day must be one of: Mon, Tue, Wed, Thu, Fri, Sat, Sun.`,
    messages: [{ role: "user", content: planText }],
    tools: [{
      name: "save_plan_weeks",
      description: "Save all extracted training weeks.",
      input_schema: {
        type: "object" as const,
        properties: {
          weeks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                week_number: { type: "number" },
                sessions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
                      label: { type: "string" },
                    },
                    required: ["day", "label"],
                  },
                },
              },
              required: ["week_number", "sessions"],
            },
          },
        },
        required: ["weeks"],
      },
    }],
    tool_choice: { type: "tool" as const, name: "save_plan_weeks" },
  });

  const toolBlock = response.content.find(b => b.type === "tool_use" && b.name === "save_plan_weeks");
  if (!toolBlock || toolBlock.type !== "tool_use") return [];
  const input = toolBlock.input as { weeks?: unknown };
  if (!Array.isArray(input.weeks)) return [];
  return input.weeks as UploadedPlanWeek[];
}

async function extractTextFromImage(base64Image: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: base64Image },
        },
        {
          type: "text",
          text: "Transcribe all training plan content from this image. Include all weeks, days, workout types, distances, paces, and any notes. Preserve the structure as closely as possible.",
        },
      ],
    }],
  });

  return response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("\n");
}
