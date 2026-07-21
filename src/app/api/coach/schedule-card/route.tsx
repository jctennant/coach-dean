import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { decodeCardPayload, type CardRow, type CardRowType } from "@/lib/schedule-card";

/**
 * Renders the athlete-facing weekly-schedule MMS card as a PNG. Stateless by design: the
 * entire `data` query param is the schedule-card payload (see schedule-card.ts) built once,
 * server-side, from the same skeleton + annotations that produced the text digest bubble —
 * this route only draws it, it never recomputes or re-derives anything from the DB, so the
 * image can't drift from what the athlete was already told in text.
 *
 * Linq fetches this URL synchronously when relaying the MMS, so it must respond fast and
 * never throw — a broken image URL fails the whole attachment (see linq.ts sendMediaSMS).
 */

const TOKENS = {
  surface: "#fcfcfb",
  page: "#f9f9f7",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#898781",
  gridline: "#e1e0d9",
  border: "rgba(11,11,11,0.10)",
  brand: "#005F2E",
  brandTrack: "#dcefe2",
  brandWash: "rgba(0,95,46,0.06)",
  flag: "#a35a00",
  flagTrack: "#f6e6cf",
  flagWash: "rgba(163,90,0,0.07)",
};

// Small, deliberate coach-bubble mark — same asset as the Unified Plan Card gallery,
// inlined so the route has zero external fetches beyond the font.
const BUBBLE_MARK =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="none" stroke="${TOKENS.brand}" stroke-width="7" d="M64 20c-24 0-42 16-42 36 0 12 6 22 16 29l-6 20 22-11c3 .5 6.6.8 10 .8 24 0 42-16 42-36S88 20 64 20z"/><circle cx="46" cy="56" r="6" fill="${TOKENS.brand}"/><circle cx="64" cy="56" r="6" fill="${TOKENS.brand}"/><circle cx="82" cy="56" r="6" fill="${TOKENS.brand}"/></svg>`
  ).toString("base64");

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;

async function loadGoogleFont(weight: 400 | 700): Promise<ArrayBuffer> {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`).then((r) => r.text());
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/);
  if (!match) throw new Error("font resource not found in Google Fonts CSS");
  const res = await fetch(match[1]);
  return res.arrayBuffer();
}

async function getFonts() {
  if (fontCache) return fontCache;
  const [regular, bold] = await Promise.all([loadGoogleFont(400), loadGoogleFont(700)]);
  fontCache = { regular, bold };
  return fontCache;
}

// A handful of hand-drawn, deliberate icon paths — not per-modality photorealism, just
// enough visual distinction to scan quickly. Unlisted types fall back to a plain dot.
const ICON_PATHS: Partial<Record<CardRowType, string>> = {
  strength: "M8 3v10M4 5h8M3 8h10M4 11h8",
  bike: "M4 12l3-6h4l2 3M7 6H5",
  pool_running: "M2 12c1 1 2 1 3 0s2-1 3 0 2 1 3 0 2-1 3 0M2 9c1 1 2 1 3 0s2-1 3 0 2 1 3 0 2-1 3 0",
  swimming: "M2 12c1 1 2 1 3 0s2-1 3 0 2 1 3 0 2-1 3 0M2 9c1 1 2 1 3 0s2-1 3 0 2 1 3 0 2-1 3 0",
  elliptical: "M3 13l3-5 2 2 3-6 2 9",
  probe: "M3 3c2 3 2 6 0 10M8 3c2 3 2 6 0 10M13 3c2 3 2 6 0 10",
  easy: "M4 14l1.5-4.5L4 7l2-2 2 1.5 2.5-1M6 8.5 8 10l1.5 4",
  quality: "M4 14l1.5-4.5L4 7l2-2 2 1.5 2.5-1M6 8.5 8 10l1.5 4",
  long_run: "M4 14l1.5-4.5L4 7l2-2 2 1.5 2.5-1M6 8.5 8 10l1.5 4",
};

