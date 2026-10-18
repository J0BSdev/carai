import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions, supabaseEnv } from "./env";

/** Browser client. Session cookies stay on this origin; RLS is the data boundary. */
export function createClient() {
  const env = supabaseEnv();
  if (!env) return null;
  return createBrowserClient(env.url, env.key, {
    cookieOptions: authCookieOptions(),
  });
}
