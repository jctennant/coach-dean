"use client";

import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";

interface SignupFormProps {
  smsPhone?: string;
}

export function SignupForm({ smsPhone }: SignupFormProps) {
  const smsUrl = `sms:${smsPhone ?? "+18336373002"}&body=Hi%20Dean!`;

  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      {/* Mobile: full-width deep link button */}
      <a href={smsUrl} className="md:hidden">
        <Button size="lg" className="w-full h-12">Get started</Button>
      </a>

      {/* Desktop: button with hover QR code */}
      <div className="group relative hidden md:inline-block">
        <a href={smsUrl}>
          <Button size="lg" className="h-12 px-8">Get started</Button>
        </a>
        {/* QR popover */}
        <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <div className="flex flex-col items-center gap-3 rounded-2xl border bg-white p-4 shadow-xl">
            <QRCodeSVG value={smsUrl} size={128} />
            <p className="text-xs text-muted-foreground">
              On desktop? Continue on your phone
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
