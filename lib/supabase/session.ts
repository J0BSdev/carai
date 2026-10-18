import type { SessionUser } from "./env";
import { createClient } from "./server";

/** Verified session from the request cookie. Null keeps the local diagnosis flow. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const supabase = await createClient();
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const id = data.claims.sub;
    if (!id) return null;
    const email = data.claims.email;
    return { id, email: typeof email === "string" ? email : "" };
  } catch {
    return null;
  }
}
