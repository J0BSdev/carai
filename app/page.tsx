import { headers } from "next/headers";
import DiagnosticScreen from "@/components/DiagnosticScreen";
import AuthGate from "@/components/workspace/AuthGate";
import { authorizeUsage } from "@/lib/access";
import { supabaseEnv } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export default async function Home() {
  const host = (await headers()).get("host");
  const access = await authorizeUsage(host);
  const configured = supabaseEnv() != null;
  if (!access.ok) {
    return <AuthGate configured={configured} reason={access.reason} />;
  }
  return (
    <DiagnosticScreen
      user={access.user}
      persistenceConfigured={configured}
      role={access.role}
    />
  );
}
