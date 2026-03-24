"use client";

import { useState } from "react";

export default function RequestLinkForm() {
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim()) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/dashboard/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      if (res.ok) {
        setStatus("sent");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-2xl bg-white border border-gray-200 p-6 text-center space-y-2">
        <p className="text-sm font-semibold text-gray-900">Check your texts!</p>
        <p className="text-xs text-gray-500">We sent your plan link to {phone}.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input
        type="tel"
        placeholder="Your phone number"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
        required
      />
      <button
        type="submit"
        disabled={status === "loading"}
        className="w-full rounded-full bg-gray-900 py-3 text-sm font-medium text-white disabled:opacity-50"
      >
        {status === "loading" ? "Sending…" : "Text me my plan link"}
      </button>
      {status === "error" && (
        <p className="text-xs text-red-500 text-center">
          Couldn&apos;t find an account with that number. Make sure you&apos;re using the number you signed up with.
        </p>
      )}
    </form>
  );
}
