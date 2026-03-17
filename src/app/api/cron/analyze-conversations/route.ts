import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * GET /api/cron/analyze-conversations
 * Runs daily. Fetches yesterday's conversations, analyzes them with Claude for
 * coaching errors / user complaints / hallucinations, and emails a digest.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const toEmail = process.env.ANALYSIS_EMAIL_TO;
  if (!toEmail) {
    console.error("[analyze-conversations] ANALYSIS_EMAIL_TO not set");
    return NextResponse.json({ error: "ANALYSIS_EMAIL_TO not configured" }, { status: 500 });
  }

  // Yesterday window in UTC
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const dateLabel = dayStart.toISOString().slice(0, 10);

  // Fetch all conversations from yesterday, with user phone for context
  const { data: messages, error } = await supabase
    .from("conversations")
    .select("user_id, role, content, message_type, created_at")
    .gte("created_at", dayStart.toISOString())
    .lte("created_at", dayEnd.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[analyze-conversations] DB error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!messages || messages.length === 0) {
    console.log(`[analyze-conversations] No conversations on ${dateLabel}, skipping email`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Group by user
  const byUser: Record<string, typeof messages> = {};
  for (const msg of messages) {
    if (!byUser[msg.user_id]) byUser[msg.user_id] = [];
    byUser[msg.user_id].push(msg);
  }

  // Format transcripts
  const transcripts = Object.entries(byUser)
    .map(([userId, msgs]) => {
      const lines = msgs.map((m) => {
        const time = new Date(m.created_at ?? Date.now()).toISOString().slice(11, 16);
        const label =
          m.role === "user"
            ? "Athlete"
            : `Coach Dean (${m.message_type ?? "response"})`;
        return `[${time}] ${label}: ${m.content}`;
      });
      return `=== User ${userId.slice(0, 8)} ===\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const userCount = Object.keys(byUser).length;

  // Analyze with Claude
  const analysisPrompt = `You are reviewing coaching conversations from an AI running coach called Coach Dean.
Analyze the transcripts below from ${dateLabel} (${userCount} users, ${messages.length} messages total) and identify any issues.

Look for:
1. **Coaching errors** — wrong paces, wrong distances, contradicting previous messages, bad advice
2. **Data hallucinations** — Coach Dean referencing splits/HR/laps it doesn't have, inventing specific numbers
3. **User complaints or corrections** — athlete saying "that's wrong", "no I said", "that's not right", expressing confusion
4. **Onboarding friction** — users getting stuck, repeating themselves, giving up
5. **Positive patterns** — interactions that went really well and should be preserved
6. **Suggested improvements** — specific prompt or logic changes that would fix the issues found

For each issue, include:
- A short title
- Severity: P0 (breaking), P1 (fix soon), P2 (nice to have)
- The relevant transcript excerpt (quote directly)
- What went wrong and why
- A suggested fix

Be specific. If there are no issues, say so clearly.

Format your response as HTML suitable for an email body (use <h2>, <h3>, <p>, <blockquote>, <ul> tags). Start with a one-paragraph executive summary.

TRANSCRIPTS:
${transcripts}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: analysisPrompt }],
  });

  const analysisHtml =
    response.content[0].type === "text" ? response.content[0].text : "<p>Analysis unavailable.</p>";

  // Send email
  const { error: emailError } = await resend.emails.send({
    from: "Coach Dean <noreply@coachdean.ai>",
    to: toEmail,
    subject: `Coach Dean — Conversation Analysis ${dateLabel} (${userCount} users)`,
    html: `
      <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #1a1a1a;">
        <h1 style="font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px;">
          Coach Dean · Daily Conversation Analysis · ${dateLabel}
        </h1>
        <p style="color: #6b7280; font-size: 13px;">
          ${userCount} users · ${messages.length} messages · analyzed with Claude Opus
        </p>
        ${analysisHtml}
        <hr style="margin-top: 40px; border: none; border-top: 1px solid #e5e7eb;" />
        <p style="color: #9ca3af; font-size: 11px;">
          Generated by /api/cron/analyze-conversations · ${now.toISOString()}
        </p>
      </div>
    `,
  });

  if (emailError) {
    console.error("[analyze-conversations] Email send failed:", emailError);
    return NextResponse.json({ error: "Email failed", detail: emailError }, { status: 500 });
  }

  console.log(`[analyze-conversations] Analysis email sent for ${dateLabel} to ${toEmail}`);
  return NextResponse.json({ ok: true, date: dateLabel, users: userCount, messages: messages.length });
}
