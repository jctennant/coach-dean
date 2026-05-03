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
    .select("id, onboarding_data")
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

    const existingData = ((user.onboarding_data as Record<string, unknown>) || {});
    const updatedData: Record<string, unknown> = {
      ...existingData,
      plan_context: storedText,
      plan_filename: filename ?? null,
      has_existing_plan: true,
      plan_uploaded: true,
    };

    await supabase
      .from("users")
      .update({ onboarding_data: updatedData as unknown as Json })
      .eq("id", userId);

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
