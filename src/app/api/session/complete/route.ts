import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifySessionToken } from "@/lib/session-token";
import { getRoutine } from "@/lib/strength-library";

export async function POST(request: Request) {
  let body: { token?: string; exerciseId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { token, exerciseId } = body;
  if (!token || !exerciseId) {
    return NextResponse.json({ error: "missing token or exerciseId" }, { status: 400 });
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const { routineKey, userId, sessionKey } = payload;
  const routine = getRoutine(routineKey);
  if (!routine) {
    return NextResponse.json({ error: "unknown routine" }, { status: 400 });
  }

  // Fetch or create the session row.
  const { data: existing } = await supabase
    .from("pt_sessions")
    .select("id, exercises_done")
    .eq("user_id", userId)
    .eq("session_key", sessionKey)
    .maybeSingle();

  const prevDone: string[] = existing?.exercises_done ?? [];
  const nextDone = prevDone.includes(exerciseId)
    ? prevDone
    : [...prevDone, exerciseId];

  const allDone = routine.exerciseIds.every((id) => nextDone.includes(id));
  const completedAt = allDone ? new Date().toISOString() : null;

  if (existing) {
    await supabase
      .from("pt_sessions")
      .update({
        exercises_done: nextDone,
        ...(completedAt ? { completed_at: completedAt } : {}),
      })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("pt_sessions")
      .insert({
        user_id: userId,
        routine_key: routineKey,
        session_key: sessionKey,
        exercises_done: nextDone,
        ...(completedAt ? { completed_at: completedAt } : {}),
      });
  }

  return NextResponse.json({ ok: true, completedIds: nextDone, allDone });
}
