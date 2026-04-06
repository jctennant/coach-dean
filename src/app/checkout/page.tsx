"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function CheckoutContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [loading, setLoading] = useState<"monthly" | "annual" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(plan: "monthly" | "annual") {
    setLoading(plan);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, plan }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setLoading(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + 7);
  const trialEndFormatted = trialEndDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 py-16">
      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Your plan is ready</h1>
          <p className="mt-3 text-gray-500">
            Start your free 7-day trial — no charge until {trialEndFormatted}. Cancel anytime.
          </p>
        </div>

        {/* Plans */}
        <div className="space-y-3">
          {/* Annual */}
          <button
            onClick={() => startCheckout("annual")}
            disabled={loading !== null}
            className="w-full relative border-2 border-black rounded-xl p-5 text-left hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="absolute -top-3 left-4">
              <span className="bg-black text-white text-xs font-semibold px-2 py-1 rounded-full">
                Best value
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900">Annual</p>
                <p className="text-sm text-gray-500 mt-0.5">$120/year — billed once a year</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">$10</p>
                <p className="text-xs text-gray-500">per month</p>
              </div>
            </div>
            {loading === "annual" && (
              <p className="mt-2 text-sm text-gray-500">Redirecting to checkout…</p>
            )}
          </button>

          {/* Monthly */}
          <button
            onClick={() => startCheckout("monthly")}
            disabled={loading !== null}
            className="w-full border border-gray-200 rounded-xl p-5 text-left hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900">Monthly</p>
                <p className="text-sm text-gray-500 mt-0.5">Billed monthly — cancel anytime</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">$20</p>
                <p className="text-xs text-gray-500">per month</p>
              </div>
            </div>
            {loading === "monthly" && (
              <p className="mt-2 text-sm text-gray-500">Redirecting to checkout…</p>
            )}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-600 text-center">{error}</p>
        )}

        {/* Fine print */}
        <p className="text-xs text-gray-400 text-center">
          Your 7-day free trial starts today. You won&apos;t be charged until {trialEndFormatted}.
          Cancel any time — before or after the trial — by texting &ldquo;cancel&rdquo; to Coach Dean or visiting coachdean.ai/cancel.
        </p>
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutContent />
    </Suspense>
  );
}
