/**
 * AI client — provider-switchable via AI_PROVIDER env var.
 *
 * AI_PROVIDER=openai    (current default) — wraps OpenAI behind the Anthropic
 *                        messages.create() interface so no call-site code changes.
 * AI_PROVIDER=anthropic — uses @anthropic-ai/sdk directly (original path).
 *
 * To switch back to Anthropic: set AI_PROVIDER=anthropic and ensure
 * ANTHROPIC_API_KEY is set. No other code changes needed.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ─── Anthropic (native) ───────────────────────────────────────────────────────

function buildAnthropicClient(): Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AnthropicSDK = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
  let _client: Anthropic | undefined;

  function getClient(): Anthropic {
    if (_client) return _client;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
    _client = new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY }) as Anthropic;
    return _client;
  }

  return new Proxy({} as Anthropic, {
    get(_, prop) {
      const client = getClient();
      const value = client[prop as keyof Anthropic];
      if (typeof value === "function") return value.bind(client);
      return value;
    },
  });
}

// ─── OpenAI shim ─────────────────────────────────────────────────────────────

// Claude model → OpenAI model
const MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
};
// gpt-4o-search-preview has a very low TPM limit (6k) at low OpenAI tiers — not enough
// for the coaching system prompt. Fall back to gpt-4o (no live web search, but won't crash).
// TODO: replace with a proper Tavily/Serper function-tool once on a higher tier.
const SEARCH_MODEL = "gpt-4o";

function buildOpenAIClient(): Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const OpenAI = require("openai").OpenAI ?? require("openai").default ?? require("openai");
  let _client: InstanceType<typeof OpenAI> | null = null;

  function getClient() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
  }

  /** Convert a single Anthropic content block to an OpenAI content part. */
  async function convertBlock(block: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const type = block.type as string;

    if (type === "text") {
      return { type: "text", text: block.text as string };
    }

    if (type === "image") {
      const src = block.source as { media_type: string; data: string };
      return {
        type: "image_url",
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      };
    }

    if (type === "document") {
      const src = block.source as { media_type: string; data: string };
      if (src.media_type === "application/pdf") {
        try {
          // Use the core function directly to avoid pdf-parse's test-file initialization
          // which fails in bundled environments (Vercel) because the test PDF paths don't exist.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pdfParse = require("pdf-parse/lib/pdf-parse.js");
          const buffer = Buffer.from(src.data, "base64");
          const parsed = await pdfParse(buffer) as { text: string; numpages: number };
          const text = parsed.text?.trim() ?? "";
          console.log(`[anthropic-shim] pdf-parse: ${parsed.numpages} pages, ${text.length} chars extracted`);
          if (!text) throw new Error("pdf-parse returned empty text — PDF may be image-based or encrypted");
          return { type: "text", text: `[PDF content]\n${text}` };
        } catch (err) {
          console.error("[anthropic-shim] pdf-parse failed:", err);
          throw err; // propagate so plan/upload returns a proper error to the user
        }
      }
      return { type: "text", text: `[Document: ${src.media_type}]` };
    }

    return null; // unknown block — skip
  }

  /** Convert Anthropic-style messages + optional system prompt to OpenAI messages. */
  async function convertMessages(
    system: string | undefined,
    messages: Array<{ role: string; content: string | unknown[] }>
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    if (system) result.push({ role: "system", content: system });

    for (const msg of messages) {
      const role = msg.role as "user" | "assistant";
      if (typeof msg.content === "string") {
        result.push({ role, content: msg.content });
      } else {
        const parts: unknown[] = [];
        for (const raw of msg.content as Record<string, unknown>[]) {
          const part = await convertBlock(raw);
          if (part) parts.push(part);
        }
        result.push({ role, content: parts });
      }
    }

    return result;
  }

  /** Convert Anthropic tool definitions to OpenAI function definitions (skip web_search). */
  function convertTools(tools: Array<Record<string, unknown>>): unknown[] {
    return tools
      .filter((t) => t.type !== "web_search_20250305")
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name as string,
          description: (tool.description as string) ?? "",
          parameters: (tool.input_schema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
        },
      }));
  }

  /** Convert OpenAI ChatCompletion to Anthropic-shaped response. */
  function convertResponse(response: Record<string, unknown>): Anthropic.Message {
    type OAIChoice = {
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    };
    const choices = response.choices as OAIChoice[];
    const message = choices?.[0]?.message;

    const content: Anthropic.ContentBlock[] = [];

    if (message?.content) {
      content.push({ type: "text", text: message.content } as Anthropic.TextBlock);
    }

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        } as Anthropic.ToolUseBlock);
      }
    }

    // Return a minimal Anthropic.Message-shaped object (call sites only access .content)
    return { content } as unknown as Anthropic.Message;
  }

  /** Main entry point — mirrors anthropic.messages.create() signature. */
  async function messagesCreate(
    params: Anthropic.MessageCreateParamsNonStreaming
  ): Promise<Anthropic.Message> {
    const client = getClient() as {
      chat: { completions: { create: (p: Record<string, unknown>) => Promise<Record<string, unknown>> } };
    };

    const tools = (params.tools as Array<Record<string, unknown>> | undefined) ?? [];
    const hasWebSearch = tools.some((t) => (t.type as string) === "web_search_20250305");
    const openAIModel = hasWebSearch
      ? SEARCH_MODEL
      : (MODEL_MAP[params.model] ?? "gpt-4o");

    const openAIMessages = await convertMessages(
      params.system as string | undefined,
      params.messages as Array<{ role: string; content: string | unknown[] }>
    );

    const openAIParams: Record<string, unknown> = {
      model: openAIModel,
      max_tokens: params.max_tokens,
      messages: openAIMessages,
    };

    const regularTools = convertTools(tools);
    if (regularTools.length > 0) {
      openAIParams.tools = regularTools;

      const tc = params.tool_choice as { type: string; name?: string } | undefined;
      if (tc?.type === "tool" && tc.name) {
        openAIParams.tool_choice = { type: "function", function: { name: tc.name } };
      } else if (tc?.type === "auto") {
        openAIParams.tool_choice = "auto";
      }
    }

    const response = await client.chat.completions.create(openAIParams);
    return convertResponse(response);
  }

  // Cast to Anthropic so all call sites see proper types
  return { messages: { create: messagesCreate } } as unknown as Anthropic;
}

// ─── Export ───────────────────────────────────────────────────────────────────

const provider = process.env.AI_PROVIDER ?? "openai";

export const anthropic: Anthropic =
  provider === "anthropic" ? buildAnthropicClient() : buildOpenAIClient();
