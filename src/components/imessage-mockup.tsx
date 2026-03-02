"use client";

import { useEffect, useRef } from "react";

const MESSAGES = [
  {
    id: 0,
    from: "dean" as const,
    text: "Great run today! 5.2 mi in 42:18 — that's an 8:08/mi pace, right in your easy zone.",
  },
  {
    id: 1,
    from: "user" as const,
    text: "Thanks! My left knee was a little tight around mile 3",
  },
  {
    id: 2,
    from: "dean" as const,
    text: "Good to flag that. Likely just tightness from Tuesday's tempo. Add 5 min of IT band rolling tonight — if it shows up tomorrow we'll swap your long run for a bike day.",
  },
  {
    id: 3,
    from: "user" as const,
    text: "Will do. What's on the schedule tomorrow?",
  },
  {
    id: 4,
    from: "dean" as const,
    text: "Rest day — you've earned it. Wednesday is 4x800m at 7:15 pace. We're building toward that half marathon PR. 💪",
  },
];

const BETWEEN_MS = 1600;
const INITIAL_MS = 500;
const FINAL_PAUSE_MS = 5000;
const FADE_MS = 400;
const CONV_HEIGHT = 420;

const SYS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

export function IMessageMockup({ className }: { className?: string }) {
  // All messages live in the DOM from the start (hidden via CSS class).
  // The animation is pure imperative DOM manipulation — zero React state,
  // zero re-renders, zero layout thrashing.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const wrapper: HTMLDivElement = wrapperRef.current;

    let alive = true;
    let tid: ReturnType<typeof setTimeout>;

    // How far to translateY the wrapper so message[upToIndex] is fully visible
    function getSlideY(upToIndex: number): number {
      let h = 20; // padding-top
      for (let j = 0; j <= upToIndex; j++) {
        if (j > 0) h += 10; // flex gap
        h += msgRefs.current[j]?.offsetHeight ?? 0;
      }
      h += 20; // padding-bottom
      return Math.min(0, CONV_HEIGHT - h);
    }

    // Instantly reset every message back to the hidden CSS-class state
    function resetMessages() {
      msgRefs.current.forEach((el) => {
        if (!el) return;
        el.style.transition = "none";
        el.style.opacity = ""; // clear inline → CSS class opacity:0 takes over
        el.style.transform = ""; // clear inline → CSS class translateY(10px) takes over
      });
      wrapper.style.transition = "none";
      wrapper.style.transform = "translateY(0)";
      // leave wrapper.style.opacity alone — stays "0" from fade-out until rAF fade-in
    }

    function showMessage(index: number, delay: number) {
      tid = setTimeout(() => {
        if (!alive) return;

        const el = msgRefs.current[index];
        if (el) {
          // Animate the message bubble in
          el.style.transition = "opacity 250ms ease-out, transform 250ms ease-out";
          el.style.opacity = "1";
          el.style.transform = "translateY(0)";

          // Slide the wrapper up so this message stays visible
          wrapper.style.transition =
            "transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)";
          wrapper.style.transform = `translateY(${getSlideY(index)}px)`;
        }

        if (index + 1 < MESSAGES.length) {
          showMessage(index + 1, BETWEEN_MS);
        } else {
          // All shown — pause, then fade out, reset, fade back in
          tid = setTimeout(() => {
            if (!alive) return;

            wrapper.style.transition = `opacity ${FADE_MS}ms ease`;
            wrapper.style.opacity = "0";

            tid = setTimeout(() => {
              if (!alive) return;

              resetMessages();

              // Double rAF: first frame flushes "transition:none" state,
              // second frame re-enables opacity so the fade-in animates.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (!alive) return;
                  wrapper.style.transition = `opacity ${FADE_MS}ms ease`;
                  wrapper.style.opacity = "1";
                  showMessage(0, INITIAL_MS);
                });
              });
            }, FADE_MS);
          }, FINAL_PAUSE_MS);
        }
      }, delay);
    }

    showMessage(0, INITIAL_MS);

    return () => {
      alive = false;
      clearTimeout(tid);
    };
  }, []);

  return (
    <div
      className={`select-none ${className ?? ""}`}
      style={{
        width: "min(380px, 100%)",
        minHeight: 520,
        borderRadius: 24,
        background: "#ffffff",
        boxShadow: "0 8px 40px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div
        style={{
          background: "#f2f2f7",
          borderBottom: "1px solid rgba(0,0,0,0.12)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "10px 16px",
          gap: 3,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "#1a5c35",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
              fontSize: 15,
              fontWeight: 600,
              color: "#ffffff",
              letterSpacing: 0.5,
              lineHeight: 1,
            }}
          >
            CD
          </span>
        </div>
        <span
          style={{
            fontFamily: SYS,
            fontSize: 14,
            fontWeight: 600,
            color: "#000000",
            lineHeight: 1.3,
          }}
        >
          Coach Dean
        </span>
      </div>

      {/* ── Conversation — fixed height, overflow hidden ── */}
      <div style={{ height: CONV_HEIGHT, overflow: "hidden" }}>
        {/*
          All messages are always in the DOM. Hidden ones have opacity:0 via
          the .imsg-bubble CSS class. The animation reveals them imperatively,
          bypassing React reconciliation entirely.
        */}
        <div
          ref={wrapperRef}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 20,
            willChange: "transform, opacity",
          }}
        >
          {MESSAGES.map((msg, i) => {
            const isUser = msg.from === "user";
            return (
              <div
                key={msg.id}
                ref={(el) => {
                  msgRefs.current[i] = el;
                }}
                className="imsg-bubble"
                style={{
                  display: "flex",
                  justifyContent: isUser ? "flex-end" : "flex-start",
                  flexShrink: 0,
                  willChange: "transform, opacity",
                }}
              >
                <p
                  style={{
                    maxWidth: "75%",
                    margin: 0,
                    padding: "9px 13px",
                    borderRadius: 18,
                    fontFamily: SYS,
                    fontSize: 15,
                    fontWeight: 400,
                    lineHeight: 1.45,
                    background: isUser ? "#0B84FE" : "#e9e9eb",
                    color: isUser ? "#ffffff" : "#000000",
                    wordBreak: "break-word",
                  }}
                >
                  {msg.text}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
