export type Message = { from: "coach" | "user"; text: string };

interface SmsMockupProps {
  messages: Message[];
  className?: string;
}

export function SmsMockup({ messages, className }: SmsMockupProps) {
  return (
    <div className={`w-full max-w-sm ${className ?? ""}`}>
      {/* Phone frame */}
      <div className="overflow-hidden rounded-3xl border bg-card shadow-xl">
        {/* Status bar */}
        <div className="flex items-center justify-between bg-muted/60 px-5 py-2 text-xs text-muted-foreground">
          <span className="font-medium">Coach Dean</span>
          <span>iMessage</span>
        </div>

        {/* Messages */}
        <div className="flex flex-col gap-2.5 p-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.from === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
