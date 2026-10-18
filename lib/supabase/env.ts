export type SessionUser = {
  id: string;
  email: string;
};

/** Persistent auth cookie. Same options on the browser, server, and proxy. */
export function authCookieOptions() {
  return {
    path: "/",
    sameSite: "lax" as const,
    maxAge: 400 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Public project URL and publishable key. Never a service-role key. */
export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  if (!url || !key) return null;
  return { url, key };
}
