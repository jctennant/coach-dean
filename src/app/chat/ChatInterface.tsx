"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Message {
  role: "user" | "assistant";
  content: string;
  created_at?: string;
}

interface ChatInterfaceProps {
  userId: string;
  initialMessages: Message[];
  userName?: string;
  onboardingStep: string | null;
  adminSecret: string;
}

const SYS_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

export default function ChatInterface({ userId, initialMessages, userName, onboardingStep: initialOnboardingStep, adminSecret }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [onboardingStep, setOnboardingStep] = useState<string | null>(initialOnboardingStep);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isOnboarding = onboardingStep !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput("");
    setError("");
    setMessages(prev => [...prev, { role: "user", content: msg }]);
    setLoading(true);

    try {
      let reply: string;
      let nextStep: string | null = onboardingStep;

      if (isOnboarding) {
        const res = await fetch("/api/onboarding/handle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, message: msg, dry_run: true }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        // onboarding/handle returns { ok: true } without the message text —
        // fetch the latest assistant message and updated step from the DB.
        const lastRes = await fetch(`/api/chat/last-message?userId=${userId}`);
        const lastBody = await lastRes.json();
        reply = lastBody.message ?? "(no response)";
        nextStep = lastBody.onboarding_step ?? null;
        setOnboardingStep(nextStep);
      } else {
        const res = await fetch("/api/coach/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, trigger: "user_message", message: msg, dry_run: true }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        reply = body.message ?? "(no response)";
      }

      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function newSession() {
    const res = await fetch("/api/admin/test-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: adminSecret }),
    });
    if (!res.ok) {
      setError("Failed to create test user");
      return;
    }
    const { userId: newId } = await res.json();
    window.location.href = `/chat?userId=${newId}`;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col" style={{ height: "100dvh", fontFamily: SYS_FONT }}>
      {/* Header */}
      <div style={{ background: "#f2f2f7", borderBottom: "1px solid rgba(0,0,0,0.10)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#1a5c35", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 0.4 }}>CD</span>
        </div>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>Coach Dean</p>
          <p style={{ fontSize: 12, color: "#8e8e93", margin: 0, lineHeight: 1.2 }}>
            {userName ? `Chatting as ${userName}` : `userId: ${userId.slice(0, 8)}…`}
            {" · "}{isOnboarding ? `onboarding (${onboardingStep})` : "coaching"}{" · dry_run"}
          </p>
        </div>
        <button
          onClick={newSession}
          style={{ fontSize: 12, color: "#8e8e93", background: "none", border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
        >
          New session
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 0", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <p style={{ color: "#8e8e93", fontSize: 14, textAlign: "center", marginTop: 40 }}>
            No conversation history. Send a message to start.
          </p>
        )}
        {messages.map((m, i) => {
          const isUser = m.role === "user";
          return (
            <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
              <div
                style={{
                  maxWidth: "80%",
                  padding: "10px 14px",
                  borderRadius: 18,
                  fontSize: 15,
                  lineHeight: 1.45,
                  background: isUser ? "#0B84FE" : "#e9e9eb",
                  color: isUser ? "#fff" : "#000",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {m.content}
              </div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "10px 14px", borderRadius: 18, background: "#e9e9eb", display: "flex", gap: 4, alignItems: "center" }}>
              {[0, 1, 2].map(j => (
                <span key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "#8e8e93", display: "inline-block", animation: `bounce 1.2s ease-in-out ${j * 0.2}s infinite` }} />
              ))}
            </div>
          </div>
        )}
        {error && (
          <p style={{ color: "#dc2626", fontSize: 13, textAlign: "center" }}>{error}</p>
        )}
        <div ref={bottomRef} style={{ height: 16 }} />
      </div>

      {/* Input */}
      <div style={{ borderTop: "1px solid rgba(0,0,0,0.10)", padding: "12px 16px", display: "flex", gap: 8, alignItems: "flex-end", background: "#fff" }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Coach Dean..."
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            border: "1px solid #d1d5db",
            borderRadius: 20,
            padding: "10px 14px",
            fontSize: 15,
            lineHeight: 1.4,
            outline: "none",
            fontFamily: SYS_FONT,
            maxHeight: 120,
            overflowY: "auto",
          }}
          disabled={loading}
          autoFocus
        />
        <Button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{ borderRadius: "50%", width: 40, height: 40, padding: 0, flexShrink: 0 }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width={18} height={18}>
            <path d="M2 21L23 12 2 3v7l15 2-15 2v7z" />
          </svg>
        </Button>
      </div>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
