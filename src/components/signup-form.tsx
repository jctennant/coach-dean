"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function formatToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

interface SignupFormProps {
  smsPhone?: string;
}

export function SignupForm({ smsPhone }: SignupFormProps) {
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const digits = phone.replace(/\D/g, "");
    if (digits.length === 0) {
      setError("Please enter your phone number.");
      return;
    }

    const e164 = formatToE164(phone);
    if (!e164) {
      setError("Enter a valid 10-digit US phone number.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: e164 }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Something went wrong. Please try again.");
        return;
      }

      setSuccess(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
        <p className="text-lg font-semibold">Check your texts!</p>
        <p className="text-sm text-muted-foreground">
          Dean just sent you a message. Everything happens over SMS from here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      {/* Mobile: deep link only */}
      {smsPhone && (
        <a href={`sms:${smsPhone}&body=Hi%20Dean!`} className="md:hidden">
          <Button size="lg" className="w-full h-12">Get started</Button>
        </a>
      )}
      {/* Desktop: phone number form */}
      <form onSubmit={handleSubmit} className={`flex-col gap-3 ${smsPhone ? "hidden md:flex" : "flex"}`}>
        <div className="flex gap-2">
          <Input
            type="tel"
            placeholder="(555) 123-4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 text-base"
            aria-label="Phone number"
          />
          <Button type="submit" size="lg" className="h-12 shrink-0 px-6" disabled={loading}>
            {loading ? "Sending..." : "Let's go"}
          </Button>
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
