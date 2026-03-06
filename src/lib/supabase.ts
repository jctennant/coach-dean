import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

let _supabase: SupabaseClient<Database> | null = null;

function getSupabase(): SupabaseClient<Database> {
  if (_supabase) return _supabase;

  if (!process.env.SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  _supabase = createClient<Database>(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return _supabase;
}

// Proxy that lazily initializes on first use
export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_, prop) {
    const client = getSupabase();
    const value = client[prop as keyof SupabaseClient<Database>];
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});
