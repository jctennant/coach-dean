// Photon (Spectrum) SMS provider — mirrors the linq.ts interface.
// Calls the coach-dean-sidecar service which holds the persistent Spectrum SDK connection.
// Switch between providers by setting SMS_PROVIDER=photon in env.

function getSidecarUrl(): string {
  const url = process.env.PHOTON_SIDECAR_URL;
  if (!url) throw new Error("Missing PHOTON_SIDECAR_URL");
  return url.replace(/\/$/, "");
}

function sidecarHeaders() {
  const secret = process.env.PHOTON_SIDECAR_SECRET;
  return {
    "Content-Type": "application/json",
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
}

async function callSidecar(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${getSidecarUrl()}${path}`, {
    method: "POST",
    headers: sidecarHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sidecar ${path} error: ${res.status} ${text}`);
  }
}

export async function sendSMS(
  to: string,
  body: string
): Promise<{ chatId: string | null }> {
  try {
    await callSidecar("/send", { to, body });
    console.log("[photon] sendSMS ok →", to);
    // Return phone number as chatId so typing indicators keep working through multi-part sends.
    return { chatId: to };
  } catch (err) {
    console.error("[photon] sendSMS error:", err);
    throw err;
  }
}

export async function sendMediaSMS(
  to: string,
  body: string,
  mediaUrl: string,
  mimeType = "image/png"
): Promise<{ chatId: string | null }> {
  try {
    await callSidecar("/send-media", { to, body, mediaUrl, mimeType });
    console.log("[photon] sendMediaSMS ok →", to);
    return { chatId: to };
  } catch (err) {
    console.error("[photon] sendMediaSMS error:", err);
    throw err;
  }
}

export function isPhotonProvider(): boolean {
  return process.env.SMS_PROVIDER === "photon";
}

/**
 * Send a native iMessage poll. Photon/Spectrum-only — no Linq equivalent exists,
 * so callers must gate on isPhotonProvider() before calling this.
 * Requires a Spectrum plan with poll support; throws on lower tiers.
 */
export async function sendPoll(to: string, title: string, options: string[]): Promise<void> {
  await callSidecar("/send-poll", { to, title, options });
  console.log("[photon] sendPoll ok →", to, title);
}

export async function startTyping(phone: string): Promise<void> {
  try {
    await callSidecar("/typing", { to: phone });
  } catch (err) {
    // Typing indicators are best-effort — log but don't throw.
    console.warn("[photon] startTyping error:", err);
  }
}

export function typingDurationMs(messageLength: number): number {
  return Math.min(8000, Math.max(1500, messageLength * 10));
}

// sendMessageWithEffect and shareContactCard are not called from active routes
// but are included for interface parity.

export async function sendMessageWithEffect(
  phone: string,
  body: string,
  effectInput: { type: "screen" | "bubble"; name: string }
): Promise<void> {
  try {
    await callSidecar("/send-effect", {
      to: phone,
      body,
      effectType: effectInput.type,
      effectName: effectInput.name,
    });
  } catch (err) {
    console.error("[photon] sendMessageWithEffect error:", err);
    throw err;
  }
}

export async function shareContactCard(phone: string): Promise<void> {
  try {
    await callSidecar("/share-contact-card", { to: phone });
  } catch (err) {
    console.warn("[photon] shareContactCard error:", err);
  }
}

export async function markRead(_phone: string): Promise<void> {
  // Photon/Spectrum handles read receipts automatically — no explicit API call needed.
}
