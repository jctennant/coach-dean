import Anthropic from "@anthropic-ai/sdk";

let _anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;

  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("Missing ANTHROPIC_API_KEY");

  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// Proxy that lazily initializes on first use
export const anthropic = new Proxy({} as Anthropic, {
  get(_, prop) {
    const client = getAnthropic();
    const value = client[prop as keyof Anthropic];
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});
