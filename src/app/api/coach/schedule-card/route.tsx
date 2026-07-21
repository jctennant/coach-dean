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
 *
 * Canvas is 1080px wide (rendered at native retina pixel density, not a small canvas the
 * client has to upscale — which is what made the first version look soft) with a content-
 * driven height: a "hero" stat block (the week's big number) plus larger row/type sizing
 * push the card notably more vertical/portrait than the original design without leaving a
 * block of dead blank canvas below a light week's content (a fixed tall canvas was tried
 * first and looked broken on weeks with fewer rows).
 */

const WIDTH = 1080;

const TOKENS = {
  surface: "#fcfcfb",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#898781",
  gridline: "#e1e0d9",
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

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer; extrabold: ArrayBuffer } | null = null;

async function loadGoogleFont(weight: 400 | 700 | 800): Promise<ArrayBuffer> {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`).then((r) => r.text());
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/);
  if (!match) throw new Error("font resource not found in Google Fonts CSS");
  const res = await fetch(match[1]);
  return res.arrayBuffer();
}

async function getFonts() {
  if (fontCache) return fontCache;
  const [regular, bold, extrabold] = await Promise.all([loadGoogleFont(400), loadGoogleFont(700), loadGoogleFont(800)]);
  fontCache = { regular, bold, extrabold };
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
    return <div style={{ width: 76, height: 76, borderRadius: 38, border: `3px dashed ${TOKENS.gridline}`, display: "flex" }} />;
  }
  const isFlag = type === "probe";
  const d = ICON_PATHS[type] ?? "M6 6h4M6 6v4";
  return (
    <div
      style={{
        width: 76, height: 76, borderRadius: 38,
        background: isFlag ? TOKENS.flagTrack : TOKENS.brandTrack,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <svg width="38" height="38" viewBox="0 0 16 16" fill="none">
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
        display: "flex", alignItems: "center", gap: 30,
        padding: "44px 60px", opacity: row.type === "rest" ? 0.5 : 1,
        background: isFlag ? TOKENS.flagWash : "transparent",
        borderBottom: isFlag ? "none" : `2px solid ${TOKENS.gridline}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 118 }}>
        <span style={{ fontSize: 34, fontWeight: 700, color: isFlag ? TOKENS.flag : TOKENS.textPrimary }}>{row.day}</span>
        <span style={{ fontSize: 24, color: TOKENS.textMuted }}>{row.date}</span>
      </div>
      <RowIcon type={row.type} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 38, fontWeight: 600, color: isFlag ? TOKENS.flag : TOKENS.textPrimary }}>{row.label}</span>
          {row.tag ? (
            <span
              style={{
                fontSize: 19, fontWeight: 700, letterSpacing: 0.6, color: TOKENS.surface,
                background: TOKENS.brand, borderRadius: 7, padding: "4px 13px", textTransform: "uppercase" as const,
              }}
            >
              {row.tag}
            </span>
          ) : null}
        </div>
        {row.detail ? <span style={{ fontSize: 27, color: TOKENS.textSecondary, marginTop: 8 }}>{row.detail}</span> : null}
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

  // Split "0 running mi" / "34.0 mi" into a big hero number + unit — same data already in
  // countLabel, just given visual weight so the card reads like a real share card instead
  // of a dense list, and fills more of the canvas on light weeks.
  const heroMatch = payload.countLabel.match(/^([\d.]+)\s*(.*)$/);
  const heroNumber = heroMatch?.[1] ?? payload.countLabel;
  const heroUnit = heroMatch?.[2] ?? "";

  // Content-driven height, not a fixed canvas — a fixed 2280px height left ~1000px of dead
  // blank canvas below a light week's content, which reads as broken, not "fills the screen."
  // These constants mirror the actual padding/line-height budget of each block below. Row
  // size (not canvas size) is what was enlarged to approximate a phone-screen shape: a full
  // 7-day week now runs close to a real portrait phone ratio on its own, without a forced
  // fixed height that leaves dead space on lighter weeks.
  const headerH = 120;
  const heroH = 190;
  const rowH = 168;
  const watchH = payload.watch.length > 0
    ? 44 + 30 + 24 + payload.watch.length * 44 + (payload.watch.length - 1) * 24
    : 0;
  const footerH = 150;
  const height = headerH + heroH + payload.rows.length * rowH + watchH + footerH;

  const fonts = await getFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: WIDTH, height, display: "flex", flexDirection: "column",
          background: TOKENS.surface, fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "56px 60px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={BUBBLE_MARK} width={40} height={40} alt="" />
              <span style={{ fontSize: 28, fontWeight: 700, color: TOKENS.textPrimary }}>Coach Dean</span>
            </div>
            <div
              style={{
                fontSize: 21, fontWeight: 700, letterSpacing: 0.6, color: TOKENS.brand,
                background: TOKENS.brandWash, borderRadius: 100, padding: "10px 24px",
              }}
            >
              {payload.weekLabel}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", padding: "36px 60px 30px" }}>
            <span style={{ fontSize: 22, fontWeight: 600, color: TOKENS.textMuted, textTransform: "uppercase" as const, letterSpacing: 1.2, marginBottom: 6 }}>
              This week
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
              <span style={{ fontSize: 92, fontWeight: 800, color: TOKENS.textPrimary, lineHeight: 1 }}>{heroNumber}</span>
              {heroUnit ? <span style={{ fontSize: 28, fontWeight: 600, color: TOKENS.textSecondary }}>{heroUnit}</span> : null}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            {payload.rows.map((row, i) => (
              <Row key={i} row={row} />
            ))}
          </div>

          {payload.watch.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", padding: "44px 60px 0" }}>
              <span style={{ fontSize: 22, fontWeight: 600, color: TOKENS.textMuted, textTransform: "uppercase" as const, letterSpacing: 1.2, marginBottom: 24 }}>
                Watching
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                {payload.watch.map((w, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
                    <div
                      style={{
                        width: 40, height: 40, borderRadius: 20, marginTop: 2,
                        background: w.flag ? TOKENS.flag : TOKENS.brand,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <svg width="20" height="20" viewBox="0 0 8 8" fill="none">
                        <path d="M1 4L3 6L7 1.5" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span style={{ fontSize: 30, color: TOKENS.textSecondary, lineHeight: 1.4 }}>{w.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 14,
            padding: "48px 60px 72px", borderTop: `2px solid ${TOKENS.gridline}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BUBBLE_MARK} width={26} height={26} alt="" />
          <span style={{ fontSize: 24, color: TOKENS.textMuted }}>Text your coach anytime</span>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height,
      fonts: [
        { name: "Inter", data: fonts.regular, weight: 400, style: "normal" },
        { name: "Inter", data: fonts.bold, weight: 700, style: "normal" },
        { name: "Inter", data: fonts.extrabold, weight: 800, style: "normal" },
      ],
    }
  );
}
