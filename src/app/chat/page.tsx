import { redirect } from "next/navigation";
import { supabase } from "@/lib/supabase";
import ChatInterface from "./ChatInterface";

interface Props {
  searchParams: Promise<{ userId?: string }>;
}

export default async function ChatPage({ searchParams }: Props) {
  const { userId } = await searchParams;

  if (!userId) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", fontFamily: "system-ui", flexDirection: "column", gap: 12 }}>
        <p style={{ fontWeight: 600, fontSize: 18 }}>Dev Chat</p>
        <p style={{ color: "#666", fontSize: 14 }}>Add <code style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>?userId=&lt;uuid&gt;</code> to the URL</p>
      </div>
    );
  }

  const [{ data: user }, { data: conversations }] = await Promise.all([
    supabase.from("users").select("name").eq("id", userId).single(),
    supabase
      .from("conversations")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .in("message_type", ["user_message", "coach_response"])
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  if (!user) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", fontFamily: "system-ui" }}>
        <p style={{ color: "#dc2626" }}>User not found: {userId}</p>
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
    />
  );
}
