"use client";

import { useState, useRef } from "react";

interface ExtractedWeek {
  week_number: number;
  sessions: Array<{
    dayOfWeek: string;
    type: string;
    description: string;
    targetDistanceMiles?: number | null;
  }>;
  total_miles: number;
}

interface PreviewData {
  sessionCount: number;
  weeks: ExtractedWeek[];
}

export function PlanImportForm({ userId }: { userId: string }) {
  const [status, setStatus] = useState<"idle" | "extracting" | "preview" | "saving" | "saved" | "error">("idle");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus("extracting");
    setErrorMsg(null);

    try {
      const base64 = await fileToBase64(file);
      setPendingContent(base64);
      setPendingFilename(file.name);

      // Dry run first — preview without saving
      const res = await fetch("/api/plan/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          content: base64,
          contentType: "image_base64",
          filename: file.name,
          dry_run: true,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setErrorMsg(data.error ?? "Extraction failed. Try a clearer image or paste the plan as text.");
        setStatus("error");
        return;
      }

      if (!data.weeks || data.weeks.length === 0) {
        setErrorMsg("Couldn't find a training plan in that image. Try a screenshot of a weekly schedule.");
        setStatus("error");
        return;
      }

      setPreview({ sessionCount: data.sessions?.length ?? data.sessionCount ?? 0, weeks: data.weeks });
      setStatus("preview");
    } catch {
      setErrorMsg("Something went wrong. Try again.");
      setStatus("error");
    }
  }

  async function handleSave() {
    if (!pendingContent) return;
    setStatus("saving");

    try {
      const res = await fetch("/api/plan/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          content: pendingContent,
          contentType: "image_base64",
          filename: pendingFilename ?? undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error ?? "Save failed. Try again.");
        setStatus("error");
        return;
      }

      setStatus("saved");
    } catch {
      setErrorMsg("Save failed. Try again.");
      setStatus("error");
    }
  }

  function handleReset() {
    setStatus("idle");
    setPreview(null);
    setErrorMsg(null);
    setPendingContent(null);
    setPendingFilename(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (status === "saved") {
    return (
      <div className="mt-4 rounded-lg border border-green-100 bg-green-50 p-4 text-center">
        <p className="text-sm font-semibold text-green-700">Plan imported</p>
        <p className="mt-0.5 text-xs text-green-600">
          {preview ? `${preview.weeks.length} weeks saved. ` : ""}
          Reload the page to see your plan, or text Dean to discuss it.
        </p>
      </div>
    );
  }

  if ((status === "preview" || status === "saving") && preview) {
    const totalMiles = preview.weeks.reduce((sum, w) => sum + w.total_miles, 0);
    const avgMiles = preview.weeks.length > 0 ? Math.round(totalMiles / preview.weeks.length) : 0;

    return (
      <div className="mt-4 space-y-3">
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-semibold text-gray-700 mb-2">Extracted from plan</p>
          <div className="flex gap-4">
            <div>
              <p className="text-lg font-bold tabular-nums text-gray-900">{preview.weeks.length}</p>
              <p className="text-[10px] text-gray-400">weeks</p>
            </div>
            <div>
              <p className="text-lg font-bold tabular-nums text-gray-900">{preview.sessionCount}</p>
              <p className="text-[10px] text-gray-400">sessions</p>
            </div>
            {avgMiles > 0 && (
              <div>
                <p className="text-lg font-bold tabular-nums text-gray-900">~{avgMiles} mi</p>
                <p className="text-[10px] text-gray-400">avg/week</p>
              </div>
            )}
          </div>
          {pendingFilename && (
            <p className="mt-2 text-[10px] text-gray-400 truncate">{pendingFilename}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={status === "saving"}
            className="flex-1 rounded-full bg-gray-900 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {status === "saving" ? "Saving…" : "Save to Dean"}
          </button>
          <button
            onClick={handleReset}
            className="rounded-full border border-gray-200 px-4 py-2.5 text-sm text-gray-500"
          >
            Cancel
          </button>
        </div>
        <p className="text-[10px] text-gray-400 text-center">
          Dean will use this plan as context for your post-run coaching.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      {status === "extracting" && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-4 text-center">
          <p className="text-sm text-gray-500">Reading your plan…</p>
        </div>
      )}

      {status === "error" && (
        <div className="mb-3 rounded-lg border border-red-100 bg-red-50 p-3">
          <p className="text-xs text-red-600">{errorMsg}</p>
          <button onClick={handleReset} className="mt-1 text-xs text-red-500 underline">Try again</button>
        </div>
      )}

      {status === "idle" && (
        <>
          <label className="block cursor-pointer rounded-lg border-2 border-dashed border-gray-200 p-5 text-center hover:border-gray-300 transition-colors">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleFile}
            />
            <p className="text-sm font-medium text-gray-700">Upload a plan screenshot</p>
            <p className="mt-1 text-xs text-gray-400">PNG, JPG, or WebP · Runna, Garmin Coach, printed plans</p>
          </label>
          <p className="mt-2 text-[10px] text-gray-400 text-center">
            Or text Dean: &quot;I&apos;m following Runna&apos;s half plan, week 8 of 16, ~40mi/week&quot;
          </p>
        </>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:image/...;base64, prefix
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to read file"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
