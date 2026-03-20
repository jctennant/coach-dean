import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

/**
 * POST /api/admin/send
 *
 * Send a one-off custom message to a specific user — bypasses the normal
 * coach/respond pipeline. Useful for apologies, corrections, or manual outreach.
 * Protected by ADMIN_SECRET env var.
 *
 * Body:
 *   secret   string   — must match ADMIN_SECRET
 *   userId   string   — user UUID from the users table
 *   message  string   — the text to send (use \n\n to split into multiple bubbles)
 *   dry_run  boolean  — if true, returns the message without sending (default false)
 */
export async function POST(request: Request) {
  const { secret, userId, message, dry_run = false } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("id, phone_number, name")
    .eq("id", userId)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Split on blank lines so each paragraph becomes a separate SMS bubble
  const parts = message.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  if (dry_run) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      to: user.phone_number,
      name: user.name,
      parts,
      bubble_count: parts.length,
    });
  }

  const sentParts: string[] = [];
  for (const part of parts) {
    await sendSMS(user.phone_number, part);
    await supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: part,
      message_type: "user_message",
    });
    sentParts.push(part);
    if (parts.indexOf(part) < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  console.log(`[admin/send] sent ${sentParts.length} bubble(s) to ${user.name} (${user.phone_number})`);

  return NextResponse.json({ ok: true, sent: sentParts.length, to: user.phone_number, name: user.name });
}
