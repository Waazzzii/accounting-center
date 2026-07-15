/**
 * supabase.ts — typed Supabase clients.
 *
 * Two clients:
 *   - serviceClient: service-role key. Used by server-side agents. Bypasses RLS.
 *   - anonClient:    anon key. Used by the dashboard UI (subject to RLS).
 *
 * Both are lazy-instantiated so importing this module is cheap.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let _service: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (!_service) {
    _service = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "public" },
      global: { headers: { "x-client-info": "accounting-center-server" } },
    });
  }
  return _service;
}

export function anonClient(): SupabaseClient {
  if (!_anon) {
    _anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "public" },
      global: { headers: { "x-client-info": "accounting-center-ui" } },
    });
  }
  return _anon;
}

/**
 * Run a function inside a logical "actor" context. This doesn't set
 * a Postgres session variable yet — phase 2 adds that via pg RLS. For now
 * it's a convenience marker for audit-log inserts.
 */
export interface ActorContext {
  actor_type: "ai_agent" | "human" | "system" | "external" | "webhook";
  actor_id: string;
  actor_display?: string;
}

let _currentActor: ActorContext | null = null;

export function withActor<T>(actor: ActorContext, fn: () => Promise<T>): Promise<T> {
  const previous = _currentActor;
  _currentActor = actor;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      _currentActor = previous;
    });
}

export function currentActor(): ActorContext | null {
  return _currentActor;
}