function RowIcon({ type }: { type: CardRowType }) {
  if (type === "rest") {
    return (
      <div style={{ width: 26, height: 26, borderRadius: 13, border: `1px dashed ${TOKENS.gridline}`, display: "flex" }} />
    );
  }
  const isFlag = type === "probe";
  const d = ICON_PATHS[type] ?? "M6 6h4M6 6v4";
  return (
    <div
      style={{
        width: 26, height: 26, borderRadius: 13,
        background: isFlag ? TOKENS.flagTrack : TOKENS.brandTrack,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d={d} stroke={isFlag ? TOKENS.flag : TOKENS.brand} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Row({ row }: { row: CardRow }) {
  const isFlag = row.type === "probe";
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 22px", opacity: row.type === "rest" ? 0.55 : 1,
        background: isFlag ? TOKENS.flagWash : "transparent",
        borderBottom: isFlag ? "none" : `1px solid ${TOKENS.gridline}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 40 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: isFlag ? TOKENS.flag : TOKENS.textPrimary }}>{row.day}</span>
        <span style={{ fontSize: 10, color: TOKENS.textMuted }}>{row.date}</span>
      </div>
      <RowIcon type={row.type} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: isFlag ? TOKENS.flag : TOKENS.textPrimary }}>{row.label}</span>
          {row.tag ? (
            <span
              style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 0.3, color: TOKENS.surface,
                background: TOKENS.brand, borderRadius: 4, padding: "1.5px 5px", textTransform: "uppercase" as const,
              }}
            >
              {row.tag}
            </span>
          ) : null}
        </div>
        {row.detail ? <span style={{ fontSize: 11.5, color: TOKENS.textSecondary, marginTop: 1 }}>{row.detail}</span> : null}
      </div>
    </div>
  );
}

export async function GET(req: NextRequest) {
  const encoded = req.nextUrl.searchParams.get("data");
  const payload = encoded ? decodeCardPayload(encoded) : null;

  if (!payload) {
    return new Response("Invalid or missing card data", { status: 400 });
  }

  const width = 560;
  const headerH = 64;
  const rowH = 54; // matches ~2-line row content incl. padding
  const dividerBlockH = payload.watch.length > 0 ? 17 + payload.watch.length * 26 + 20 : 12;
  const height = headerH + payload.rows.length * rowH + dividerBlockH;

  const fonts = await getFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width, height, display: "flex", flexDirection: "column",
          background: TOKENS.surface, fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 22px 12px", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BUBBLE_MARK} width={18} height={18} alt="" />
            <span style={{ fontSize: 12, fontWeight: 700, color: TOKENS.textPrimary }}>Coach Dean</span>
          </div>
          <div
            style={{
              fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: TOKENS.brand,
              background: TOKENS.brandWash, borderRadius: 100, padding: "5px 12px",
            }}
          >
            {payload.weekLabel}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "0 22px", marginBottom: 4 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: TOKENS.textSecondary, textTransform: "uppercase" as const, letterSpacing: 0.4 }}>
            This week
          </span>
          <span style={{ fontSize: 12.5, color: TOKENS.textMuted, fontVariantNumeric: "tabular-nums" as const }}>{payload.countLabel}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {payload.rows.map((row, i) => (
            <Row key={i} row={row} />
          ))}
        </div>

        {payload.watch.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", padding: "14px 22px 20px" }}>
            <div style={{ height: 1, background: TOKENS.gridline, marginBottom: 14 }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: TOKENS.textSecondary, textTransform: "uppercase" as const, letterSpacing: 0.4, marginBottom: 10 }}>
              Watching
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {payload.watch.map((w, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                  <div
                    style={{
                      width: 15, height: 15, borderRadius: 8, marginTop: 1,
                      background: w.flag ? TOKENS.flag : TOKENS.brand,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M1 4L3 6L7 1.5" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <span style={{ fontSize: 13, color: TOKENS.textSecondary, lineHeight: 1.35 }}>{w.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    ),
    {
      width,
      height,
      fonts: [
        { name: "Inter", data: fonts.regular, weight: 400, style: "normal" },
        { name: "Inter", data: fonts.bold, weight: 700, style: "normal" },
      ],
    }
  );
}
