import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client. Uses the service-role key, which bypasses
// Row Level Security (RLS is intentionally disabled on every table anyway —
// see supabase/schema.sql). NEVER import this file from client components or
// any code that could end up in a browser bundle: the service-role key must
// never reach the browser. All existing call sites in this codebase already
// only ever call these functions from server code (API routes / server
// actions), same as the old sheets.ts module.
//
// NOTE for anyone testing scripts against this client from a local sandbox
// whose outbound network only works through an HTTP(S) proxy: do NOT add
// proxy-agent configuration here. This file ships as part of the real app
// (Vercel production, or a developer's normal machine), which has ordinary
// internet access. A hardcoded proxy dependency here would break production.
// If you need that workaround for one-off test scripts, do it in the test
// script itself, never in this shared client.

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL environment variable");
  }
  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}
