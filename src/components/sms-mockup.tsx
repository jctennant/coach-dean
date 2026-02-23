export type Message = { from: "coach" | "user"; text: string };

interface SmsMockupProps {
  messages: Message[];
  className?: string;
}

export function SmsMockup({ messages, className }: SmsMockupProps) {
  return (
    <div className={`w-full max-w-sm ${className ?? ""}`}>
      <div className="rounded-2xl bg-white border border-black/[0.07] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.10)]">
        {/* Minimal brand header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <div className="h-8 w-8 shrink-0 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold">
            D
          </div>
          <span className="text-sm font-semibold text-gray-900 tracking-tight">Coach Dean</span>
        </div>

        {/* Thread */}
        <div className="flex flex-col gap-2.5 px-5 pb-5">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[84%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.from === "user"
                    ? "bg-[#007aff] text-white"
                    : "bg-[#f1f1f4] text-gray-900"
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
