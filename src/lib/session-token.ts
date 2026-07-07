import { createHmac } from "crypto";

// Signed using the Supabase service role key — long, secret, already in env.
// If it ever rotates, old session links 404 gracefully.
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dev-secret-do-not-use-in-prod";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function fromB64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

export interface SessionPayload {
  routineKey: string;
  userId: string;
  /** The data portion of the token — used as the unique session key in pt_sessions. */
  sessionKey: string;
}

// Separator is ~ — not in base64url ([A-Za-z0-9_-]) or hex, and safe in URLs.
// Avoids the Next.js static-file bypass that dots trigger in dynamic route segments.
const SEP = "~";

export function signSessionToken(payload: Omit<SessionPayload, "sessionKey">): string {
  // t (unix seconds) makes each generated link unique even for the same user + routine.
  const data = b64url(JSON.stringify({ r: payload.routineKey, u: payload.userId, t: Math.floor(Date.now() / 1000) }));
  const sig = createHmac("sha256", secret()).update(data).digest("hex").slice(0, 32);
  return `${data}${SEP}${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const sepIndex = token.lastIndexOf(SEP);
  if (sepIndex === -1) return null;
  const data = token.slice(0, sepIndex);
  const sig = token.slice(sepIndex + 1);
  const expected = createHmac("sha256", secret()).update(data).digest("hex").slice(0, 32);
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(fromB64url(data));
    if (typeof obj.r !== "string" || typeof obj.u !== "string") return null;
    return { routineKey: obj.r, userId: obj.u, sessionKey: data };
  } catch {
    return null;
  }
}
