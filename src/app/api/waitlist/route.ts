import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const E164_REGEX = /^\+1\d{10}$/;

export async function POST(request: Request) {
  const { phone, name, source } = await request.json();

  if (!phone || !E164_REGEX.test(phone)) {
    return NextResponse.json(
      { error: "Valid US phone number required" },
      { status: 400 }
    );
  }

  // waitlist table is not in generated types yet — cast until next type regen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("waitlist")
    .upsert({ phone_number: phone, name: name || null, source: source || null }, { onConflict: "phone_number" });

  if (error) {
    console.error("[waitlist] insert failed:", error.message);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
