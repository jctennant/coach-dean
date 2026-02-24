"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { QRCodeSVG } from "qrcode.react";

export function Navbar({ smsUrl }: { smsUrl: string }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 h-16 bg-background transition-[border-color] duration-200 ${
        scrolled ? "border-b border-black/[0.08]" : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-full max-w-5xl items-center justify-between px-5 md:px-8">
        {/* Wordmark */}
        <a href="/" className="flex items-center">
          <span className="text-[20px] font-semibold tracking-tight text-primary">
            Coach Dean
          </span>
        </a>

        {/* CTA */}
        <div className="group relative w-fit">
          <a href={smsUrl}>
            <Button size="sm" className="h-auto rounded-full px-6 py-3 text-[15px]">
              Get started
            </Button>
          </a>
          <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <div className="flex flex-col items-center gap-3 rounded-2xl border bg-white p-4 shadow-xl">
              <QRCodeSVG value={smsUrl} size={128} />
              <p className="whitespace-nowrap text-xs text-muted-foreground">
                On desktop? Continue on your phone
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
