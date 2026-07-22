/**
 * Single insert path for the conversations table.
 *
 * Every conversations insert in the codebase goes through insertConversation()
 * so that failures are logged + sent to Sentry instead of silently swallowed.
 * The DB enforces conversations_message_type_check; VALID_MESSAGE_TYPES below
 * is the code-side mirror, and message_type is typed against it — so using a
 * new type without updating both this list AND the DB constraint fails
 * `npm run typecheck` instead of failing silently in production.
 *
 * Adding a new message_type (both steps required):
 *  1. Add it to VALID_MESSAGE_TYPES below.
 *  2. Add a migration recreating conversations_message_type_check with the new
 *     value (see supabase/migrations/058_* for the pattern), and apply it.
 */
import { supabase } from "@/lib/supabase";
import type { PostgrestError } from "@supabase/supabase-js";

export const VALID_MESSAGE_TYPES = [
  "post_run",
  "initial_plan",
  "initial_plan_link",
  "morning_plan",
  "nightly_reminder",
  "morning_reminder",
  "weekly_recap",
  "user_message",
  "coach_response",
  "onboarding",
  "awaiting_strava",
  "reengagement",
  "reengagement_final",
  "plan_import_week_ask",
  "plan_upload",
  "changelog",
  "dashboard_announcement",
  "welcome_tips",
  "workout_image",
  "symptom_checkin",
  "injury_checkin",
  "v2_migration",
  "awaiting_payment",
  "awaiting_timezone",
] as const;

export type MessageType = (typeof VALID_MESSAGE_TYPES)[number];

export interface ConversationInsertRow {
  user_id: string;
  role: "user" | "assistant";
  content: string;
  message_type: MessageType;
  strava_activity_id?: number | null;
  external_message_id?: string | null;
  created_at?: string | null;
}

function reportInsertError(list: ConversationInsertRow[], error: PostgrestError): void {
  const types = [...new Set(list.map((r) => r.message_type))].join(",");
  console.error(
    JSON.stringify({
      level: "error",
      message: "conversations insert failed",
      ts: new Date().toISOString(),
      user_id: list[0].user_id,
      message_types: types,
      code: error.code,
      error: error.message,
    })
  );
  // Fire-and-forget Sentry capture — never throws (same pattern as logger.ts)
  import("@sentry/nextjs")
    .then(({ captureException }) => {
      captureException(new Error(`conversations insert failed: ${error.message}`), {
        tags: { message_types: types },
        extra: { user_id: list[0].user_id, code: error.code, details: error.details },
      });
    })
    .catch(() => {});
}

/**
 * Insert one or more conversation rows. Never throws — returns the Postgrest
 * error (already logged + captured) so callers that care can branch on it.
 */
export async function insertConversation(
  rows: ConversationInsertRow | ConversationInsertRow[]
): Promise<{ error: PostgrestError | null }> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return { error: null };
  const { error } = await supabase.from("conversations").insert(list);
  if (error) reportInsertError(list, error);
  return { error };
}

/** Same as insertConversation, but returns the inserted row's id + created_at (webhook dedup paths need both — see linq webhook's insert-then-check dedup). */
export async function insertConversationReturningId(
  row: ConversationInsertRow
): Promise<{ id: string | null; created_at: string | null; error: PostgrestError | null }> {
  const { data, error } = await supabase
    .from("conversations")
    .insert(row)
    .select("id, created_at")
    .single();
  if (error) reportInsertError([row], error);
  return { id: data?.id ?? null, created_at: data?.created_at ?? null, error };
}
