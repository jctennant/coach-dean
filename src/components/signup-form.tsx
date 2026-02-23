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
        <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-3 -translate-x-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <div className="flex flex-col items-center gap-2 rounded-2xl border bg-white p-4 shadow-xl">
            <QRCodeSVG value={smsUrl} size={140} />
            <p className="whitespace-nowrap text-xs text-muted-foreground">
              Scan to text Coach Dean
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
