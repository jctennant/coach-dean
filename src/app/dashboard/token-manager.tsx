"use client";

import { useEffect, useState } from "react";
import RequestLinkForm from "./request-link-form";

const STORAGE_KEY = "dean_dashboard_token";

/**
 * Silently persists the dashboard token to localStorage so future visits to
 * /dashboard (without a token in the URL) auto-redirect to the user's plan.
 */
export function TokenPersist({ token }: { token: string }) {
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, token); } catch {}
  }, [token]);
  return null;
}

/**
 * On mount, checks localStorage for a saved token and redirects transparently.
 * Falls back to showing the RequestLinkForm if nothing is saved.
 */
export function LocalTokenRedirect() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        window.location.replace(`/dashboard?token=${saved}`);
        return;
      }
    } catch {}
    setReady(true);
  }, []);

  if (!ready) return null;

  return <RequestLinkForm />;
}
