"use client";

import { useState } from "react";
import type { ReactNode } from "react";

export function DashboardTabs({
  thisWeek,
  season,
}: {
  thisWeek: ReactNode;
  season: ReactNode;
}) {
  const [tab, setTab] = useState<"this_week" | "season">("this_week");

  return (
    <>
      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1 mb-5">
        <button
          onClick={() => setTab("this_week")}
          className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${
            tab === "this_week"
              ? "bg-white shadow-sm text-gray-900"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          This Week
        </button>
        <button
          onClick={() => setTab("season")}
          className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${
            tab === "season"
              ? "bg-white shadow-sm text-gray-900"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Season
        </button>
      </div>

      {/* Content — both rendered server-side, toggled via CSS */}
      <div className={tab === "this_week" ? "block" : "hidden"}>{thisWeek}</div>
      <div className={tab === "season" ? "block" : "hidden"}>{season}</div>
    </>
  );
}
