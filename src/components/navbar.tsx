"use client";

import { useEffect, useState } from "react";

export function Navbar() {
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
        <a href="/" className="flex items-center gap-2">
          <img src="/heavy_logo.svg" alt="Coach Dean" height={40} style={{ height: 40 }} />
        </a>

        {/* CTA */}
        <div className="flex items-center gap-4">
          <a href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Sign in
          </a>
        </div>
      </div>
    </header>
  );
}
