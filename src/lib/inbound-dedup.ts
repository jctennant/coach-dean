import { supabase } from "@/lib/supabase";

/**
 * Shared "have we already handled this exact inbound message?" lookup.
 *
 * Three places needed this — both SMS webhooks and `onboarding/handle` — and all three had
 * grown their own copy of the query with subtly different answers to the same question.
 * The dangerous divergence was what counted as evidence of a duplicate: a matching inbound
 * row *alone*. Every path inserts its inbound row before doing the work that produces a
 * reply, so a pass that throws partway through (a 529, a timeout, a non-2xx from the SMS
 * provider) leaves the row behind with nothing sent. Skipping on the row alone turns the
 * re-delivery that would have recovered it into permanent silence — the exact failure the
 * guard exists to prevent. `onboarding/handle` was fixed for this on 2026-08-04; the
 * webhooks were not, until 2026-08-07.
 *
 * So this returns the prior row *and* whether it was ever answered, and leaves the skip
 * decision to the caller — `answered` is the only positive evidence available here, but
 * `onboarding/handle` has a second source (its processing lock) to combine with it.
 */
export interface PriorInboundDelivery {
  id: string;
  createdAt: string;
  /** An assistant message landed after this row — the earlier pass completed. */
  answered: boolean;
}

export interface FindPriorInboundOptions {
  userId: string;
  /** Exact inbound body to match. */
  content: string;
  /** The row the caller stored for *this* delivery — never counts as its own duplicate. */
  excludeConversationId?: string | null;
  /**
   * Caller's own row position, for the concurrent-insert tie-break. When two deliveries of
   * the same body insert near-simultaneously, both see each other; ordering by
   * (created_at, id) makes exactly one of them the "earlier" row, so they can't both decide
   * the other came first. Omit when the caller didn't insert a row of its own.
   */
  before?: { createdAt: string; id: string };
  windowMs?: number;
}

export async function findPriorInboundDelivery({
  userId,
  content,
  excludeConversationId = null,
  before,
  windowMs = 60_000,
}: FindPriorInboundOptions): Promise<PriorInboundDelivery | null> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  let query = supabase
    .from("conversations")
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("role", "user")
    .eq("content", content)
    .gte("created_at", cutoff);
  if (excludeConversationId) query = query.neq("id", excludeConversationId);

  const { data: matches } = await query.order("created_at", { ascending: true }).limit(5);

  const candidates = (matches ?? []).filter((row) => {
    if (!before) return true;
    const rowCreatedAt = row.created_at as string;
    if (rowCreatedAt < before.createdAt) return true;
    if (rowCreatedAt === before.createdAt) return (row.id as string) < before.id;
    return false;
  });

  const prior = candidates[0];
  if (!prior?.created_at) return null;

  const { data: replies } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .gt("created_at", prior.created_at as string)
    .limit(1);

  return {
    id: prior.id as string,
    createdAt: prior.created_at as string,
    answered: !!replies && replies.length > 0,
  };
}
