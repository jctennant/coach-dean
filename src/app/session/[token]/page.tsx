import { notFound } from "next/navigation";
import { verifySessionToken } from "@/lib/session-token";
import { getRoutine, EXERCISES, exercisePosterUrl, hasExerciseImage } from "@/lib/strength-library";
import { supabase } from "@/lib/supabase";
import { ExerciseList } from "./ExerciseList";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const payload = verifySessionToken(token);
  if (!payload) notFound();

  const routine = getRoutine(payload.routineKey);
  if (!routine) notFound();

  const exercises = routine.exerciseIds.map((id) => EXERCISES[id]).filter(Boolean);
  const exerciseImages: Record<string, string | null> = Object.fromEntries(
    exercises.map((ex) => [ex.id, hasExerciseImage(ex.id) ? exercisePosterUrl(ex.id) : null])
  );

  // Fetch any previously completed exercises for this session link.
  const { data: session } = await supabase
    .from("pt_sessions")
    .select("exercises_done")
    .eq("user_id", payload.userId)
    .eq("session_key", payload.sessionKey)
    .maybeSingle();

  const initialDone: string[] = session?.exercises_done ?? [];

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md">
        {/* Header */}
        <div className="px-5 pt-8 pb-4">
          <p className="text-xs font-medium tracking-widest text-gray-400 uppercase">
            Coach Dean
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            {routine.label}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">{routine.note}</p>
        </div>

        <ExerciseList exercises={exercises} exerciseImages={exerciseImages} token={token} initialDone={initialDone} />

        {/* Frequency footer */}
        <div className="border-t border-gray-100 px-5 py-5">
          <p className="text-xs text-gray-400">{routine.frequency}</p>
        </div>
      </div>
    </div>
  );
}
