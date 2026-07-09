"use client";

import { useState } from "react";

interface Exercise {
  id: string;
  name: string;
  specs: string;
  cue: string;
}

interface Props {
  exercises: Exercise[];
  routineKey: string;
  token: string;
  today: string; // YYYY-MM-DD
  initialDone: string[];
}

export function ExerciseSection({ exercises, routineKey, token, today, initialDone }: Props) {
  const [done, setDone] = useState<Set<string>>(new Set(initialDone));

  async function markDone(exerciseId: string) {
    if (done.has(exerciseId)) return;
    setDone((prev) => new Set([...prev, exerciseId]));
    try {
      await fetch("/api/session/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, exerciseId, routineKey, date: today }),
      });
    } catch {
      setDone((prev) => {
        const next = new Set(prev);
        next.delete(exerciseId);
        return next;
      });
    }
  }

  const doneCount = exercises.filter((ex) => done.has(ex.id)).length;
  const allDone = doneCount === exercises.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">Exercises</p>
        {doneCount > 0 && (
          <p className="text-xs text-gray-400">{doneCount} / {exercises.length} done today</p>
        )}
      </div>

      <div className="space-y-3">
        {exercises.map((ex, i) => {
          const isDone = done.has(ex.id);
          return (
            <button
              key={ex.id}
              onClick={() => markDone(ex.id)}
              className={`w-full text-left rounded-xl border p-4 transition-all ${
                isDone ? "border-green-200 bg-green-50" : "border-gray-100 bg-white active:bg-gray-50"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isDone ? "border-green-500 bg-green-500" : "border-gray-300"
                }`}>
                  {isDone && (
                    <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-mono text-gray-300 shrink-0">{i + 1}</span>
                    <p className={`font-semibold text-sm ${isDone ? "text-green-700" : "text-gray-900"}`}>
                      {ex.name}
                    </p>
                  </div>
                  <p className={`text-xs mt-0.5 ${isDone ? "text-green-600" : "text-gray-500"}`}>{ex.specs}</p>
                  <p className={`text-xs mt-1 italic leading-relaxed ${isDone ? "text-green-500" : "text-gray-400"}`}>{ex.cue}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {allDone && (
        <div className="mt-4 rounded-xl bg-green-50 border border-green-200 px-5 py-4 text-center">
          <p className="font-bold text-green-700">All done</p>
          <p className="text-sm text-green-600 mt-0.5">Nice work. See you next run.</p>
        </div>
      )}
    </div>
  );
}
