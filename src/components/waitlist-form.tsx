"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import posthog from "posthog-js";

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const d = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

function toE164(display: string): string {
  const digits = display.replace(/\D/g, "");
  const d = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  return `+1${d}`;
}

interface WaitlistFormProps {
  centered?: boolean;
}

export function WaitlistForm({ centered }: WaitlistFormProps) {
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const e164 = toE164(phone);
    if (!/^\+1\d{10}$/.test(e164)) {
      setError("Please enter a valid US phone number.");
      return;
    }
    setStatus("loading");
    setError("");

    const src = new URLSearchParams(window.location.search).get("utm_source") || undefined;
    posthog.capture("waitlist_submitted", { ...(src && { utm_source: src }) });

    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: e164, source: src }),
    });

    if (res.ok) {
      setStatus("success");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Something went wrong. Try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className={`flex w-full max-w-sm flex-col gap-2 ${centered ? "items-center text-center" : ""}`}>
        <p className="font-medium text-gray-900">You&apos;re on the list.</p>
        <p className="text-sm text-muted-foreground">We&apos;ll text you at {phone} when Coach Dean opens up again.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={`flex w-full max-w-sm flex-col gap-3 ${centered ? "items-center" : ""}`}>
      <input
        type="tel"
        placeholder="(555) 000-0000"
        value={phone}
        onChange={e => setPhone(formatPhone(e.target.value))}
        inputMode="numeric"
        className="h-11 w-full rounded-lg border border-gray-300 bg-white px-4 text-sm outline-none focus:border-gray-500 focus:ring-0"
        autoComplete="tel"
        required
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <Button
        type="submit"
        size="lg"
        className="h-12 w-full rounded-full"
        disabled={status === "loading"}
      >
        {status === "loading" ? "Joining..." : "Join the waitlist"}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        No spam. We&apos;ll text once when you&apos;re in.
      </p>
    </form>
  );
}
