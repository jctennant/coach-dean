"use client";

export default function NewSessionButton({ adminSecret }: { adminSecret: string }) {
  async function handleClick() {
    const res = await fetch("/api/admin/test-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: adminSecret }),
    });
    if (!res.ok) {
      alert("Failed to create test user — check ADMIN_SECRET env var.");
      return;
    }
    const { userId } = await res.json();
    window.location.href = `/chat?userId=${userId}`;
  }

  return (
    <button
      onClick={handleClick}
      style={{
        padding: "10px 20px",
        borderRadius: 8,
        background: "#1a5c35",
        color: "#fff",
        border: "none",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      New test session
    </button>
  );
}
