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

// ─── Rate-limit retry ─────────────────────────────────────────────────────────
// On the Anthropic free / tier-1 plan a token-per-minute spike returns HTTP 429.
// We disable each SDK's own retries (maxRetries: 0) and centralize retry here so the
// behavior — honoring the server's retry-after, exponential backoff, total-wait budget,
// and logging — is identical across both providers and every call site (coach response,
// Haiku extraction, plan parsing, etc.).
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** Pull a delay (ms) from the error's retry-after / retry-after-ms headers, if present. */
export function parseRetryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return null;
  const get = (key: string): string | null => {
    const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>;
    if (typeof h.get === "function") return h.get(key);
    const v = h[key];
    return typeof v === "string" ? v : null;
  };
  const ms = get("retry-after-ms");
  if (ms && !Number.isNaN(Number(ms))) return Number(ms);
  const ra = get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (!Number.isNaN(secs)) return secs * 1000;
    const at = Date.parse(ra); // HTTP-date form
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry an AI call on rate-limit / transient errors with delayed backoff. */
export async function withRetry<T>(fn: () => Promise<T>, label = "anthropic"): Promise<T> {
  const maxAttempts = Math.max(1, Number(process.env.AI_MAX_RETRIES ?? 5));
  const maxTotalWaitMs = Number(process.env.AI_MAX_RETRY_WAIT_MS ?? 60_000);
  const baseMs = 1_000;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number; statusCode?: number })?.status
        ?? (err as { statusCode?: number })?.statusCode;
      const isLast = attempt >= maxAttempts - 1;
      if (status === undefined || !RETRYABLE_STATUS.has(status) || isLast) throw err;

      const headerMs = parseRetryAfterMs(err);
      const backoff = Math.min(baseMs * 2 ** attempt, 30_000);
      const jitter = Math.floor(Math.random() * 500);
      const delay = (headerMs ?? backoff) + jitter;

      // Don't start a wait that would blow the total budget — fail fast instead.
      if (waited + delay > maxTotalWaitMs) throw err;
      waited += delay;
      console.warn(`[${label}] HTTP ${status} — retry ${attempt + 1}/${maxAttempts - 1} after ${delay}ms (rate limit / transient)`);
      await sleep(delay);
    }
  }
}

// ─── Anthropic (native) ───────────────────────────────────────────────────────

function buildAnthropicClient(): Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AnthropicSDK = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
  let _client: Anthropic | undefined;

  function getClient(): Anthropic {
    if (_client) return _client;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
    // maxRetries: 0 — retries are centralized in withRetry (see above).
    _client = new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 }) as Anthropic;
    return _client;
  }

  // Only messages.create is used across the codebase (non-streaming). Narrow the surface
  // so every call goes through withRetry. Client is still built lazily on first call.
  const create = (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> =>
    withRetry(() => getClient().messages.create(params) as Promise<Anthropic.Message>, "anthropic");

  return { messages: { create } } as unknown as Anthropic;
}

// ─── OpenAI shim ─────────────────────────────────────────────────────────────

// Claude model → OpenAI model
const MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
};

// OpenAI model max output tokens (hard limit — exceeding causes 400)
const MODEL_MAX_TOKENS: Record<string, number> = {
  "gpt-4o": 16384,
  "gpt-4o-mini": 16384,
  "gpt-4o-search-preview": 16384,
};
// gpt-4o-search-preview: used only for onboarding web searches (short prompts).
// The full coaching system prompt is too large for its 6k TPM limit at low tiers.
const SEARCH_MODEL = "gpt-4o-search-preview";

function buildOpenAIClient(): Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const OpenAI = require("openai").OpenAI ?? require("openai").default ?? require("openai");
  let _client: InstanceType<typeof OpenAI> | null = null;

  function getClient() {
    if (_client) return _client;
    if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
    // maxRetries: 0 — retries are centralized in withRetry (see top of file).
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
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
          // pdf-parse is in serverExternalPackages (next.config.ts) so Next.js does NOT bundle
          // it — Node.js resolves it natively at runtime, avoiding internal-path issues.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pdfParse = require("pdf-parse");
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

  /** Convert Anthropic tool definitions to OpenAI tool definitions.
   *  web_search_20250305 → web_search_preview (OpenAI native); other tools → function. */
  function convertTools(tools: Array<Record<string, unknown>>): unknown[] {
    const result: unknown[] = [];
    for (const tool of tools) {
      if ((tool.type as string) === "web_search_20250305") {
        result.push({ type: "web_search_preview" });
      } else {
        result.push({
          type: "function",
          function: {
            name: tool.name as string,
            description: (tool.description as string) ?? "",
            parameters: (tool.input_schema as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            },
          },
        });
      }
    }
    return result;
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
    // gpt-4o-search-preview does web search automatically — no tools array needed
    const nonSearchTools = tools.filter((t) => (t.type as string) !== "web_search_20250305");
    const openAIModel = hasWebSearch ? SEARCH_MODEL : (MODEL_MAP[params.model] ?? "gpt-4o");

    // `system` may be a plain string (most calls) or an Anthropic system-block array
    // (the cached-prefix form: [{type:"text",text,cache_control}, {type:"text",text}]).
    // OpenAI has no equivalent of Anthropic's explicit cache_control — it caches long
    // prompt prefixes automatically — so flatten the blocks into one string and drop the
    // cache_control markers. The static-first ordering still benefits OpenAI auto-caching.
    const rawSystem = params.system as unknown;
    const systemText = Array.isArray(rawSystem)
      ? (rawSystem as Array<{ text?: string }>).map((b) => b?.text ?? "").join("\n\n")
      : (rawSystem as string | undefined);

    const openAIMessages = await convertMessages(
      systemText,
      params.messages as Array<{ role: string; content: string | unknown[] }>
    );

    const modelMaxTokens = MODEL_MAX_TOKENS[openAIModel] ?? 16384;
    const openAIParams: Record<string, unknown> = {
      model: openAIModel,
      max_tokens: Math.min(params.max_tokens ?? 4096, modelMaxTokens),
      messages: openAIMessages,
    };

    const regularTools = convertTools(nonSearchTools);
    if (regularTools.length > 0) {
      openAIParams.tools = regularTools;

      const tc = params.tool_choice as { type: string; name?: string } | undefined;
      if (tc?.type === "tool" && tc.name) {
        openAIParams.tool_choice = { type: "function", function: { name: tc.name } };
      } else if (tc?.type === "auto") {
        openAIParams.tool_choice = "auto";
      } else if (tc?.type === "any") {
        // Anthropic "any" = must call some tool, model picks which. OpenAI's equivalent is "required".
        openAIParams.tool_choice = "required";
      }
    }

    const response = await client.chat.completions.create(openAIParams);
    return convertResponse(response);
  }

  // Cast to Anthropic so all call sites see proper types.
  // Wrap in withRetry so OpenAI 429s get the same delayed-retry treatment.
  return {
    messages: {
      create: (params: Anthropic.MessageCreateParamsNonStreaming) =>
        withRetry(() => messagesCreate(params), "openai"),
    },
  } as unknown as Anthropic;
}

// ─── Export ───────────────────────────────────────────────────────────────────

const provider = process.env.AI_PROVIDER ?? "anthropic";

export const anthropic: Anthropic =
  provider === "anthropic" ? buildAnthropicClient() : buildOpenAIClient();
