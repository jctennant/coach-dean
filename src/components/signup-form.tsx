"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import posthog from "posthog-js";

interface SignupFormProps {
  smsPhone?: string;
  centered?: boolean;
}

export function SignupForm({ smsPhone, centered }: SignupFormProps) {
  const basePhone = smsPhone ?? "+18336373002";
  const location = centered ? "bottom" : "hero";

  // Build the SMS URL. If utm_source is present in the page URL, embed it in
  // the SMS body as `src=X` so the linq webhook can attribute the new user
  // to the right acquisition channel without requiring a web-side identity link.
  const [smsUrl, setSmsUrl] = useState(`sms:${basePhone}?body=Hi Coach Dean!`);
  useEffect(() => {
    const src = new URLSearchParams(window.location.search).get("utm_source");
    if (src) {
      // Keep the token compact and alphanumeric-safe for the SMS body
      const safeSrc = src.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
      setSmsUrl(`sms:${basePhone}?body=Hi Coach Dean! src=${safeSrc}`);
    }
  }, [basePhone]);

  function trackCta(device: "mobile" | "desktop") {
    const src = new URLSearchParams(window.location.search).get("utm_source") || undefined;
    posthog.capture("cta_clicked", { location, device, ...(src && { utm_source: src }) });
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      {/* Mobile: full-width deep link button */}
      <a href={smsUrl} className="md:hidden" onClick={() => trackCta("mobile")}>
        <Button size="lg" className="h-12 w-full rounded-full">Get started</Button>
      </a>
      <p className="md:hidden text-center text-sm text-muted-foreground">
        Already a user?{" "}
        <a href="/dashboard" className="underline hover:text-foreground transition-colors">
          View your plan
        </a>
      </p>

      {/* Desktop: button with hover QR code */}
      <div className={`group relative hidden w-fit md:block ${centered ? "mx-auto" : ""}`}>
        <a href={smsUrl} onClick={() => trackCta("desktop")}>
          <Button size="lg" className="h-12 rounded-full px-8">Get started</Button>
        </a>
        {/* QR popover */}
        <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <div className="flex flex-col items-center gap-3 rounded-2xl border bg-white p-4 shadow-xl">
            <QRCodeSVG value={smsUrl} size={128} />
            <p className="text-xs text-muted-foreground">
              On desktop? Text Coach Dean on your phone
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
