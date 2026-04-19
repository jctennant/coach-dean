"use client";

import { useState, useRef, useCallback } from "react";

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
  const [pendingContentType, setPendingContentType] = useState<"image_base64" | "pdf_base64">("image_base64");
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [currentWeek, setCurrentWeek] = useState<number>(1);
  const [truncated, setTruncated] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isImage = file.type.startsWith("image/");
    if (!isPDF && !isImage) {
      setErrorMsg("Please upload a PDF or image file.");
      setStatus("error");
      return;
    }

    // Base64 encoding adds ~33% overhead; Vercel's body limit is 4.5MB.
    // Block PDFs over 3MB to stay safely under that limit.
    if (isPDF && file.size > 3 * 1024 * 1024) {
      setErrorMsg("This PDF is too large (max 3 MB). Try a screenshot of the plan instead, or text Dean with your plan details.");
      setStatus("error");
      return;
    }

    setStatus("extracting");
    setErrorMsg(null);

    try {
      const base64 = await fileToBase64(file);
      const contentType = isPDF ? "pdf_base64" : "image_base64";
      setPendingContent(base64);
      setPendingContentType(contentType);
      setPendingFilename(file.name);

      const res = await fetch("/api/plan/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          content: base64,
          contentType,
          filename: file.name,
          dry_run: true,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setErrorMsg(data.message ?? "Extraction failed. Try a clearer image or a text description instead.");
        setStatus("error");
        return;
      }

      if (!data.weeks || data.weeks.length === 0) {
        setErrorMsg("Couldn't find a training plan in that file. Try a screenshot of a weekly schedule or paste the plan as text.");
        setStatus("error");
        return;
      }

      setTruncated(data.truncated ?? false);
      setPreview({ sessionCount: data.sessions?.length ?? data.sessionCount ?? 0, weeks: data.weeks });
      setStatus("preview");
    } catch {
      setErrorMsg("Something went wrong. Try again.");
      setStatus("error");
    }
  }, [userId]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await processFile(file);
  }

  async function handleSave() {
    if (!preview) return;
    setStatus("saving");

    try {
      const res = await fetch("/api/plan/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          content: "",
          contentType: pendingContentType,
          filename: pendingFilename ?? undefined,
          currentWeek,
          preExtractedWeeks: preview.weeks,
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
    setCurrentWeek(1);
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
          <p className="mt-1 text-[10px] text-gray-400">Values are approximate — ranges in the plan may vary slightly each read.</p>
          {truncated && (
            <p className="mt-2 text-[10px] text-amber-600">PDF was very large — only the first portion was read. Check that all your weeks imported correctly.</p>
          )}
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 flex items-center justify-between gap-3">
          <label className="text-xs text-gray-600 shrink-0">Which week are you on?</label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentWeek(w => Math.max(1, w - 1))}
              className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 text-sm leading-none"
            >−</button>
            <span className="w-24 text-center text-sm font-semibold tabular-nums text-gray-900 whitespace-nowrap">
              Week {currentWeek} of {preview.weeks.length}
            </span>
            <button
              onClick={() => setCurrentWeek(w => Math.min(preview.weeks.length, w + 1))}
              className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 text-sm leading-none"
            >+</button>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={status === "saving"}
            className="flex-1 rounded-full bg-gray-900 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {status === "saving" ? "Saving…" : "Share with Coach Dean"}
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
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-6 text-center">
          <div className="flex justify-center mb-3">
            <svg className="animate-spin h-6 w-6 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-600">Reading your plan…</p>
          <p className="mt-1 text-xs text-gray-400">This usually takes 10–20 seconds</p>
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
          <label
            className={`block cursor-pointer rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
              isDragOver ? "border-gray-400 bg-gray-50" : "border-gray-200 hover:border-gray-300"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleFile}
            />
            <p className="text-sm font-medium text-gray-700">
              {isDragOver ? "Drop to upload" : "Upload your plan"}
            </p>
            <p className="mt-1 text-xs text-gray-400">PDF or screenshot · drag & drop or click to browse</p>
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
