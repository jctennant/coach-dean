import { supabase } from "@/lib/supabase";
import ChatInterface from "./ChatInterface";
import NewSessionButton from "./NewSessionButton";

interface Props {
  searchParams: Promise<{ userId?: string }>;
}

export default async function ChatPage({ searchParams }: Props) {
  const { userId } = await searchParams;
  const adminSecret = process.env.ADMIN_SECRET ?? "";

  if (!userId) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", fontFamily: "system-ui", flexDirection: "column", gap: 16 }}>
        <p style={{ fontWeight: 600, fontSize: 18, margin: 0 }}>Dev Chat</p>
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          Add <code style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>?userId=&lt;uuid&gt;</code> or start a new test session.
        </p>
        <NewSessionButton adminSecret={adminSecret} />
      </div>
    );
  }

  const [{ data: user }, { data: conversations }] = await Promise.all([
    supabase.from("users").select("name, onboarding_step").eq("id", userId).single(),
    supabase
      .from("conversations")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .in("message_type", ["user_message", "coach_response", "onboarding"])
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  if (!user) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", fontFamily: "system-ui", flexDirection: "column", gap: 16 }}>
        <p style={{ color: "#dc2626", margin: 0 }}>User not found: {userId}</p>
        <NewSessionButton adminSecret={adminSecret} />
      </div>
    );
  }

  const messages = (conversations ?? []).map(c => ({
    role: c.role as "user" | "assistant",
    content: c.content as string,
    created_at: c.created_at as string,
  }));

  return (
    <ChatInterface
      userId={userId}
      initialMessages={messages}
      userName={user.name as string | undefined}
      onboardingStep={(user.onboarding_step as string | null) ?? null}
      adminSecret={adminSecret}
    />
  );
}
