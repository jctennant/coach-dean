"use client";

import { useState } from "react";
import type { ReactNode } from "react";

export function DashboardTabs({
  overview,
  plan,
}: {
  overview: ReactNode;
  plan: ReactNode;
}) {
  const [tab, setTab] = useState<"overview" | "plan">("overview");

  return (
    <>
      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1 mb-5">
        <button
          onClick={() => setTab("overview")}
          className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${
            tab === "overview"
              ? "bg-white shadow-sm text-gray-900"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setTab("plan")}
          className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${
            tab === "plan"
              ? "bg-white shadow-sm text-gray-900"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Training Plan
        </button>
      </div>

      {/* Content — both rendered server-side, toggled via CSS */}
      <div className={tab === "overview" ? "block" : "hidden"}>{overview}</div>
      <div className={tab === "plan" ? "block" : "hidden"}>{plan}</div>
    </>
  );
}
