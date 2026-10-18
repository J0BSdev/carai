import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions, supabaseEnv } from "./env";

/**
 * Refreshes the auth cookie. Does not redirect: diagnosis still runs
 * when nobody is signed in or Supabase is not configured.
 */
export async function updateSession(request: NextRequest) {
  const env = supabaseEnv();
  if (!env) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.key, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
        for (const [key, value] of Object.entries(headers)) {
          supabaseResponse.headers.set(key, value);
        }
      },
    },
  });

  try {
    await supabase.auth.getClaims();
  } catch {
    return supabaseResponse;
  }

  return supabaseResponse;
}
