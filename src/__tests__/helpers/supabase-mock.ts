import { vi } from "vitest";

/**
 * Build a chainable Supabase query mock.
 * Each call in a chain returns the same mock object so .from().select().eq().single()
 * works without needing to configure every intermediate step.
 *
 * Set `resolveWith` to control what .single() / .maybeSingle() / the chain itself resolves to.
 */
export function createChain(resolveWith: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};

  const terminal = vi.fn().mockResolvedValue(resolveWith);

  const methods = [
    "from", "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "is", "not", "gte", "lte", "lt", "gt",
    "in", "or", "order", "limit",
  ];

  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }

  chain["single"] = terminal;
  chain["maybeSingle"] = terminal;

  return chain as ReturnType<typeof buildMockSupabase>["from"] extends infer F ? F : never;
}

/**
 * Build a mock Supabase client where each table operation can return different data.
 *
 * Usage:
 *   const mock = buildMockSupabase({ users: { data: { id: "123" }, error: null } });
 *   vi.mocked(supabase.from).mockImplementation(mock.from);
 */
export function buildMockSupabase(
  tableResponses: Record<string, { data: unknown; error: unknown }> = {}
) {
  const defaultResponse = { data: null, error: null };

  const fromFn = vi.fn().mockImplementation((table: string) => {
    const response = tableResponses[table] ?? defaultResponse;
    return createChain(response);
  });

  return { from: fromFn };
}

/**
 * Create a minimal mock Request object for testing Next.js App Router handlers.
 */
export function mockRequest(
  body: unknown,
  options: { method?: string; headers?: Record<string, string> } = {}
): Request {
  return {
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: {
      get: (key: string) => options.headers?.[key] ?? null,
    },
    method: options.method ?? "POST",
    url: "http://localhost:3000/api/test",
  } as unknown as Request;
}

/** Parse the JSON body from a mocked NextResponse.json() return value. */
export function getResponseBody(response: { data: unknown }) {
  return response.data;
}
