import type { SessionUser } from "@/lib/supabase/env";
import { getSessionUser } from "@/lib/supabase/session";

export type UsageRole = "admin" | "member" | "local";

export type UsageAccess =
  | { ok: true; role: UsageRole; user: SessionUser | null }
  | { ok: false; reason: "auth" | "subscription" };

const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Supabase Auth user id from the server env. An email never matches. */
function adminUserId(): string | null {
  const raw = process.env.CARAI_ADMIN_USER_ID?.trim().toLowerCase();
  if (!raw || !USER_ID.test(raw)) return null;
  return raw;
}

export function isAdminUserId(userId: string): boolean {
  const adminId = adminUserId();
  return adminId != null && userId.toLowerCase() === adminId;
}

function hostnameOf(hostHeader: string | null): string | null {
  const first = hostHeader?.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    if (end < 0) return null;
    return first.slice(1, end);
  }
  return first.split(":")[0] || null;
}

/** True only for `next dev` on a loopback host. A public Host header is not enough. */
export function isLocalDevelopmentHost(hostHeader: string | null): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const hostname = hostnameOf(hostHeader);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Subscription caps for ordinary accounts. The admin path never calls this. */
function subscriptionAllows(): boolean {
  return true;
}

export async function authorizeUsage(hostHeader: string | null): Promise<UsageAccess> {
  const user = await getSessionUser();
  if (user && isAdminUserId(user.id)) {
    return { ok: true, role: "admin", user };
  }
  if (!user && isLocalDevelopmentHost(hostHeader)) {
    return { ok: true, role: "local", user: null };
  }
  if (!user) return { ok: false, reason: "auth" };
  if (!subscriptionAllows()) {
    return { ok: false, reason: "subscription" };
  }
  return { ok: true, role: "member", user };
}

export function usageDeniedResponse(reason: "auth" | "subscription"): Response {
  if (reason === "auth") {
    return Response.json({ error: "Prijava je potrebna." }, { status: 401 });
  }
  return Response.json(
    { error: "Pretplata ne dopušta korištenje." },
    { status: 403 },
  );
}
